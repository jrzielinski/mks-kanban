import { swallow } from '../utils/log';
/**
 * LSP client — real JSON-RPC client for language servers via stdio.
 *
 * Supports TypeScript (typescript-language-server) and Dart (dart language-server).
 * Implements: initialize, textDocument/didOpen, textDocument/didChange,
 * textDocument/definition, textDocument/references, textDocument/hover,
 * textDocument/documentSymbol, textDocument/implementation, textDocument/typeDefinition.
 *
 * Protocol: LSP 3.17 over stdio. Framing: "Content-Length: N\r\n\r\n<body>"
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (err: any) => void;
  timeout: NodeJS.Timeout;
}

interface OpenDoc {
  version: number;
  content: string;
  mtime: number;
  watcher: fs.FSWatcher | null;
}

/** Single diagnostic entry as exposed to the executor — flatter than the
 *  raw LSP shape so callers don't have to know about Range objects. */
export interface FileDiagnostic {
  /** 1-based line for human-readable retry prompts. */
  line: number;
  /** 1-based character offset. */
  character: number;
  /** LSP severity: 1=Error, 2=Warning, 3=Info, 4=Hint. */
  severity: 1 | 2 | 3 | 4;
  message: string;
  source?: string;
  code?: string;
}

interface ServerState {
  process: ChildProcess;
  nextId: number;
  pending: Map<number, PendingRequest>;
  buffer: Buffer;
  contentLength: number | null;
  openDocs: Map<string, OpenDoc>;  // uri -> doc state
  rootUri: string;
  ready: Promise<void>;
  readyResolve: (() => void) | null;
  lang: Language;
  /** Latest diagnostics per file URI, populated by publishDiagnostics. The
   *  server overwrites the whole array each time it pushes — so the cache
   *  always reflects the server's current view, not the union of past
   *  pushes. Empty array means "server says no problems here right now". */
  diagnostics: Map<string, FileDiagnostic[]>;
}

// Registry-driven LSP support. `Language` used to be a hard-coded union of
// 'typescript' | 'dart'. Now it's an opaque string keyed into a server
// registry (defaults below + user overrides from ~/.makestudio/lsp.json).
// Schema mirrors OpenCode's `lsp.<name>.{command,extensions,env,initialization,disabled}`
// so users coming from there can copy their config straight in.
type Language = string;

interface LspServerConfig {
  /** Argv: ["typescript-language-server", "--stdio"]. The first element is
   *  the binary; resolved against PATH at spawn time. */
  command: string[];
  /** File extensions handled by this server. Include the leading dot. */
  extensions: string[];
  /** Files whose presence anchors the project root. The agent walks up
   *  from the file being analysed and starts the server in the first
   *  directory that contains any of these markers — closer than `cwd`
   *  for monorepos and more accurate for single-language projects.
   *  Falls back to the workspace root when none match. Examples:
   *  TypeScript → ["tsconfig.json","package.json"], Rust → ["Cargo.toml"],
   *  Python → ["pyproject.toml","setup.py","setup.cfg","Pipfile"]. */
  rootMarkers?: string[];
  /** Environment variables passed to the spawned process. Merged on top of
   *  the inherited env. */
  env?: Record<string, string>;
  /** Server-specific `initializationOptions` sent in the LSP `initialize`
   *  request. Forwarded as-is. */
  initialization?: any;
  /** Builtin-only hook to compute `initializationOptions` dynamically
   *  from the resolved root (e.g. detect a Python venv and pass
   *  `pythonPath`). Runs at spawn time and merges over `initialization`.
   *  Not exposed to user JSON config — only the built-in registry sets it
   *  via the `_BUILTIN_DYNAMIC_INIT` map below. */
  _dynamicInitKey?: string;
  /** Skip this server even if its extension matches. Lets users selectively
   *  disable a builtin without rewriting it. */
  disabled?: boolean;
  /** Optional fallback command tried when `command[0]` fails to spawn —
   *  same shape as `command`. Used by the TS builtin to fall through to
   *  `npx -y typescript-language-server`. */
  fallback?: string[];
  /** Friendly install hint shown when the binary isn't on PATH. */
  installHint?: string;
}

/**
 * Built-in server registry. These ship with the agent so common languages
 * work out-of-the-box; user `lsp.json` entries override by name.
 *
 * Adding more is fine — but each server must be on the user's machine. We
 * never auto-download binaries.
 */
