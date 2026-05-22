import { swallow } from '../utils/log';
/**
 * boilerplate-signatures.ts (agent-side)
 *
 * Scans the agent's local boilerplate source tree and extracts the public
 * API surface (class names, method signatures, controller routes, entity
 * columns) into a structured markdown block. The output is appended to
 * `.makestudio/context/boilerplate.md` so the CLI doing decomposition has
 * concrete signatures without having to read the source files.
 *
 * Why agent-side: the backend runs in a Docker container that doesn't have
 * access to the host's `~/develop/boilerplates/` tree. The agent IS the
 * thing that has those files, so extraction belongs here.
 *
 * Strategy: regex-based, same heuristics as the backend mirror would use.
 * Boilerplates are stable code we own — regex hits ~95% on well-formed
 * NestJS/Dart code, plenty for context priming.
 *
 * Cache: per-localPath in module-level Map. Process restarts clear it; for
 * boilerplate updates the user can manually delete the cached entry.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

const cache = new Map<string, string>();

/**
 * Phase 6 — persistent on-disk cache for boilerplate signature extraction.
 * Walking ~/develop/boilerplates/<id>/ and parsing all .ts/.dart files
 * costs 3-8 seconds; doing it once per process (in-memory cache only)
 * still re-parses on every CLI invocation. Persisting the markdown to
 * `.makestudio/cache/boilerplate-signatures.{key}.md` lets fresh process
 * restarts skip the re-walk for up to TTL_MS.
 */
const PERSIST_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function cacheFilePath(localPath: string, projectCwd: string | null): string {
  const key = crypto.createHash('sha256').update(localPath).digest('hex').slice(0, 16);
  const base = projectCwd
    ? path.join(projectCwd, '.makestudio', 'cache')
    : path.join(os.homedir(), '.makestudio', 'cache');
  return path.join(base, `boilerplate-signatures.${key}.md`);
}

function readPersistentCache(localPath: string, projectCwd: string | null): string | null {
  const file = cacheFilePath(localPath, projectCwd);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > PERSIST_TTL_MS) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function writePersistentCache(localPath: string, projectCwd: string | null, content: string): void {
  const file = cacheFilePath(localPath, projectCwd);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  } catch (err) { swallow(err); }
}

/**
 * Returns markdown signatures for a boilerplate, or empty string if the
 * path doesn't exist or extraction yields nothing.
 *
 * Boilerplate localPath examples:
 *   - /home/zielinski/develop/boilerplates/saas-multitenant-mobile
 *   - /opt/boilerplates/api-minimal
 *
 * The agent receives the boilerplateId from the backend dispatch and
 * resolves the local path via convention (`~/develop/boilerplates/<id>/`).
 *
 * The optional `projectCwd` lets the persistent cache live next to the
 * project (`.makestudio/cache/`) instead of the user's home dir — keeps
 * caches scoped per-project so a stack swap on one project doesn't
 * stale-feed another.
 */
export function extractBoilerplateSignatures(localPath: string, projectCwd: string | null = null): string {
  if (!localPath) return '';
  const cached = cache.get(localPath);
  if (cached !== undefined) return cached;

  // Try persistent cache first — same TTL as the backend regenerates the
  // boilerplate context, so 7 days is generous but safe.
  const persisted = readPersistentCache(localPath, projectCwd);
  if (persisted !== null) {
    cache.set(localPath, persisted);
    return persisted;
  }

  if (!fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) {
    cache.set(localPath, '');
    return '';
  }

  const layers = discoverLayers(localPath);
  const sections: string[] = [];

  for (const layer of layers) {
    const layerOutput = extractLayer(layer.path, layer.kind);
    if (layerOutput.trim()) {
      sections.push(`### ${layer.label}\n\n${layerOutput.trim()}`);
    }
  }

  if (sections.length === 0) {
    cache.set(localPath, '');
    return '';
  }

  const output = `## Auto-Extracted Signatures (READ-ONLY reference)

The following classes / methods / DTOs already exist in this boilerplate. **Use these signatures verbatim** when referencing existing code from a new task description. Do NOT invent alternative signatures for these classes.

${sections.join('\n\n')}`;
  cache.set(localPath, output);
  writePersistentCache(localPath, projectCwd, output);
  return output;
}

