/**
 * dart-flutter.ts — stack validator for Dart/Flutter projects.
 *
 * Applies ONLY to projects with a pubspec.yaml. Checks things that are Dart/Flutter
 * specific and don't translate to other stacks (e.g. dead-code detection would be
 * a false-positive generator for Java Spring, Python FastAPI, etc.)
 *
 * Checks implemented:
 *   - DART_DEAD_ON_ARRIVAL: new .dart file that is not imported anywhere in the project
 *   - DART_CLASS_COLLISION: same class/enum declared in multiple files with different signatures
 *   - DART_WIDGET_IMPORTS_MODEL: widget/screen/page file imports directly from models/ (Clean Arch violation)
 *   - DART_FORCE_UNWRAP_ABUSE: file has excessive `!.` force-unwraps (null-safety smell)
 *   - DART_MEGA_FILE: contracts/dto/entity file > 800 lines (monolith)
 *   - DART_MULTI_CLASS_FILE: file with > 3 top-level public classes (god file)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { StackValidator, ValidatorContext, ValidationWarning } from './types';

const FORCE_UNWRAP_THRESHOLD = 10; // warn if a file has more than this many `!.`
const MEGA_FILE_LINE_THRESHOLD = 800;
const MULTI_CLASS_THRESHOLD = 3; // enum + extension = 2 types = OK. 4+ types = suspicious bundling

/** Find the Dart/Flutter root inside the repo (pubspec.yaml location). */
function findFlutterRoot(cwd: string): string | null {
  // Most common layouts: <repo>/pubspec.yaml, <repo>/app/pubspec.yaml, <repo>/mobile/pubspec.yaml
  const candidates = [cwd, path.join(cwd, 'app'), path.join(cwd, 'mobile'), path.join(cwd, 'flutter')];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'pubspec.yaml'))) return c;
  }
  return null;
}

function readFileSafe(abs: string): string | null {
  try { return fs.readFileSync(abs, 'utf8'); } catch { return null; }
}

/** Count force-unwraps: `!.` or `!;` (careful not to match `!=`, `!!`, `! `) */
function countForceUnwraps(content: string): number {
  const matches = content.match(/!(?=\.(?:[a-zA-Z_]|toJson|toIso|toString|runtimeType))/g);
  return matches ? matches.length : 0;
}

/** Extract top-level public class/enum/mixin declarations from Dart source */
function extractTopLevelSymbols(content: string): string[] {
  const re = /^\s*(?:abstract\s+)?(?:class|enum|mixin|extension)\s+([A-Z][A-Za-z0-9_]*)/gm;
  const symbols: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    symbols.push(m[1]);
  }
  return symbols;
}

/** Check if a file is imported anywhere else in the repo via basename */
function isImportedAnywhere(flutterRoot: string, relFile: string): boolean {
  const basename = path.basename(relFile);
  try {
    // Use rg/grep to find any import line referencing this file
    const cmd = `grep -rln --include='*.dart' -E "import\\s+['\\\"](package:[^'\\\"]*/${basename}|[^'\\\"]*${basename})['\\\"]" "${flutterRoot}/lib" 2>/dev/null || true`;
    const out = execSync(cmd, { timeout: 10_000, shell: '/bin/sh' }).toString();
    const importers = out.split('\n').filter(l => l.trim() && !l.endsWith(relFile));
    return importers.length > 0;
  } catch {
    return true; // grep failure → assume imported to avoid false positives
  }
}