export const BUILTIN_SERVERS: Record<string, LspServerConfig> = {
  typescript: {
    command: ['typescript-language-server', '--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    fallback: ['npx', '-y', 'typescript-language-server', '--stdio'],
    installHint: 'npm install -g typescript-language-server typescript',
  },
  dart: {
    // Resolved at spawn time so we can prefer fvm-managed dart when present.
    command: ['dart', 'language-server', '--protocol=lsp'],
    extensions: ['.dart'],
    rootMarkers: ['pubspec.yaml'],
    installHint: 'Install Dart SDK or fvm.',
  },
  python: {
    command: ['pyright-langserver', '--stdio'],
    extensions: ['.py', '.pyi'],
    rootMarkers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'pyrightconfig.json'],
    _dynamicInitKey: 'python:venv',
    installHint: 'npm install -g pyright',
  },
  go: {
    command: ['gopls'],
    extensions: ['.go'],
    rootMarkers: ['go.mod', 'go.work'],
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
  rust: {
    command: ['rust-analyzer'],
    extensions: ['.rs'],
    rootMarkers: ['Cargo.toml'],
    installHint: 'rustup component add rust-analyzer',
  },
  bash: {
    command: ['bash-language-server', 'start'],
    extensions: ['.sh', '.bash'],
    installHint: 'npm install -g bash-language-server',
  },
  // ── JVM ──────────────────────────────────────────────────────────────────
  java: {
    command: ['jdtls'],
    extensions: ['.java'],
    rootMarkers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', '.project'],
    installHint: 'Install Eclipse JDT LS — `brew install jdtls` or `coursier install jdtls`. Requires Java 17+ on PATH.',
  },
  kotlin: {
    command: ['kotlin-language-server'],
    extensions: ['.kt', '.kts'],
    rootMarkers: ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts', 'settings.gradle'],
    installHint: 'brew install kotlin-language-server (or build from fwcd/kotlin-language-server)',
  },
  // ── C / C++ ──────────────────────────────────────────────────────────────
  clang: {
    command: ['clangd', '--background-index'],
    extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.m', '.mm'],
    rootMarkers: ['compile_commands.json', 'CMakeLists.txt', '.clangd', 'Makefile'],
    installHint: 'macOS: `brew install llvm` then ensure clangd is on PATH. Linux: `apt install clangd`. A compile_commands.json speeds it up.',
  },
  // ── .NET ────────────────────────────────────────────────────────────────
  csharp: {
    command: ['csharp-ls'],
    extensions: ['.cs', '.csx'],
    rootMarkers: ['*.sln', '*.csproj'],
    installHint: 'dotnet tool install --global csharp-ls',
  },
  // ── Web (PHP / Ruby / Swift) ─────────────────────────────────────────────
  php: {
    command: ['intelephense', '--stdio'],
    extensions: ['.php', '.phtml'],
    rootMarkers: ['composer.json'],
    installHint: 'npm install -g intelephense (free tier covers most features; phpactor is the FOSS alternative)',
  },
  ruby: {
    command: ['ruby-lsp'],
    extensions: ['.rb', '.rake', '.gemspec'],
    rootMarkers: ['Gemfile', 'Rakefile', '.ruby-version'],
    installHint: 'gem install ruby-lsp',
  },
  swift: {
    command: ['sourcekit-lsp'],
    extensions: ['.swift'],
    rootMarkers: ['Package.swift', '*.xcodeproj', '*.xcworkspace'],
    installHint: 'Ships with Xcode/Swift toolchain — usually already on PATH on macOS. Check with `xcrun --find sourcekit-lsp`.',
  },
  // ── Markup / Config (the VS Code "extracted" bundle covers all four) ────
  html: {
    command: ['vscode-html-language-server', '--stdio'],
    extensions: ['.html', '.htm'],
    installHint: 'npm install -g vscode-langservers-extracted (provides html/css/json/eslint LSPs)',
  },
  css: {
    command: ['vscode-css-language-server', '--stdio'],
    extensions: ['.css', '.scss', '.sass', '.less'],
    installHint: 'npm install -g vscode-langservers-extracted',
  },
  json: {
    command: ['vscode-json-language-server', '--stdio'],
    extensions: ['.json', '.jsonc'],
    installHint: 'npm install -g vscode-langservers-extracted',
  },
  yaml: {
    command: ['yaml-language-server', '--stdio'],
    extensions: ['.yaml', '.yml'],
    installHint: 'npm install -g yaml-language-server',
  },
  // ── Frontend frameworks ─────────────────────────────────────────────────
  vue: {
    command: ['vue-language-server', '--stdio'],
    extensions: ['.vue'],
    rootMarkers: ['package.json', 'vite.config.ts', 'vite.config.js'],
    installHint: 'npm install -g @vue/language-server (Volar)',
  },
  svelte: {
    command: ['svelteserver', '--stdio'],
    extensions: ['.svelte'],
    rootMarkers: ['package.json', 'svelte.config.js', 'svelte.config.ts'],
    installHint: 'npm install -g svelte-language-server',
  },
  // ── Scripting / functional ──────────────────────────────────────────────
  lua: {
    command: ['lua-language-server'],
    extensions: ['.lua'],
    rootMarkers: ['.luarc.json', '.luarc.jsonc', 'rockspec'],
    installHint: 'brew install lua-language-server (or grab from sumneko/lua-language-server releases)',
  },
  elixir: {
    command: ['elixir-ls'],
    extensions: ['.ex', '.exs', '.eex', '.heex', '.leex'],
    rootMarkers: ['mix.exs', 'mix.lock'],
    installHint: 'brew install elixir-ls (or build from elixir-lsp/elixir-ls)',
  },
  zig: {
    command: ['zls'],
    extensions: ['.zig'],
    rootMarkers: ['build.zig'],
    installHint: 'Install via your zig version manager (zvm) or `brew install zls`',
  },
  // ── Infra ───────────────────────────────────────────────────────────────
  terraform: {
    command: ['terraform-ls', 'serve'],
    extensions: ['.tf', '.tfvars'],
    rootMarkers: ['.terraform', 'main.tf'],
    installHint: 'brew install hashicorp/tap/terraform-ls',
  },
  markdown: {
    command: ['marksman', 'server'],
    extensions: ['.md', '.markdown'],
    installHint: 'brew install marksman (or grab from artempyanykh/marksman releases)',
  },
  // ── Linters-as-LSP ─────────────────────────────────────────────────────
  // Disabled by default — they share extensions with `typescript` and our
  // current single-server-per-language design picks the first match in
  // the registry, so leaving them enabled would shadow the typescript
  // server. Users who want lint diagnostics turn them on per-project via
  // `.makestudio/lsp.json`:
  //
  //     {
  //       "typescript": { "disabled": true },
  //       "lint-eslint": { "disabled": false }
  //     }
  //
  // (typescript stays in your project too if you want both, but spawn
  // logic only attaches to one — pick the more useful one for your
  // workflow.)
  'lint-eslint': {
    command: ['vscode-eslint-language-server', '--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'],
    rootMarkers: ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', 'eslint.config.js', 'eslint.config.mjs'],
    disabled: true,
    installHint: 'npm install -g vscode-langservers-extracted (provides eslint LSP)',
  },
  'lint-biome': {
    command: ['biome', 'lsp-proxy'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc'],
    rootMarkers: ['biome.json', 'biome.jsonc'],
    disabled: true,
    installHint: 'npm install -g @biomejs/biome (or per-project: bun add -D @biomejs/biome)',
  },
  // ── Schema-aware — Prisma + Tailwind get their own LSPs that go beyond
  //    plain syntax (relation graph, class IntelliSense). Useful when the
  //    user is touching .prisma / Tailwind class strings.
  prisma: {
    command: ['prisma-language-server', '--stdio'],
    extensions: ['.prisma'],
    rootMarkers: ['schema.prisma', 'package.json'],
    installHint: 'npm install -g @prisma/language-server',
  },
  tailwind: {
    command: ['tailwindcss-language-server', '--stdio'],
    extensions: ['.tsx', '.jsx', '.vue', '.svelte', '.html'],
    rootMarkers: ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs'],
    // Disabled by default — only spawns if the user explicitly enables it
    // via project lsp.json (`{"tailwind":{"disabled":false}}`). Otherwise
    // it'd compete with typescript on .tsx for hover/definition results.
    disabled: true,
    installHint: 'npm install -g @tailwindcss/language-server',
  },
};

/**
 * Per-language hooks that compute initializationOptions dynamically from
 * the resolved project root. Runs at spawn time and merges OVER any
 * static `initialization` field. Keyed by `_dynamicInitKey` on the
 * builtin entry — keeps user JSON config clean (overrides via plain
 * `initialization` always work, even for languages that have a hook).
 */
const _BUILTIN_DYNAMIC_INIT: Record<string, (root: string) => Record<string, any>> = {
  // Python: detect a virtualenv next to the project root and pass its
  // python binary to pyright via initializationOptions.pythonPath.
  // Without this, pyright reports false-positive "Import not resolved"
  // for every project dependency installed in the venv. Order mirrors
  // opencode's: $VIRTUAL_ENV first, then .venv/, then venv/.
  'python:venv': (root: string): Record<string, any> => {
    const candidates: string[] = [];
    if (process.env.VIRTUAL_ENV) candidates.push(process.env.VIRTUAL_ENV);
    candidates.push(path.join(root, '.venv'));
    candidates.push(path.join(root, 'venv'));
    const isWindows = process.platform === 'win32';
    for (const venvPath of candidates) {
      const py = isWindows
        ? path.join(venvPath, 'Scripts', 'python.exe')
        : path.join(venvPath, 'bin', 'python');
      if (fs.existsSync(py)) return { pythonPath: py, venvPath };
    }
    return {};
  },
};

/** Cached effective registry, keyed by rootPath. The `_global` slot holds
 *  the builtin+user merge for callers that don't have a project root. */
const cachedRegistries = new Map<string, Record<string, LspServerConfig>>();

function mergeRegistryFile(target: Record<string, LspServerConfig>, file: string): void {
  try {
    if (!fs.existsSync(file)) return;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return;
    for (const [name, cfg] of Object.entries(parsed)) {
      if (!cfg || typeof cfg !== 'object') continue;
      // Partial overrides (e.g. just `disabled: true`) merge over any
      // earlier definition of the same name.
      target[name] = { ...(target[name] || {} as LspServerConfig), ...(cfg as any) };
    }
  } catch (err) { swallow(err); }
}

/**
 * Load the effective server registry. Precedence (later wins):
 *   1. BUILTIN_SERVERS                       — bundled with the agent
 *   2. ~/.makestudio/lsp.json                — user-global
 *   3. <rootPath>/.makestudio/lsp.json       — project-local (wins)
 *
 * Project config is the recommended place for team-shared LSP setups —
 * commit it to git and the same servers spin up on every machine. The
 * user-global file is for personal preferences (e.g. disabling pyright
 * because you use ruff-lsp instead). Pass `rootPath` to include the
 * project layer; omit it for global-only callers.
 *
 * Cached per rootPath; survives until process exit or
 * `reloadLspRegistry()`.
 */
function loadServerRegistry(rootPath?: string): Record<string, LspServerConfig> {
  const cacheKey = rootPath || '_global';
  const cached = cachedRegistries.get(cacheKey);
  if (cached) return cached;

  const merged: Record<string, LspServerConfig> = { ...BUILTIN_SERVERS };
  // 2. user-global
  mergeRegistryFile(merged, path.join(require('os').homedir(), '.makestudio', 'lsp.json'));
  // 3. project-local — wins
  if (rootPath) {
    mergeRegistryFile(merged, path.join(rootPath, '.makestudio', 'lsp.json'));
  }
  // Drop disabled entries entirely so extension lookup skips them.
  for (const k of Object.keys(merged)) {
    if (merged[k].disabled) delete merged[k];
  }
  cachedRegistries.set(cacheKey, merged);
  return merged;
}

/** Re-read all registries on next call. Used after editing lsp.json. */
export function reloadLspRegistry(): void { cachedRegistries.clear(); }

const servers = new Map<string, ServerState>();
// In-flight startup dedup. Concurrent callers before the server is in
// `servers` race to spawn; we key the startup promise so both return the
// same ServerState. Port of Claude Code's LSP manager request-queue.
const serverStartup = new Map<string, Promise<ServerState | null>>();
// Last startup error per server key — populated by startServerInner on
// failure, consumed by callers (lspDefinition/lspReferences/...) to
// distinguish "LSP failed to start" from "symbol not found".
const lastStartupError = new Map<string, { error: true; lang: string; reason: string; hint?: string }>();

/** Exposed for tool impls in `advanced-tools.ts:runLspTool` so they can
 *  surface "LSP broken" as a discrete error shape instead of null. */
export function getLastLspStartupError(lang: string, rootPath: string): { error: true; lang: string; reason: string; hint?: string } | null {
  return lastStartupError.get(`${lang}:${rootPath}`) || null;
}

function pathToUri(p: string): string {
  return url.pathToFileURL(path.resolve(p)).href;
}

function uriToPath(u: string): string {
  return url.fileURLToPath(u);
}

function getLanguageFromFile(filePath: string, rootPath?: string): Language | null {
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) return null;
  const reg = loadServerRegistry(rootPath);
  for (const [name, cfg] of Object.entries(reg)) {
    if (cfg.extensions.includes(ext)) return name;
  }
  return null;
}

function getServerCommand(lang: Language, rootPath?: string): { cmd: string; args: string[]; env?: Record<string, string>; fallback?: { cmd: string; args: string[] }; init?: any; installHint?: string } | null {
  const reg = loadServerRegistry(rootPath);
  const cfg = reg[lang];
  if (!cfg || !cfg.command || cfg.command.length === 0) return null;

  // Special-case Dart so fvm-managed binaries win when present without
  // forcing the user to override their lsp.json. Pure path probe — if the
  // file is there, swap the cmd; otherwise leave the registry entry alone.
  let cmd = cfg.command[0];
  let args = cfg.command.slice(1);
  if (lang === 'dart') {
    const fvm = path.join(require('os').homedir(), 'fvm', 'default', 'bin', 'dart');
    if (fs.existsSync(fvm)) cmd = fvm;
  }

  const fallback = cfg.fallback && cfg.fallback.length > 0
    ? { cmd: cfg.fallback[0], args: cfg.fallback.slice(1) }
    : undefined;

  return { cmd, args, env: cfg.env, fallback, init: cfg.initialization, installHint: cfg.installHint };
}

/**
 * Walk up from `startDir` (inclusive) looking for any of the given
 * markers. Returns the first directory that contains a match. Stops at
 * `boundary` (typically the workspace root) — never escapes it.
 *
 * Markers can be plain filenames (`Cargo.toml`) or simple glob patterns
 * with a leading `*` (`*.csproj`). Only that minimal form — no full glob
 * — is supported, kept simple to match the rootMarkers shape.
 */
function findProjectRootFrom(startDir: string, markers: string[], boundary: string): string | null {
  if (!markers || markers.length === 0) return null;
  let current = startDir;
  const max = 64; // sanity cap — we should never walk this far
  for (let i = 0; i < max; i++) {
    let entries: string[];
    try { entries = fs.readdirSync(current); } catch { return null; }
    for (const m of markers) {
      if (m.startsWith('*')) {
        const suffix = m.slice(1);
        if (entries.some((e) => e.endsWith(suffix))) return current;
      } else if (entries.includes(m)) {
        return current;
      }
    }
    if (current === boundary) return null;
    const parent = path.dirname(current);
    if (parent === current) return null; // reached fs root
    if (boundary && !current.startsWith(boundary)) return null;
    current = parent;
  }
  return null;
}

/**
 * Resolve the right root directory for a server given the file under
 * analysis, the workspace boundary, and the language's rootMarkers.
 * Falls back to the workspace root when no file is provided OR no
 * marker matches — same behaviour as before for languages without
 * rootMarkers configured.
 */
function resolveServerRoot(lang: Language, workspaceRoot: string, filePath?: string): string {
  if (!filePath) return workspaceRoot;
  const reg = loadServerRegistry(workspaceRoot);
  const cfg = reg[lang];
  if (!cfg?.rootMarkers || cfg.rootMarkers.length === 0) return workspaceRoot;
  const startDir = path.dirname(path.resolve(filePath));
  const found = findProjectRootFrom(startDir, cfg.rootMarkers, workspaceRoot);
  return found || workspaceRoot;
}

async function startServer(lang: Language, workspaceRoot: string, filePath?: string): Promise<ServerState | null> {
  const rootPath = resolveServerRoot(lang, workspaceRoot, filePath);
  const key = `${lang}:${rootPath}`;
  if (servers.has(key)) return servers.get(key)!;
  // Dedup concurrent startups — two callers hitting this before the first
  // has populated `servers` would otherwise spawn duplicate child processes.
  const pending = serverStartup.get(key);
  if (pending) return pending;

  const p = startServerInner(lang, rootPath, key);
  serverStartup.set(key, p);
  try {
    return await p;
  } finally {
    // Retain in `servers` (if successful); drop the startup promise either way.
    serverStartup.delete(key);
  }
}

/**
 * LSP startup failure reason — consumers use this to distinguish "symbol
 * genuinely not found" from "LSP never started". Callers like
 * `lspDefinition` previously returned `null` in both cases, which led the
 * agent to conclude the symbol doesn't exist when in fact the language
 * server failed to spawn.
 */
export interface LspStartupError {
  error: true;
  reason: string;
  lang: Language;
  hint?: string;
}

// Exported so callers (lspDefinition/lspReferences/etc.) can surface the
// specific failure reason to the model. `state` is the normal happy path;
// anything else is diagnostic.
export type ServerStartResult = ServerState | LspStartupError;

async function startServerInner(lang: Language, rootPath: string, key: string): Promise<ServerState | null> {
  const launch = getServerCommand(lang, rootPath);
  if (!launch) {
    lastStartupError.set(key, {
      error: true, lang,
      reason: `No LSP server configured for language "${lang}".`,
      hint: `Add it to ~/.makestudio/lsp.json: {"${lang}":{"command":["<binary>","..."],"extensions":[".ext"]}}`,
    });
    return null;
  }

  const spawnEnv = launch.env ? { ...process.env, ...launch.env } : process.env;
  let proc: ChildProcess;
  try {
    proc = spawn(launch.cmd, launch.args, {
      cwd: rootPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv as any,
    });
  } catch (err: any) {
    // Generic fallback path: every server config can declare a `fallback`
    // command. The TS builtin uses it for `npx -y typescript-language-server`;
    // user-defined entries can do the same.
    if (launch.fallback) {
      try {
        proc = spawn(launch.fallback.cmd, launch.fallback.args, {
          cwd: rootPath,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: spawnEnv as any,
        });
      } catch (e2: any) {
        lastStartupError.set(key, {
          error: true, lang,
          reason: `Failed to spawn ${launch.cmd} and fallback ${launch.fallback.cmd}: ${e2.message || e2}`,
          hint: launch.installHint || `Check that \`${launch.cmd}\` is installed and on PATH.`,
        });
        return null;
      }
    } else {
      lastStartupError.set(key, {
        error: true, lang,
        reason: `Failed to spawn ${launch.cmd}: ${err.message || err}`,
        hint: launch.installHint || `Check that \`${launch.cmd}\` is installed and on PATH.`,
      });
      return null;
    }
  }

  let readyResolve: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => { readyResolve = resolve; });

  const state: ServerState = {
    process: proc,
    nextId: 1,
    pending: new Map(),
    buffer: Buffer.alloc(0),
    contentLength: null,
    openDocs: new Map(),
    rootUri: pathToUri(rootPath),
    ready,
    readyResolve,
    lang,
    diagnostics: new Map(),
  };

  proc.stdout?.on('data', (chunk: Buffer) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    processBuffer(state);
  });

  proc.stderr?.on('data', () => { /* silent */ });

  proc.on('error', () => {
    servers.delete(key);
  });

  proc.on('exit', () => {
    // Reject all pending
    for (const p of state.pending.values()) {
      clearTimeout(p.timeout);
      p.reject(new Error('LSP server exited'));
    }
    state.pending.clear();
    servers.delete(key);
  });

  servers.set(key, state);

  // Initialize
  try {
    const initParams: any = {
      processId: process.pid,
      rootUri: state.rootUri,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false, linkSupport: false },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false, contentFormat: ['plaintext'] },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          implementation: { dynamicRegistration: false },
          typeDefinition: { dynamicRegistration: false },
          // Advertise diagnostics support so servers know it's worth pushing.
          publishDiagnostics: { relatedInformation: false, versionSupport: false },
        },
      },
      workspaceFolders: [{ uri: state.rootUri, name: path.basename(rootPath) }],
    };
    // Static initializationOptions from the registry (user-configurable
    // via lsp.json). Dynamic builtin hook runs over them so user
    // overrides for static keys still win.
    let resolvedInit: Record<string, any> | undefined;
    if (launch.init && typeof launch.init === 'object') {
      resolvedInit = { ...launch.init };
    }
    try {
      const reg = loadServerRegistry(rootPath);
      const cfg = reg[lang];
      if (cfg?._dynamicInitKey) {
        const hook = _BUILTIN_DYNAMIC_INIT[cfg._dynamicInitKey];
        if (hook) {
          const dyn = hook(rootPath);
          if (dyn && Object.keys(dyn).length > 0) {
            resolvedInit = { ...dyn, ...(resolvedInit || {}) };
          }
        }
      }
    } catch (err) { swallow(err); }
    if (resolvedInit && Object.keys(resolvedInit).length > 0) {
      initParams.initializationOptions = resolvedInit;
    }
    await sendRequest(state, 'initialize', initParams, 20_000);
    sendNotification(state, 'initialized', {});
    if (state.readyResolve) state.readyResolve();
  } catch {
    try { proc.kill(); } catch (err) { swallow(err); }
    servers.delete(key);
    return null;
  }

  return state;
}