/** Force re-extraction on next call (in-memory + persistent cache). */
export function invalidateBoilerplateSignatures(localPath: string, projectCwd: string | null = null): void {
  cache.delete(localPath);
  try { fs.unlinkSync(cacheFilePath(localPath, projectCwd)); } catch (err) { swallow(err); }
}

/**
 * Try to resolve a boilerplate's local path from its id. We try common
 * conventions: `~/develop/boilerplates/<id>/`, `/opt/boilerplates/<id>/`.
 * Returns the first one that exists; null otherwise.
 */
export function resolveBoilerplateLocalPath(boilerplateId: string): string | null {
  if (!boilerplateId) return null;
  const candidates = [
    path.join(require('os').homedir(), 'develop', 'boilerplates', boilerplateId),
    path.join('/opt/boilerplates', boilerplateId),
    path.join('/usr/local/share/makestudio/boilerplates', boilerplateId),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch (err) { swallow(err); }
  }
  return null;
}

interface Layer { path: string; label: string; kind: 'ts' | 'dart' }

function discoverLayers(localPath: string): Layer[] {
  const layers: Layer[] = [];
  const candidates: Array<{ subdir: string; label: string; kind: 'ts' | 'dart' }> = [
    { subdir: 'api', label: 'Backend (api/)', kind: 'ts' },
    { subdir: 'web', label: 'Web (web/)', kind: 'ts' },
    { subdir: 'app', label: 'Mobile (app/)', kind: 'dart' },
    { subdir: 'mobile', label: 'Mobile (mobile/)', kind: 'dart' },
    { subdir: 'frontend', label: 'Frontend (frontend/)', kind: 'ts' },
    { subdir: 'backend', label: 'Backend (backend/)', kind: 'ts' },
    { subdir: 'src', label: 'Source (src/)', kind: 'ts' },
  ];
  for (const c of candidates) {
    const p = path.join(localPath, c.subdir);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      layers.push({ path: p, label: c.label, kind: c.kind });
    }
  }
  return layers;
}

function extractLayer(layerPath: string, kind: 'ts' | 'dart'): string {
  if (kind === 'ts') return extractTs(layerPath);
  return extractDart(layerPath);
}

function extractTs(layerPath: string): string {
  const files = collectFiles(layerPath, ['.ts', '.tsx'], [
    'node_modules', '.next', 'dist', 'build', '.git', 'coverage',
  ]);
  const services: string[] = [];
  const controllers: string[] = [];
  const entities: string[] = [];
  const dtos: string[] = [];
  const reactComponents: string[] = [];

  let total = 0;
  for (const file of files) {
    if (total >= 30) break;
    if (/\.spec\.tsx?$|\.test\.tsx?$|\.e2e-spec\.ts$/.test(file)) continue;

    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch { continue; }

    const rel = path.relative(layerPath, file);
    const blocks = parseTsBlocks(content, rel);
    for (const b of blocks) {
      if (b.kind === 'service') services.push(b.markdown);
      else if (b.kind === 'controller') controllers.push(b.markdown);
      else if (b.kind === 'entity') entities.push(b.markdown);
      else if (b.kind === 'dto') dtos.push(b.markdown);
      else if (b.kind === 'react') reactComponents.push(b.markdown);
      total++;
    }
  }

  const out: string[] = [];
  if (services.length) out.push(`**Services**\n${services.join('\n')}`);
  if (controllers.length) out.push(`**Controllers**\n${controllers.join('\n')}`);
  if (entities.length) out.push(`**Entities**\n${entities.join('\n')}`);
  if (dtos.length) out.push(`**DTOs**\n${dtos.join('\n')}`);
  if (reactComponents.length) out.push(`**React Components / Hooks**\n${reactComponents.join('\n')}`);
  return out.join('\n\n');
}

