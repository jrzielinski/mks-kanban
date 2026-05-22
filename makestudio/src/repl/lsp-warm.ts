import { swallow } from '../utils/log';
/**
 * lsp-warm.ts — proactive LSP server warm-up at REPL startup.
 *
 * The first LSP request a user makes (e.g. `goto definition` on a
 * symbol) triggers a server spawn that takes 2-15s depending on the
 * language (typescript-language-server cold-start can be >10s on a
 * large monorepo). By kicking off that spawn IN PARALLEL with the
 * model's first reply, the user-facing latency on the first LSP
 * call drops to near-zero — the server is already running by the
 * time the user actually invokes the symbol lookup.
 *
 * Heuristic for which servers to warm: project detection.
 *   package.json + tsconfig.json / .ts files → typescript
 *   pyproject.toml / requirements.txt / .py    → python
 *   go.mod                                      → go
 *   Cargo.toml                                  → rust
 *   pubspec.yaml                                → dart
 *
 * Multiple matches → warm them all (a polyglot repo benefits from
 * every server being ready). Each warm-up runs in the background;
 * failures are silently swallowed (the LSP module records its own
 * startup errors, surfaced later via getLastLspStartupError).
 *
 * Off by default (extra processes consume RAM). Enable via
 * `settings.lspWarmPool: true` or env MAKESTUDIO_LSP_WARM=1.
 */

import * as fs from 'fs';
import * as path from 'path';

const PROJECT_INDICATORS: Array<{ files: string[]; lang: string }> = [
  // TypeScript / JavaScript
  { files: ['tsconfig.json', 'jsconfig.json', 'package.json'], lang: 'typescript' },
  // Python
  { files: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'], lang: 'python' },
  // Go
  { files: ['go.mod'], lang: 'go' },
  // Rust
  { files: ['Cargo.toml'], lang: 'rust' },
  // Dart / Flutter
  { files: ['pubspec.yaml'], lang: 'dart' },
  // Java
  { files: ['pom.xml', 'build.gradle', 'build.gradle.kts'], lang: 'java' },
  // C# / .NET
  { files: ['*.csproj', '*.sln'], lang: 'csharp' },
  // Ruby
  { files: ['Gemfile', '*.gemspec'], lang: 'ruby' },
  // PHP
  { files: ['composer.json'], lang: 'php' },
];

/**
 * Detect which languages the project at `rootPath` likely uses, based
 * on the presence of well-known indicator files. Returns a list of
 * language ids matching the LSP registry (typescript, python, etc.).
 */
export function detectProjectLanguages(rootPath: string): string[] {
  const out = new Set<string>();
  let entries: string[];
  try { entries = fs.readdirSync(rootPath); } catch { return []; }
  const entrySet = new Set(entries);

  for (const ind of PROJECT_INDICATORS) {
    for (const f of ind.files) {
      if (f.includes('*')) {
        // Simple glob — match by extension for `*.csproj` style.
        const ext = f.replace(/^\*/, '');
        if (entries.some((e) => e.endsWith(ext))) {
          out.add(ind.lang);
          break;
        }
      } else if (entrySet.has(f)) {
        out.add(ind.lang);
        break;
      }
    }
  }
  return Array.from(out);
}

let cachedEnabled: boolean | null = null;
function isEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  const env = (process.env.MAKESTUDIO_LSP_WARM || '').toLowerCase().trim();
  if (env === '1' || env === 'true' || env === 'on') { cachedEnabled = true; return true; }
  if (env === '0' || env === 'false' || env === 'off') { cachedEnabled = false; return false; }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadSettings } = require('./settings');
    const s = loadSettings() as any;
    cachedEnabled = !!s?.lspWarmPool;
    return cachedEnabled;
  } catch { cachedEnabled = false; return false; }
}

export function resetLspWarmCache(): void { cachedEnabled = null; }

/**
 * Kick off background warm-up for every language detected in the
 * project. Returns immediately — the actual spawns are fire-and-forget
 * so the REPL boot path stays fast. Returns the list of languages
 * we attempted to warm so /diagnose can show what's been triggered.
 */
export function warmLspPool(rootPath: string): string[] {
  if (!isEnabled() || !rootPath) return [];
  const langs = detectProjectLanguages(rootPath);
  if (langs.length === 0) return [];

  // Resolve the LSP module lazily so this file stays free of a hard
  // dep on the LSP runtime (good for tests where lsp.ts pulls a heavy
  // child_process tree).
  let spawnFn: ((lang: string, root: string) => Promise<any>) | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const lspMod = require('./lsp');
    // The actual server-start function is internal to lsp.ts — most
    // public entry points (lspDefinition, lspReferences) take a symbol
    // and a path. We trigger a warm by calling lspDefinition with a
    // dummy symbol; it returns null but the side effect (spawn) is
    // what we want.
    spawnFn = (lang: string, root: string) => lspMod.lspDefinition(root, '__lsp_warm_probe__');
  } catch {
    return [];
  }

  for (const lang of langs) {
    try {
      // Fire and forget — never await. Uncaught rejection logs to
      // stderr, which is fine for diagnostics.
      Promise.resolve()
        .then(() => spawnFn!(lang, rootPath))
        .catch(() => { /* lsp module already records the error */ });
    } catch (err) { swallow(err); }
  }
  return langs;
}