function processBuffer(state: ServerState): void {
  while (true) {
    if (state.contentLength === null) {
      // Look for header
      const headerEnd = state.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = state.buffer.slice(0, headerEnd).toString('utf8');
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        state.buffer = state.buffer.slice(headerEnd + 4);
        continue;
      }
      state.contentLength = parseInt(m[1], 10);
      state.buffer = state.buffer.slice(headerEnd + 4);
    }
    if (state.buffer.length < state.contentLength) return;
    const body = state.buffer.slice(0, state.contentLength).toString('utf8');
    state.buffer = state.buffer.slice(state.contentLength);
    state.contentLength = null;
    try {
      const msg = JSON.parse(body);
      handleMessage(state, msg);
    } catch (err) { swallow(err); }
  }
}

function handleMessage(state: ServerState, msg: any): void {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const pending = state.pending.get(msg.id);
    if (!pending) return;
    state.pending.delete(msg.id);
    clearTimeout(pending.timeout);
    if (msg.error) pending.reject(new Error(msg.error.message || 'LSP error'));
    else pending.resolve(msg.result);
    return;
  }
  // Notifications — only publishDiagnostics is consumed today; everything
  // else (window/showMessage, $/progress, server-initiated requests, etc.)
  // is intentionally dropped to keep this minimal client minimal.
  if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
    const uri: string = msg.params.uri;
    const raw: any[] = Array.isArray(msg.params.diagnostics) ? msg.params.diagnostics : [];
    const flat: FileDiagnostic[] = raw.map((d) => ({
      // Convert 0-based LSP positions to 1-based for prompt output.
      line: ((d.range && d.range.start && d.range.start.line) || 0) + 1,
      character: ((d.range && d.range.start && d.range.start.character) || 0) + 1,
      severity: ((d.severity || 3) as 1 | 2 | 3 | 4),
      message: String(d.message || ''),
      source: d.source ? String(d.source) : undefined,
      code: d.code != null ? String(d.code) : undefined,
    }));
    state.diagnostics.set(uri, flat);
  }
}