function parseTsBlocks(content: string, relPath: string): Array<{ kind: 'service' | 'controller' | 'entity' | 'dto' | 'react'; markdown: string }> {
  const blocks: Array<{ kind: any; markdown: string }> = [];

  // 1. NestJS @Injectable / @Controller / @Entity / @Schema
  const classRe = /@(Injectable|Controller|Entity|Schema)\s*\([^)]*\)\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)([\s\S]*?)(?=^\}\s*$|\n@\w+|^export\s+class)/gm;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(content)) !== null) {
    const decorator = m[1];
    const className = m[2];
    const body = m[3];
    const kind: 'service' | 'controller' | 'entity' = decorator === 'Controller'
      ? 'controller'
      : decorator === 'Entity' || decorator === 'Schema'
      ? 'entity'
      : 'service';

    const methods: string[] = [];
    const methodRe = /\n  (?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*([^{=;\n]+))?\s*\{/g;
    const tsKeywords = new Set([
      'if', 'while', 'for', 'switch', 'return', 'throw', 'try', 'catch', 'finally',
      'else', 'do', 'with', 'typeof', 'instanceof', 'new', 'delete', 'void',
      'constructor', 'super', 'this', 'await', 'async', 'function', 'yield',
    ]);
    let mm: RegExpExecArray | null;
    while ((mm = methodRe.exec(body)) !== null) {
      const name = mm[1];
      if (!name || name.startsWith('_')) continue;
      if (tsKeywords.has(name)) continue;
      if (/^(then|catch|finally|toString|valueOf|hasOwnProperty)$/.test(name)) continue;
      const args = (mm[2] || '').replace(/\s+/g, ' ').trim();
      const ret = (mm[3] || '').replace(/\s+/g, ' ').trim();
      const idx = mm.index;
      const before = body.slice(Math.max(0, idx - 20), idx + 4);
      const isAsync = /\basync\s*$/.test(before) || /\n  async\s+\w/.test(body.slice(idx, idx + 100));
      const sig = `${isAsync ? 'async ' : ''}${name}(${args})${ret ? `: ${ret}` : ''}`;
      methods.push(sig);
      if (methods.length >= 8) break;
    }

    const routes: string[] = [];
    if (kind === 'controller') {
      const routeRe = /@(Get|Post|Put|Patch|Delete)\s*\(\s*['"`]([^'"`]*)['"`]?\s*\)/g;
      let rm: RegExpExecArray | null;
      while ((rm = routeRe.exec(body)) !== null) {
        routes.push(`${rm[1].toUpperCase()} ${rm[2] || '/'}`);
        if (routes.length >= 8) break;
      }
    }

    const columns: string[] = [];
    if (kind === 'entity') {
      const colRe = /@Column\s*\(([^)]*)\)\s*(\w+)\s*:\s*([^;\n]+)/g;
      let cm: RegExpExecArray | null;
      while ((cm = colRe.exec(body)) !== null) {
        const opts = cm[1].replace(/\s+/g, ' ').trim();
        columns.push(`${cm[2]}: ${cm[3].trim().replace(/[;,]$/, '')}${opts ? ` (${opts.slice(0, 60)})` : ''}`);
        if (columns.length >= 12) break;
      }
    }

    const md = formatTsBlock({ className, kind, decorator, relPath, methods, routes, columns });
    blocks.push({ kind, markdown: md });
  }

  // 2. DTO classes
  const dtoRe = /(?:^|\n)export\s+class\s+(\w+(?:Dto|Input|Output|Request|Response))[\s\S]*?(?=\n(?:export\s+(?:class|interface|enum)|$))/g;
  let dm: RegExpExecArray | null;
  while ((dm = dtoRe.exec(content)) !== null) {
    const dtoName = dm[1];
    const body = dm[0];
    const fields: string[] = [];
    const fieldRe = /\n\s+(?:@\w+(?:\([^)]*\))?\s*\n\s+)*(\w+)(?:\?)?\s*[:!]\s*([^;\n]+)/g;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(body)) !== null) {
      if (fm[1] === 'constructor') continue;
      fields.push(`${fm[1]}: ${fm[2].trim().replace(/[;,]$/, '')}`);
      if (fields.length >= 8) break;
    }
    blocks.push({
      kind: 'dto',
      markdown: `- \`${dtoName}\` _(${relPath})_\n${fields.map((f) => `  - \`${f}\``).join('\n')}`,
    });
  }

  // 3. React components / hooks
  if (/use[A-Z]\w+|export.*function\s+[A-Z]\w+|<\w+/.test(content)) {
    const compRe = /export\s+(?:default\s+)?function\s+([A-Z]\w*)\s*\(([^)]*)\)/g;
    let cm: RegExpExecArray | null;
    while ((cm = compRe.exec(content)) !== null) {
      const name = cm[1];
      const args = (cm[2] || '').replace(/\s+/g, ' ').trim();
      blocks.push({
        kind: 'react',
        markdown: `- \`${name}(${args.length > 60 ? 'props' : args})\` _(${relPath})_`,
      });
    }
    const hookRe = /export\s+(?:const|function)\s+(use[A-Z]\w*)\s*[=(]/g;
    let hm: RegExpExecArray | null;
    while ((hm = hookRe.exec(content)) !== null) {
      blocks.push({
        kind: 'react',
        markdown: `- hook \`${hm[1]}\` _(${relPath})_`,
      });
    }
  }

  return blocks;
}

