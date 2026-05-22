import { swallow } from '../utils/log';
/**
 * boilerplate-manifest.ts — schema + parser para `boilerplate.yaml`.
 *
 * Spec opcional: cada boilerplate pode incluir um `boilerplate.yaml` na raiz
 * que descreve prompts dinâmicos (`projectName`, `dbHost`, etc.) coletados
 * pelo wizard da BoilerplatesPage. Quando o usuário aplica o boilerplate, as
 * respostas são substituídas em arquivos texto via {{var}} placeholders.
 *
 * Quando o YAML não existe, o boilerplate aplica como antes — copy puro,
 * sem prompts. Logo é estritamente aditivo / opt-in.
 *
 * Schema (YAML):
 *   prompts:
 *     - name: projectName
 *       type: text                # text | choice | boolean
 *       description: "Project name (becomes the npm package name)"
 *       required: true
 *       default: "my-app"
 *     - name: dbProvider
 *       type: choice
 *       description: "Which database to scaffold"
 *       choices: [postgres, mysql, sqlite]
 *       default: postgres
 *   postSetup:
 *     command: "npm"
 *     args: ["install"]
 *
 * Os prompts ficam em ordem de declaração — o wizard apresenta na mesma
 * ordem. `required: true` força resposta antes de avançar.
 */

import * as fs from 'fs';
import * as path from 'path';

export type BoilerplatePromptType = 'text' | 'choice' | 'boolean';

export interface BoilerplatePrompt {
  name: string;
  type: BoilerplatePromptType;
  description: string;
  required: boolean;
  default?: string;
  choices?: string[];
}

export interface BoilerplatePostSetup {
  command: string;
  args?: string[];
}

export interface BoilerplateManifest {
  prompts: BoilerplatePrompt[];
  postSetup?: BoilerplatePostSetup;
}

const MANIFEST_NAMES = ['boilerplate.yaml', 'boilerplate.yml'];