export const DartFlutterValidator: StackValidator = {
  name: 'dart-flutter',
  label: 'Dart / Flutter',

  detect(cwd: string): boolean {
    return findFlutterRoot(cwd) !== null;
  },

  async validate(ctx: ValidatorContext): Promise<ValidationWarning[]> {
    const warnings: ValidationWarning[] = [];
    const flutterRoot = findFlutterRoot(ctx.cwd);
    if (!flutterRoot) return warnings;

    // Only validate Dart files that live under the flutter root
    const relFlutterRoot = path.relative(ctx.cwd, flutterRoot);
    const dartFiles = ctx.changedFiles.filter(f =>
      f.endsWith('.dart') && (relFlutterRoot === '' || f.startsWith(relFlutterRoot + '/') || f.startsWith(relFlutterRoot)),
    );
    if (dartFiles.length === 0) return warnings;

    // Track class/enum signatures across all changed files to detect collisions
    const symbolToFile = new Map<string, string>();

    for (const relFile of dartFiles) {
      const abs = path.join(ctx.cwd, relFile);
      const content = readFileSafe(abs);
      if (!content) continue;
      const lineCount = content.split('\n').length;

      // ── Check 1: Widget importing models directly ─────────
      const isWidgetFile = /\/(screens|widgets|pages|views)\//.test(relFile);
      if (isWidgetFile) {
        const badImport = /import\s+['"][^'"]*\/models\/[^'"]+['"]/.exec(content);
        if (badImport) {
          warnings.push({
            code: 'DART_WIDGET_IMPORTS_MODEL',
            severity: 'medium',
            message: `Widget/screen imports models/ directly — violates Clean Architecture (use a Provider/service instead)`,
            file: relFile,
            evidence: badImport[0],
          });
        }
      }

      // ── Check 2: Force-unwrap abuse ──────────────────────
      const unwraps = countForceUnwraps(content);
      if (unwraps > FORCE_UNWRAP_THRESHOLD) {
        warnings.push({
          code: 'DART_FORCE_UNWRAP_ABUSE',
          severity: 'medium',
          message: `File has ${unwraps} force-unwraps (!.) — likely null-safety smell. Use '?.' or null-coalescing.`,
          file: relFile,
        });
      }

      // ── Check 3: Mega-file (contracts/dto/entity > 800 lines) ─
      const isContractLike = /(contracts|dtos?|entities|interfaces|types|models)/i.test(relFile);
      if (isContractLike && lineCount > MEGA_FILE_LINE_THRESHOLD) {
        warnings.push({
          code: 'DART_MEGA_FILE',
          severity: 'critical',
          message: `File has ${lineCount} lines — multiple concepts bundled. Clean Architecture demands one concept per file. SPLIT REQUIRED.`,
          file: relFile,
        });
      }

      // ── Check 4: Multi-class file (> 3 top-level classes) ─
      const symbols = extractTopLevelSymbols(content);
      if (symbols.length > MULTI_CLASS_THRESHOLD && isContractLike) {
        warnings.push({
          code: 'DART_MULTI_CLASS_FILE',
          severity: 'high',
          message: `File declares ${symbols.length} top-level types (${symbols.slice(0, 5).join(', ')}${symbols.length > 5 ? '...' : ''}) — consider splitting into separate files.`,
          file: relFile,
        });
      }

      // Track symbols for collision detection
      for (const sym of symbols) {
        const prev = symbolToFile.get(sym);
        if (prev && prev !== relFile) {
          warnings.push({
            code: 'DART_CLASS_COLLISION',
            severity: 'high',
            message: `Symbol "${sym}" declared in both "${prev}" and "${relFile}" — pick ONE canonical location.`,
            file: relFile,
            evidence: `Also declared in: ${prev}`,
          });
        } else {
          symbolToFile.set(sym, relFile);
        }
      }

      // ── Check 5: Dead on arrival ─────────────────────────
      // Only run if this file is a "reusable" type (contracts, dtos, enums, entities)
      // Skip entry points (main.dart, app.dart) and widget files (they're top of tree)
      const isEntryPoint = /\/(main|app)\.dart$/.test(relFile);
      const isReusable = /(contracts|dtos?|entities|enums|events|models|services|providers|repositories)/i.test(relFile);
      if (!isEntryPoint && isReusable) {
        const imported = isImportedAnywhere(flutterRoot, relFile);
        if (!imported) {
          warnings.push({
            code: 'DART_DEAD_ON_ARRIVAL',
            severity: 'medium',
            message: `File is not imported anywhere — dead code. Likely disconnected from the rest of the app.`,
            file: relFile,
          });
        }
      }
    }

    return warnings;
  },
};