function sendMessage(state: ServerState, msg: any): void {
  const body = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
  try {
    state.process.stdin?.write(header + body);
  } catch (err) { swallow(err); }
}

function sendNotification(state: ServerState, method: string, params: any): void {
  sendMessage(state, { jsonrpc: '2.0', method, params });
}

async function sendRequest(state: ServerState, method: string, params: any, timeoutMs: number = 10_000): Promise<any> {
  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (state.pending.has(id)) {
        state.pending.delete(id);
        reject(new Error(`LSP ${method} timed out`));
      }
    }, timeoutMs);
    state.pending.set(id, { resolve, reject, timeout });
    sendMessage(state, { jsonrpc: '2.0', id, method, params });
  });
}

async function openDocument(state: ServerState, filePath: string, lang: Language): Promise<void> {
  const uri = pathToUri(filePath);
  if (state.openDocs.has(uri)) {
    // Already open — sync if changed on disk
    syncIfChanged(state, filePath);
    return;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const stats = fs.statSync(filePath);
  sendNotification(state, 'textDocument/didOpen', {
    textDocument: {
      uri,
      languageId: lang === 'typescript' ? 'typescript' : 'dart',
      version: 1,
      text: content,
    },
  });

  // Watch the file for external changes
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(filePath, { persistent: false }, (eventType) => {
      if (eventType === 'change') {
        syncIfChanged(state, filePath);
      }
    });
  } catch (err) { swallow(err); }

  state.openDocs.set(uri, {
    version: 1,
    content,
    mtime: stats.mtimeMs,
    watcher,
  });
}