function formatTsBlock(args: {
  className: string;
  kind: 'service' | 'controller' | 'entity';
  decorator: string;
  relPath: string;
  methods: string[];
  routes: string[];
  columns: string[];
}): string {
  const head = `- \`${args.className}\` _(${args.relPath})_`;
  const lines: string[] = [head];
  if (args.kind === 'controller' && args.routes.length) {
    lines.push(`  - routes: ${args.routes.join(', ')}`);
  }
  if (args.kind === 'entity' && args.columns.length) {
    for (const c of args.columns) lines.push(`  - \`${c}\``);
  }
  if (args.methods.length) {
    for (const meth of args.methods) lines.push(`  - \`${meth}\``);
  }
  return lines.join('\n');
}

function extractDart(layerPath: string): string {
  const files = collectFiles(layerPath, ['.dart'], [
    '.dart_tool', 'build', '.git', 'ios', 'android', 'macos', 'windows', 'linux', 'web',
  ]);
  const blocks: Array<{ name: string; rel: string; kind: string; methods: string[] }> = [];
  let total = 0;

  for (const file of files) {
    if (total >= 30) break;
    if (/_test\.dart$/.test(file)) continue;
    let content = '';
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch { continue; }
    const rel = path.relative(layerPath, file);

    const classRe = /class\s+(\w+)\s+(?:extends\s+(\w+))?[\s\S]*?(?=\nclass\s|\Z|$)/g;
    let m: RegExpExecArray | null;
    while ((m = classRe.exec(content)) !== null) {
      const name = m[1];
      const extendsClass = m[2] || '';
      if (name.startsWith('_')) continue;

      const classBody = m[0];
      const methods: string[] = [];
      const methodRe = /(?:^|\n)\s+(?:Future<[^>]+>|void|String|int|bool|[A-Z]\w*<?[^>(]*>?)\s+(\w+)\s*\(([^)]*)\)/g;
      let mm: RegExpExecArray | null;
      while ((mm = methodRe.exec(classBody)) !== null) {
        const mname = mm[1];
        if (!mname || mname.startsWith('_')) continue;
        if (/^(build|toString|operator|hashCode)$/.test(mname)) continue;
        const args = (mm[2] || '').replace(/\s+/g, ' ').trim();
        methods.push(`${mname}(${args.length > 80 ? '...' : args})`);
        if (methods.length >= 6) break;
      }

      if (methods.length === 0 && extendsClass !== 'StatelessWidget' && extendsClass !== 'StatefulWidget' && extendsClass !== 'ChangeNotifier') {
        continue;
      }

      const kind = extendsClass === 'StatelessWidget' || extendsClass === 'StatefulWidget'
        ? 'Widget'
        : extendsClass === 'ChangeNotifier'
        ? 'Provider'
        : 'Class';

      blocks.push({ name, rel, kind: extendsClass ? `${kind} extends ${extendsClass}` : kind, methods });
      total++;
    }
  }

  if (blocks.length === 0) return '';
  const lines: string[] = [];
  for (const b of blocks) {
    lines.push(`- \`${b.name}\` (${b.kind}) _(${b.rel})_`);
    for (const m of b.methods) lines.push(`  - \`${m}\``);
  }
  return lines.join('\n');
}

function collectFiles(root: string, exts: string[], skipDirs: string[]): string[] {
  const out: string[] = [];
  const skip = new Set(skipDirs);
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || out.length > 200) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.makestudio') continue;
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (exts.some((ext) => e.name.endsWith(ext))) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}