function findManifestFile(boilerplatePath: string): string | null {
  for (const name of MANIFEST_NAMES) {
    const candidate = path.join(boilerplatePath, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Parser YAML mínimo — suficiente pro shape da spec acima. Não tenta cobrir
 * YAML completo; foca em dois níveis (mapping + sequence) com strings,
 * booleans e listas inline `[a, b]`. Falha graciosamente em construções
 * exóticas retornando manifest vazio.
 */
function parseYamlMini(text: string): any {
  const out: any = {};
  const lines = text.split(/\r?\n/);
  // Pre-strip CR + comments (after #) e blanks.
  const tokens: Array<{ indent: number; line: string }> = [];
  for (const raw of lines) {
    // Comment line ignored entirely.
    if (/^\s*#/.test(raw)) continue;
    // Inline trailing # (only when not inside quotes — naïve heuristic ok pra spec).
    let line = raw;
    if (!/['"]/.test(line)) line = line.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    tokens.push({ indent, line: line.slice(indent) });
  }

  let i = 0;
  // Recursive descent: parse a "mapping at indent N".
  const parseScalar = (raw: string): any => {
    const v = raw.trim();
    if (v === '') return '';
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v.startsWith('[') && v.endsWith(']')) {
      const inner = v.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(',').map((s) => parseScalar(s.replace(/^["']|["']$/g, '')));
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    return v;
  };

  const parseMapping = (baseIndent: number): any => {
    const obj: any = {};
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.indent < baseIndent) break;
      if (t.indent > baseIndent) break;
      const m = t.line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1];
      const inline = m[2];
      i++;
      if (inline.trim() === '') {
        // Block value follows — could be mapping ou list.
        if (i < tokens.length && tokens[i].indent > baseIndent) {
          const childIndent = tokens[i].indent;
          // Detect list: lines start with `- `.
          if (tokens[i].line.startsWith('- ')) {
            obj[key] = parseList(childIndent);
          } else {
            obj[key] = parseMapping(childIndent);
          }
        } else {
          obj[key] = '';
        }
      } else {
        obj[key] = parseScalar(inline);
      }
    }
    return obj;
  };

  const parseList = (baseIndent: number): any[] => {
    const arr: any[] = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.indent < baseIndent) break;
      if (t.indent > baseIndent) break;
      if (!t.line.startsWith('- ')) break;
      const rest = t.line.slice(2);
      i++;
      // Item is inline scalar OR inline mapping (`name: foo`)?
      const inlineKv = rest.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      if (inlineKv) {
        const item: any = {};
        item[inlineKv[1]] = parseScalar(inlineKv[2]);
        // Continue absorbing children at deeper indent into this item.
        while (i < tokens.length && tokens[i].indent > baseIndent && !tokens[i].line.startsWith('- ')) {
          const childIndent = tokens[i].indent;
          const sub = parseMapping(childIndent);
          for (const [k, v] of Object.entries(sub)) item[k] = v;
        }
        arr.push(item);
      } else {
        arr.push(parseScalar(rest));
      }
    }
    return arr;
  };

  Object.assign(out, parseMapping(0));
  return out;
}

/**
 * Carrega `boilerplate.yaml` de um boilerplate. Retorna `null` quando o
 * arquivo não existe — boilerplate é aplicado como copy puro nesse caso.
 */
export function loadBoilerplateManifest(boilerplatePath: string): BoilerplateManifest | null {
  const file = findManifestFile(boilerplatePath);
  if (!file) return null;
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  let parsed: any;
  try { parsed = parseYamlMini(raw); } catch { return null; }
  const prompts: BoilerplatePrompt[] = Array.isArray(parsed?.prompts)
    ? parsed.prompts.map((p: any) => ({
        name: String(p.name ?? '').trim(),
        type: (p.type === 'choice' || p.type === 'boolean') ? p.type : 'text',
        description: String(p.description ?? ''),
        required: Boolean(p.required),
        default: p.default !== undefined ? String(p.default) : undefined,
        choices: Array.isArray(p.choices) ? p.choices.map(String) : undefined,
      })).filter((p: BoilerplatePrompt) => p.name.length > 0)
    : [];
  let postSetup: BoilerplatePostSetup | undefined;
  if (parsed?.postSetup && typeof parsed.postSetup === 'object') {
    const cmd = String(parsed.postSetup.command ?? '').trim();
    if (cmd) {
      postSetup = {
        command: cmd,
        args: Array.isArray(parsed.postSetup.args) ? parsed.postSetup.args.map(String) : undefined,
      };
    }
  }
  return { prompts, postSetup };
}

// ── Template substitution ─────────────────────────────────────────────

/** Heuristic: skip binary files (images, archives, fonts, etc.) durante o
 *  walk de substituição. Substituir bytes em binários quebra o arquivo. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.pdf', '.mov', '.mp4', '.mp3', '.wav',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.so', '.dylib', '.dll', '.exe',
  '.class', '.jar', '.pyc',
]);

function isBinaryByExt(file: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/**
 * Substitui {{varName}} em `content` usando `answers`. Variáveis ausentes
 * ficam intactas (não viram string vazia) — assim arquivos com `{{ }}` que
 * não são placeholders nossos (Vue/Handlebars/JSX) sobrevivem quando o
 * boilerplate.yaml não declarou prompts pra eles.
 */
export function applyTemplateVars(content: string, answers: Record<string, string>): string {
  return content.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, varName: string) => {
    if (Object.prototype.hasOwnProperty.call(answers, varName)) {
      return answers[varName];
    }
    return match;
  });
}

export interface ApplyManifestProgressEvent {
  phase: 'walk' | 'replace' | 'postSetup' | 'done';
  file?: string;
  filesProcessed?: number;
  totalFiles?: number;
  log?: string;
}

export type ApplyManifestProgressCallback = (event: ApplyManifestProgressEvent) => void;

/**
 * Walk recursivo em `targetDir` aplicando `applyTemplateVars` em arquivos
 * texto. Pula binários por extensão e diretórios `.git`/`node_modules`.
 * Não toca em arquivos sem placeholders (read-only se nada bater).
 */
export async function applyManifestSubstitutions(
  targetDir: string,
  answers: Record<string, string>,
  onProgress?: ApplyManifestProgressCallback,
): Promise<{ filesChanged: number; filesScanned: number }> {
  const allFiles: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) allFiles.push(full);
    }
  };
  walk(targetDir);
  onProgress?.({ phase: 'walk', totalFiles: allFiles.length });

  let filesChanged = 0;
  let i = 0;
  for (const file of allFiles) {
    i++;
    if (isBinaryByExt(file)) continue;
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const next = applyTemplateVars(raw, answers);
    if (next !== raw) {
      try {
        fs.writeFileSync(file, next, 'utf8');
        filesChanged++;
        onProgress?.({ phase: 'replace', file, filesProcessed: i, totalFiles: allFiles.length });
      } catch (err) { swallow(err); }
    }
  }
  return { filesChanged, filesScanned: allFiles.length };
}