function syncIfChanged(state: ServerState, filePath: string): void {
  const uri = pathToUri(filePath);
  const doc = state.openDocs.get(uri);
  if (!doc) return;
  try {
    const stats = fs.statSync(filePath);
    if (stats.mtimeMs === doc.mtime) return;
    const content = fs.readFileSync(filePath, 'utf8');
    if (content === doc.content) return;
    doc.version++;
    doc.content = content;
    doc.mtime = stats.mtimeMs;
    // Send full-document change (simpler than incremental)
    sendNotification(state, 'textDocument/didChange', {
      textDocument: { uri, version: doc.version },
      contentChanges: [{ text: content }],
    });
  } catch (err) { swallow(err); }
}

function closeDocument(state: ServerState, uri: string): void {
  const doc = state.openDocs.get(uri);
  if (!doc) return;
  if (doc.watcher) { try { doc.watcher.close(); } catch (err) { swallow(err); } }
  sendNotification(state, 'textDocument/didClose', {
    textDocument: { uri },
  });
  state.openDocs.delete(uri);
}

/**
 * Find the symbol position in a file (line, character) via simple text search.
 * Used because LSP needs a position, not a symbol name.
 */
function findSymbolPosition(filePath: string, symbol: string): { line: number; character: number } | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    // Prefer declaration-like matches
    const patterns = [
      new RegExp(`\\b(?:class|interface|enum|type|function|const|let|var|mixin|extension)\\s+${symbol}\\b`),
      new RegExp(`\\b${symbol}\\s*\\(`),
      new RegExp(`\\b${symbol}\\b`),
    ];
    for (const re of patterns) {
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (m) {
          const idx = lines[i].indexOf(symbol);
          if (idx !== -1) return { line: i, character: idx };
        }
      }
    }
  } catch (err) { swallow(err); }
  return null;
}

