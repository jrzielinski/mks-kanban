/**
 * Shared helpers used by tool handlers (extracted from tools.ts so the
 * per-topic handler modules don't depend on the giant tools.ts file).
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

/**
 * Find a project match using the AI-provided name OR by scanning the
 * user's last message for any known project name. Handles small models
 * that fail to pass arguments to tools.
 */
export async function findProjectMatch(
  providedName: string | undefined,
  userMessage: string,
  projects: any[],
): Promise<any | null> {
  if (providedName && typeof providedName === 'string' && providedName.trim()) {
    const n = providedName.toLowerCase().trim();
    const match = projects.find((p: any) =>
      p.name.toLowerCase() === n ||
      p.name.toLowerCase().includes(n) ||
      n.includes(p.name.toLowerCase()),
    );
    if (match) return match;
  }
  if (userMessage) {
    const msg = userMessage.toLowerCase();
    const sorted = [...projects].sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0));
    for (const p of sorted) {
      if (!p.name) continue;
      if (msg.includes(p.name.toLowerCase())) return p;
    }
  }
  return null;
}

export function safePath(projectPath: string, filePath: string): string {
  const resolved = path.resolve(projectPath, filePath);
  if (!resolved.startsWith(path.resolve(projectPath))) {
    throw new Error('Path traversal blocked');
  }
  return resolved;
}

export function truncate(text: string, maxLen: number = 3000): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n... (truncated, ${text.length - maxLen} chars omitted)`;
}

/**
 * Defensive array extraction from any API response shape:
 *   { data: [...] } | { items: [...] } | { dums: [...] } | { tasks: [...] } | [...]
 */
export function asArray(raw: any, ...keys: string[]): any[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  for (const k of ['data', 'items', ...keys]) {
    if (Array.isArray(raw[k])) return raw[k];
  }
  return [];
}

// ── Fallback grep-based implementations for when LSP is unavailable ──

export async function fallbackGrepDefinition(projectPath: string, sym: string): Promise<string> {
  const patterns = [
    `^\\s*(?:export\\s+)?(?:abstract\\s+)?(?:class|interface|enum|type|function|const|let|var)\\s+${sym}\\b`,
    `^\\s*(?:abstract\\s+)?(?:class|enum|mixin|extension)\\s+${sym}\\b`,
  ];
  try {
    const out = execSync(
      `grep -rnE --include='*.ts' --include='*.tsx' --include='*.dart' --include='*.js' "${patterns.join('|')}" "${projectPath}" 2>/dev/null | head -20`,
      { shell: '/bin/sh', timeout: 15_000 },
    ).toString();
    if (!out.trim()) return JSON.stringify({ symbol: sym, found: false, source: 'grep-fallback' });
    const matches = out.trim().split('\n').map((line) => {
      const m = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!m) return null;
      return { file: path.relative(projectPath, m[1]), line: parseInt(m[2], 10), code: m[3].trim() };
    }).filter(Boolean);
    return JSON.stringify({ symbol: sym, found: matches.length > 0, source: 'grep-fallback', matches }, null, 2);
  } catch (err: any) {
    return JSON.stringify({ error: err.message?.substring(0, 200), source: 'grep-fallback' });
  }
}

export async function fallbackGrepReferences(projectPath: string, sym: string): Promise<string> {
  try {
    const out = execSync(
      `grep -rnE --include='*.ts' --include='*.tsx' --include='*.dart' --include='*.js' "\\b${sym}\\b" "${projectPath}" 2>/dev/null | head -50`,
      { shell: '/bin/sh', timeout: 15_000 },
    ).toString();
    if (!out.trim()) return JSON.stringify({ symbol: sym, count: 0, source: 'grep-fallback' });
    const refs = out.trim().split('\n').map((line) => {
      const m = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!m) return null;
      const code = m[3].trim();
      let kind = 'usage';
      if (/^(import|export)\s/.test(code)) kind = 'import';
      else if (new RegExp(`^\\s*(?:export\\s+)?(?:abstract\\s+)?(?:class|interface|enum|type|function|mixin|extension)\\s+${sym}\\b`).test(code)) kind = 'definition';
      else if (new RegExp(`new\\s+${sym}\\b`).test(code)) kind = 'instantiation';
      return { file: path.relative(projectPath, m[1]), line: parseInt(m[2], 10), kind, code };
    }).filter(Boolean);
    return truncate(JSON.stringify({ symbol: sym, count: refs.length, source: 'grep-fallback', references: refs }, null, 2));
  } catch (err: any) {
    return JSON.stringify({ error: err.message?.substring(0, 200), source: 'grep-fallback' });
  }
}

export async function fallbackGrepSymbols(absPath: string, relPath: string): Promise<string> {
  const content = fs.readFileSync(absPath, 'utf8');
  const symbols: Array<{ name: string; kind: string; line: number }> = [];
  const lines = content.split('\n');
  const isDart = relPath.endsWith('.dart');
  const patterns: Array<{ re: RegExp; kind: string }> = isDart ? [
    { re: /^\s*(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_]*)/, kind: 'class' },
    { re: /^\s*enum\s+([A-Z][A-Za-z0-9_]*)/, kind: 'enum' },
    { re: /^\s*mixin\s+([A-Z][A-Za-z0-9_]*)/, kind: 'mixin' },
    { re: /^\s*extension\s+([A-Z][A-Za-z0-9_]*)/, kind: 'extension' },
  ] : [
    { re: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_]*)/, kind: 'class' },
    { re: /^(?:export\s+)?interface\s+([A-Z][A-Za-z0-9_]*)/, kind: 'interface' },
    { re: /^(?:export\s+)?enum\s+([A-Z][A-Za-z0-9_]*)/, kind: 'enum' },
    { re: /^(?:export\s+)?type\s+([A-Z][A-Za-z0-9_]*)/, kind: 'type' },
    { re: /^(?:export\s+)?function\s+([a-zA-Z_][A-Za-z0-9_]*)/, kind: 'function' },
    { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Z_][A-Z_0-9]*)\s*=/, kind: 'constant' },
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const p of patterns) {
      const m = lines[i].match(p.re);
      if (m) { symbols.push({ name: m[1], kind: p.kind, line: i + 1 }); break; }
    }
  }
  return JSON.stringify({ file: relPath, source: 'grep-fallback', symbols }, null, 2);
}

/**
 * Build a hint for the model when an unknown tool name was attempted.
 * Lists the 5 closest tool names by Levenshtein distance + the MCP
 * prefix pattern so the model self-corrects without our intervention.
 */
export function buildUnknownToolHint(attempted: string, allNames: string[]): string {
  const distance = (a: string, b: string): number => {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[m][n];
  };
  const scored = allNames
    .map((n) => ({ n, d: distance(attempted, n) }))
    .filter((x) => x.d <= 4)
    .sort((a, b) => a.d - b.d)
    .slice(0, 5);
  const lines: string[] = [];
  if (scored.length > 0) {
    lines.push(`Closest matches: ${scored.map((s) => s.n).join(', ')}.`);
  }
  if (!attempted.includes('.')) {
    lines.push(`If you meant an MCP tool, the format is "<server>.<tool>" (e.g. "filesystem.read"). Run mcp_list_servers to see available namespaces.`);
  }
  lines.push(`Use ToolSearch with a keyword to discover available tools.`);
  return lines.join(' ');
}
