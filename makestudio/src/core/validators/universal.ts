import { swallow } from '../../utils/log';
/**
 * universal.ts — stack-agnostic validator.
 *
 * Runs on every project regardless of language. Checks things that are
 * universally wrong:
 *   - Files declared in techContext but not created (MISSING)
 *   - Files created at paths different from the ones declared (PATH_DEVIATION)
 *   - Catch-all monolith naming patterns ("all_*", "<projectname>_*", "_bundle*") (MONOLITH_NAMING)
 *   - One file created when multiple were declared (CONSOLIDATION)
 */

import * as fs from 'fs';
import * as path from 'path';
import { StackValidator, ValidatorContext, ValidationWarning } from './types';

const TS_MULTI_CLASS_THRESHOLD = 3; // 4+ exported types in a bundled filename = monolith

/** Extract top-level exported class/interface/type/enum names from TypeScript source */
function extractTsTopLevelSymbols(content: string): string[] {
  const re = /^export\s+(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Z][A-Za-z0-9_]*)/gm;
  const symbols: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    symbols.push(m[1]);
  }
  return symbols;
}

/**
 * Detect the project name from package.json / pubspec.yaml / directory name.
 * Used to flag catch-all files like "<projectname>_dtos.dart".
 */
function detectProjectName(cwd: string): string | null {
  try {
    // Try api/package.json or backend/package.json or root
    for (const sub of ['api', 'backend', '.']) {
      const pkg = path.join(cwd, sub, 'package.json');
      if (fs.existsSync(pkg)) {
        const data = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        if (data.name) return data.name.replace(/^@[^/]+\//, '').toLowerCase();
      }
    }
    // Try pubspec.yaml
    for (const sub of ['app', 'mobile', '.']) {
      const pub = path.join(cwd, sub, 'pubspec.yaml');
      if (fs.existsSync(pub)) {
        const m = fs.readFileSync(pub, 'utf8').match(/^name:\s*(\S+)/m);
        if (m) return m[1].toLowerCase();
      }
    }
    // Fallback: directory name
    return path.basename(cwd).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Heuristic: does the filename suggest a bundled file?
 * Used both for MULTI_CLASS_TS detection AND to skip MISSING_FILE validation
 * (executor was told to split bundled files into individual ones).
 */
function isBundledFilename(file: string): boolean {
  const base = path.basename(file);

  // TypeScript bundled patterns
  if (base.endsWith('.ts') || base.endsWith('.tsx')) {
    // "<project>.dto.ts", "<project>.enums.ts", "<project>.events.ts"
    if (/^[a-z][a-z0-9_-]*\.(dto|entity|model|event|enum|interface|type)s?\.ts$/.test(base)
      && !base.startsWith('create-') && !base.startsWith('update-') && !base.startsWith('delete-')) {
      return true;
    }
    // "_dtos.ts", "_entities.ts"
    if (/_(dtos|entities|models|types|events|interfaces|enums)\.(ts|tsx)$/.test(base)) return true;
    // ".dtos.ts", ".entities.ts"
    if (/\.(dtos|entities|models|types|enums)\.(ts|tsx)$/.test(base)) return true;
  }

  // Dart bundled patterns
  if (base.endsWith('.dart')) {
    // "dtos.dart", "enums.dart", "events.dart", "contracts.dart"
    if (/^(dtos|enums|events|models|entities|types|contracts|interfaces)\.dart$/.test(base)) return true;
    // "<project>_dtos.dart", "<project>_enums.dart"
    if (/^[a-z][a-z0-9_-]*_(dtos|enums|events|models|entities|types|contracts)\.dart$/.test(base)) return true;
  }

  return false;
}

/** Extract file paths from free-text techContext like "api/src/foo.ts, app/lib/bar.dart" */
export function parseDeclaredPaths(techContext: string): string[] {
  if (!techContext) return [];
  const paths = new Set<string>();
  const re = /([a-zA-Z][a-zA-Z0-9_\-]*(?:\/[a-zA-Z0-9_\-\.]+)+\.(?:ts|tsx|dart|js|jsx|py|sql|json|yaml|yml|md|env|prisma|java|kt|go|rs|rb|php|cs))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(techContext)) !== null) {
    paths.add(m[1].trim());
  }
  return Array.from(paths);
}

export const UniversalValidator: StackValidator = {
  name: 'universal',
  label: 'Universal (cross-stack)',

  detect(_cwd: string): boolean {
    // Universal validator always applies
    return true;
  },

  async validate(ctx: ValidatorContext): Promise<ValidationWarning[]> {
    const warnings: ValidationWarning[] = [];
    const { task, changedFiles, cwd } = ctx;

    if (!task) return warnings;
    const declaredPaths = parseDeclaredPaths(task.techContext || task.metadata?.techContext || '');
    if (declaredPaths.length === 0) return warnings;

    const actualSet = new Set(changedFiles);
    const declaredSet = new Set(declaredPaths);

    // MISSING — declared but not created
    // Skip bundled filenames: the executor was told to split them into individual files,
    // so the original bundled path (e.g. "<project>.dto.ts") won't exist — that's correct.
    for (const m of declaredPaths) {
      if (isBundledFilename(m)) continue;
      const normalized = m.replace(/^\.\//, '');
      if (!actualSet.has(m) && !actualSet.has(normalized)) {
        warnings.push({
          code: 'UNIVERSAL_MISSING_FILE',
          severity: 'high',
          message: `Declared in techContext but not created: ${m}`,
          file: m,
        });
      }
    }

    // PATH_DEVIATION — created with same basename but different dir
    const declaredBasenames = new Map(declaredPaths.map(p => [path.basename(p), p]));
    for (const f of changedFiles) {
      if (declaredSet.has(f)) continue;
      const base = path.basename(f);
      const matched = declaredBasenames.get(base);
      if (matched) {
        warnings.push({
          code: 'UNIVERSAL_PATH_DEVIATION',
          severity: 'high',
          message: `Declared "${matched}" but created at "${f}"`,
          file: f,
          evidence: `Expected: ${matched}`,
        });
      } else {
        const projectName = detectProjectName(cwd);
        const monolithPatterns: RegExp[] = [/(^|\/)(all_|_all\.)/i];
        if (projectName) {
          // Match "<projectname>_dtos.dart", "<projectname>_all.ts", etc.
          const escaped = projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          monolithPatterns.push(new RegExp(`(^|\\/)${escaped}_`, 'i'));
        }
        if (monolithPatterns.some((re) => re.test(f))) {
          warnings.push({
            code: 'UNIVERSAL_MONOLITH_NAMING',
            severity: 'critical',
            message: `Suspect catch-all file "${f}" (not in declared paths)`,
            file: f,
          });
        }
      }
    }

    // UNIVERSAL_MULTI_CLASS_TS — TypeScript file with multiple exported classes
    const tsFiles = changedFiles.filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));
    for (const f of tsFiles) {
      if (isBundledFilename(f)) {
        const abs = path.join(cwd, f);
        try {
          const content = fs.readFileSync(abs, 'utf8');
          const symbols = extractTsTopLevelSymbols(content);
          if (symbols.length > TS_MULTI_CLASS_THRESHOLD) {
            warnings.push({
              code: 'UNIVERSAL_MULTI_CLASS_TS',
              severity: 'critical',
              message: `TypeScript file declares ${symbols.length} exported types (${symbols.slice(0, 5).join(', ')}${symbols.length > 5 ? '...' : ''}) — MUST be split into ${symbols.length} separate files (one class per file). NestJS convention: UserDto → user.dto.ts, CreateUserDto → create-user.dto.ts`,
              file: f,
            });
          }
        } catch (err) { swallow(err); }
      }
    }

    // CONSOLIDATION — N files declared, 1 file created, single file is large
    if (declaredPaths.length >= 2 && changedFiles.length === 1) {
      try {
        const singleFile = changedFiles[0];
        const abs = path.join(cwd, singleFile);
        if (fs.existsSync(abs)) {
          const lines = fs.readFileSync(abs, 'utf8').split('\n').length;
          if (lines > 200) {
            warnings.push({
              code: 'UNIVERSAL_CONSOLIDATION',
              severity: 'critical',
              message: `techContext declared ${declaredPaths.length} files but only 1 file with ${lines} lines was created — likely consolidation`,
              file: singleFile,
            });
          }
        }
      } catch (err) { swallow(err); }
    }

    return warnings;
  },
};