/**
 * Locate the file containing a symbol (by declaration) — used when the AI
 * gives just a symbol name and we need to bootstrap.
 */
function grepForSymbol(rootPath: string, symbol: string, lang: Language): string | null {
  const { execSync } = require('child_process');
  try {
    const ext = lang === 'typescript' ? `--include='*.ts' --include='*.tsx'` : `--include='*.dart'`;
    const pattern = `^\\s*(?:export\\s+)?(?:abstract\\s+)?(?:class|interface|enum|type|function|mixin|extension)\\s+${symbol}\\b`;
    const out = execSync(
      `grep -rlE ${ext} "${pattern}" "${rootPath}" 2>/dev/null | head -1`,
      { shell: '/bin/sh', timeout: 10_000 },
    ).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────

export async function lspDefinition(rootPath: string, symbol: string): Promise<any> {
  const lang = detectRootLanguage(rootPath);
  if (!lang) return { error: 'No supported language in project' };
  const state = await startServer(lang, rootPath);
  if (!state) return { error: `Failed to start ${lang} language server. Is it installed? (${lang === 'typescript' ? 'npm i -g typescript-language-server' : 'dart sdk'})` };
  await state.ready;

  const filePath = grepForSymbol(rootPath, symbol, lang);
  if (!filePath) return { error: `Symbol "${symbol}" not found via grep` };

  await openDocument(state, filePath, lang);
  const pos = findSymbolPosition(filePath, symbol);
  if (!pos) return { error: 'Could not locate symbol position in file' };

  const result = await sendRequest(state, 'textDocument/definition', {
    textDocument: { uri: pathToUri(filePath) },
    position: pos,
  });
  return formatLocations(result, rootPath);
}

export async function lspReferences(rootPath: string, symbol: string): Promise<any> {
  const lang = detectRootLanguage(rootPath);
  if (!lang) return { error: 'No supported language in project' };
  const state = await startServer(lang, rootPath);
  if (!state) return { error: `Failed to start ${lang} language server` };
  await state.ready;

  const filePath = grepForSymbol(rootPath, symbol, lang);
  if (!filePath) return { error: `Symbol "${symbol}" not found` };

  await openDocument(state, filePath, lang);
  const pos = findSymbolPosition(filePath, symbol);
  if (!pos) return { error: 'Could not locate symbol position' };

  const result = await sendRequest(state, 'textDocument/references', {
    textDocument: { uri: pathToUri(filePath) },
    position: pos,
    context: { includeDeclaration: false },
  }, 15_000);
  return formatLocations(result, rootPath);
}

export async function lspHover(rootPath: string, filePath: string, line: number, character: number): Promise<any> {
  const lang = getLanguageFromFile(filePath, rootPath) || detectRootLanguage(rootPath);
  if (!lang) return { error: 'Unsupported file type' };
  const state = await startServer(lang, rootPath, filePath);
  if (!state) return { error: `Failed to start ${lang} language server` };
  await state.ready;

  const abs = path.resolve(rootPath, filePath);
  await openDocument(state, abs, lang);
  const result = await sendRequest(state, 'textDocument/hover', {
    textDocument: { uri: pathToUri(abs) },
    position: { line, character },
  });
  if (!result || !result.contents) return { hover: null };
  const text = Array.isArray(result.contents)
    ? result.contents.map((c: any) => typeof c === 'string' ? c : c.value).join('\n')
    : typeof result.contents === 'string' ? result.contents : result.contents.value;
  return { hover: text, range: result.range };
}

export async function lspDocumentSymbols(rootPath: string, filePath: string): Promise<any> {
  const lang = getLanguageFromFile(filePath, rootPath) || detectRootLanguage(rootPath);
  if (!lang) return { error: 'Unsupported file type' };
  const state = await startServer(lang, rootPath, filePath);
  if (!state) return { error: `Failed to start ${lang} language server` };
  await state.ready;

  const abs = path.resolve(rootPath, filePath);
  await openDocument(state, abs, lang);
  const result = await sendRequest(state, 'textDocument/documentSymbol', {
    textDocument: { uri: pathToUri(abs) },
  });
  return { symbols: flattenSymbols(result || []) };
}

function flattenSymbols(symbols: any[], parent?: string): any[] {
  const flat: any[] = [];
  for (const s of symbols) {
    const name = parent ? `${parent}.${s.name}` : s.name;
    const kind = kindToString(s.kind);
    const range = s.selectionRange || s.range || s.location?.range;
    flat.push({ name, kind, line: range ? range.start.line + 1 : 0 });
    if (s.children) flat.push(...flattenSymbols(s.children, name));
  }
  return flat;
}

function kindToString(kind: number): string {
  const kinds = ['file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum_member', 'struct', 'event', 'operator', 'type_parameter'];
  return kinds[kind - 1] || 'unknown';
}

function formatLocations(locations: any, rootPath: string): any {
  if (!locations) return { found: false };
  const arr = Array.isArray(locations) ? locations : [locations];
  const mapped = arr.map((loc: any) => {
    const uri = loc.uri || loc.targetUri;
    const range = loc.range || loc.targetRange || loc.targetSelectionRange;
    return {
      file: path.relative(rootPath, uriToPath(uri)),
      line: range ? range.start.line + 1 : 0,
      character: range ? range.start.character : 0,
    };
  });
  return { found: mapped.length > 0, count: mapped.length, locations: mapped };
}

function detectRootLanguage(rootPath: string): Language | null {
  if (fs.existsSync(path.join(rootPath, 'pubspec.yaml'))) return 'dart';
  for (const sub of ['app', 'mobile', 'flutter']) {
    if (fs.existsSync(path.join(rootPath, sub, 'pubspec.yaml'))) return 'dart';
  }
  if (fs.existsSync(path.join(rootPath, 'tsconfig.json')) || fs.existsSync(path.join(rootPath, 'package.json'))) return 'typescript';
  for (const sub of ['api', 'backend', 'web', 'frontend']) {
    if (fs.existsSync(path.join(rootPath, sub, 'package.json'))) return 'typescript';
  }
  return null;
}

/**
 * Go to implementation for the symbol at the given position.
 * Works for interfaces/abstract methods — returns concrete impls.
 */
export async function lspImplementation(
  rootPath: string,
  filePath: string,
  line: number,
  character: number,
): Promise<any> {
  const lang = getLanguageFromFile(filePath, rootPath) || detectRootLanguage(rootPath);
  if (!lang) return { error: 'Unsupported file type' };
  const state = await startServer(lang, rootPath, filePath);
  if (!state) return { error: `Failed to start ${lang} language server` };
  await state.ready;
  const abs = path.resolve(rootPath, filePath);
  await openDocument(state, abs, lang);
  const result = await sendRequest(state, 'textDocument/implementation', {
    textDocument: { uri: pathToUri(abs) },
    position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
  });
  return formatLocations(result, rootPath);
}

/**
 * Workspace-wide symbol search by query string.
 */
export async function lspWorkspaceSymbols(rootPath: string, query: string): Promise<any> {
  const lang = detectRootLanguage(rootPath);
  if (!lang) return { error: 'No supported language in project' };
  const state = await startServer(lang, rootPath);
  if (!state) return { error: `Failed to start ${lang} language server` };
  await state.ready;
  const result = await sendRequest(state, 'workspace/symbol', { query }, 15_000);
  const arr = Array.isArray(result) ? result : [];
  return {
    count: arr.length,
    symbols: arr.slice(0, 200).map((s: any) => {
      const range = s.location?.range || s.range;
      return {
        name: s.name,
        kind: kindToString(s.kind),
        containerName: s.containerName || null,
        file: s.location?.uri ? path.relative(rootPath, uriToPath(s.location.uri)) : null,
        line: range ? range.start.line + 1 : 0,
      };
    }),
  };
}

/**
 * Prepare a call hierarchy at the given position. Returns items that can
 * be fed into incomingCalls / outgoingCalls.
 */
async function prepareCallHierarchy(
  rootPath: string,
  filePath: string,
  line: number,
  character: number,
): Promise<{ items: any[]; state: ServerState | null; rootPath: string; abs: string } | { error: string }> {
  const lang = getLanguageFromFile(filePath, rootPath) || detectRootLanguage(rootPath);
  if (!lang) return { error: 'Unsupported file type' };
  const state = await startServer(lang, rootPath, filePath);
  if (!state) return { error: `Failed to start ${lang} language server` };
  await state.ready;
  const abs = path.resolve(rootPath, filePath);
  await openDocument(state, abs, lang);
  const result = await sendRequest(state, 'textDocument/prepareCallHierarchy', {
    textDocument: { uri: pathToUri(abs) },
    position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
  });
  return { items: Array.isArray(result) ? result : [], state, rootPath, abs };
}

export async function lspIncomingCalls(
  rootPath: string,
  filePath: string,
  line: number,
  character: number,
): Promise<any> {
  const prep = await prepareCallHierarchy(rootPath, filePath, line, character);
  if ('error' in prep) return prep;
  if (prep.items.length === 0) return { count: 0, calls: [] };
  const calls = await sendRequest(prep.state!, 'callHierarchy/incomingCalls', {
    item: prep.items[0],
  }, 15_000);
  const arr = Array.isArray(calls) ? calls : [];
  return {
    count: arr.length,
    target: { name: prep.items[0].name, kind: kindToString(prep.items[0].kind) },
    calls: arr.slice(0, 100).map((c: any) => ({
      from: c.from?.name,
      kind: kindToString(c.from?.kind),
      file: c.from?.uri ? path.relative(rootPath, uriToPath(c.from.uri)) : null,
      line: c.from?.range ? c.from.range.start.line + 1 : 0,
      fromRanges: (c.fromRanges || []).length,
    })),
  };
}

export async function lspOutgoingCalls(
  rootPath: string,
  filePath: string,
  line: number,
  character: number,
): Promise<any> {
  const prep = await prepareCallHierarchy(rootPath, filePath, line, character);
  if ('error' in prep) return prep;
  if (prep.items.length === 0) return { count: 0, calls: [] };
  const calls = await sendRequest(prep.state!, 'callHierarchy/outgoingCalls', {
    item: prep.items[0],
  }, 15_000);
  const arr = Array.isArray(calls) ? calls : [];
  return {
    count: arr.length,
    target: { name: prep.items[0].name, kind: kindToString(prep.items[0].kind) },
    calls: arr.slice(0, 100).map((c: any) => ({
      to: c.to?.name,
      kind: kindToString(c.to?.kind),
      file: c.to?.uri ? path.relative(rootPath, uriToPath(c.to.uri)) : null,
      line: c.to?.range ? c.to.range.start.line + 1 : 0,
    })),
  };
}

/**
 * Position-based definition (takes filePath+line+character directly).
 * Preferred over the symbol-grep variant when the agent already has a position.
 */
export async function lspDefinitionAt(
  rootPath: string,
  filePath: string,
  line: number,
  character: number,
): Promise<any> {
  const lang = getLanguageFromFile(filePath, rootPath) || detectRootLanguage(rootPath);
  if (!lang) return { error: 'Unsupported file type' };
  const state = await startServer(lang, rootPath, filePath);
  if (!state) return { error: `Failed to start ${lang} language server` };
  await state.ready;
  const abs = path.resolve(rootPath, filePath);
  await openDocument(state, abs, lang);
  const result = await sendRequest(state, 'textDocument/definition', {
    textDocument: { uri: pathToUri(abs) },
    position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
  });
  return formatLocations(result, rootPath);
}

export async function lspReferencesAt(
  rootPath: string,
  filePath: string,
  line: number,
  character: number,
): Promise<any> {
  const lang = getLanguageFromFile(filePath, rootPath) || detectRootLanguage(rootPath);
  if (!lang) return { error: 'Unsupported file type' };
  const state = await startServer(lang, rootPath, filePath);
  if (!state) return { error: `Failed to start ${lang} language server` };
  await state.ready;
  const abs = path.resolve(rootPath, filePath);
  await openDocument(state, abs, lang);
  const result = await sendRequest(state, 'textDocument/references', {
    textDocument: { uri: pathToUri(abs) },
    position: { line: Math.max(0, line - 1), character: Math.max(0, character - 1) },
    context: { includeDeclaration: false },
  }, 15_000);
  return formatLocations(result, rootPath);
}

/**
 * Read the latest diagnostics for a file. Servers push these via
 * `textDocument/publishDiagnostics` after analysis completes — they are
 * NOT fetched on demand. So this returns the most recent push for the
 * file, or `null` if no server has seen it.
 *
 * The executor calls this after every Write/Edit and feeds Error-severity
 * findings into the verify-runner's retry prompt so the model fixes type
 * errors in the next iteration instead of waiting for `tsc --noEmit`.
 *
 * Best-effort: if the file's language has no registered server, or the
 * server hasn't reported on this file yet (e.g. the document was never
 * opened in the LSP client), returns `null`. Callers should treat null as
 * "no diagnostics info available right now", not "no problems".
 */
export function getDiagnostics(rootPath: string, filePath: string): FileDiagnostic[] | null {
  const lang = getLanguageFromFile(filePath);
  if (!lang) return null;
  const state = servers.get(`${lang}:${rootPath}`);
  if (!state) return null;
  const uri = pathToUri(filePath);
  const list = state.diagnostics.get(uri);
  if (!list) return null;
  // Defensive copy — caller shouldn't be able to mutate the cache.
  return list.slice();
}

/** Debug counters consumed by debug-log.captureMemSnapshot — surfaces the
 *  total number of files tracked across ALL active LSP servers and the
 *  total diagnostic entries currently held. A growing entry count without
 *  the file count growing means diagnostics aren't being pruned per file
 *  (revisit clearStaleDiagnostics behavior). */
export function __debugCounts(): { files: number; entries: number; servers: number; openDocs: number } {
  let files = 0, entries = 0, openDocs = 0;
  for (const state of servers.values()) {
    files += state.diagnostics.size;
    for (const list of state.diagnostics.values()) entries += list.length;
    openDocs += state.openDocs.size;
  }
  return { files, entries, servers: servers.size, openDocs };
}

export function shutdownLsp(): void {
  for (const state of servers.values()) {
    // Close all document watchers
    for (const doc of state.openDocs.values()) {
      if (doc.watcher) { try { doc.watcher.close(); } catch (err) { swallow(err); } }
    }
    state.openDocs.clear();
    try { state.process.kill(); } catch (err) { swallow(err); }
  }
  servers.clear();
}
