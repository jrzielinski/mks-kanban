import { swallow } from '../utils/log';
/**
 * CLAUDE.md / AGENT.md auto-import at startup.
 *
 * Scans the cwd (and up to 3 parent levels) for CLAUDE.md/claude.md or
 * AGENT.md/agent.md. Returns the first match found, closest to cwd first.
 *
 * The imported content is stored in ctx.importedRules and injected into
 * the dynamic half of the system prompt so the LLM honours project-specific
 * constraints without the user repeating them every session.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export interface ImportCandidate {
  filePath: string;
  fileName: string;
  sizeBytes: number;
}

const MAX_COMPACT_CHARS = 8 * 1024;
const HEADING_TRANSLATIONS: Record<string, string> = {
  'Claude Config': 'Claude Config',
  'MakeStudio REPL — Tool Catalog': 'MakeStudio REPL — Tool Catalog',
  'Configurações do Projeto': 'Project Configuration',
  'Regras Importantes': 'Important Rules',
  'Compilação e Verificação de Código': 'Compilation and Code Verification',
  'Layout e UI': 'Layout and UI',
  'Qualidade de Código — TOLERÂNCIA ZERO A BUGS': 'Code Quality — ZERO BUG TOLERANCE',
  'Credenciais de Teste': 'Test Credentials',
  'Servidores': 'Servers',
  'Execução do Backend': 'Backend Execution',
  'Migrations — OBRIGATÓRIO': 'Migrations — REQUIRED',
  'Scripts de Deploy (SOMENTE quando José Roberto solicitar)': 'Deploy Scripts (ONLY when José Roberto explicitly asks)',
  'Arquitetura de Módulos': 'Module Architecture',
  'FlowBuilder Knowledge': 'FlowBuilder Knowledge',
};

const PHRASE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bJosé Roberto\b/g, 'José Roberto'],
  [/\bPT-BR\b/g, 'pt-BR'],
  [/PROMPTS DE LLM SEMPRE EM INGLÊS/gi, 'LLM prompts must always be in English'],
  [/NUNCA EXECUTAR O BACKEND/gi, 'never start the backend'],
  [/PROIBIDO FAZER DEPLOY/gi, 'forbidden deploy unless explicitly requested'],
  [/Ao implementar funcionalidades, garanta que todas as partes estejam integradas corretamente\. Se o OAuth2 já existe, USE-O\./gi, 'complete integration: ensure all parts are integrated correctly. If OAuth2 already exists, use it.'],
  [/\bNUNCA\b/g, 'NEVER'],
  [/\bJAMAIS\b/g, 'NEVER'],
  [/\bSEMPRE\b/g, 'ALWAYS'],
  [/\bOBRIGATÓRIO\b/g, 'REQUIRED'],
  [/\bPROIBIDO\b/g, 'FORBIDDEN'],
  [/\bTERMINANTEMENTE PROIBIDO\b/g, 'STRICTLY FORBIDDEN'],
  [/\bbackend\b/g, 'backend'],
  [/\bfrontend\b/g, 'frontend'],
  [/\bresponder sempre em português brasileiro\b/gi, 'always respond in Brazilian Portuguese'],
  [/\busar terminologia técnica apropriada em português brasileiro\b/gi, 'use appropriate Brazilian Portuguese technical terminology'],
  [/\bmanter consistência na comunicação\b/gi, 'keep communication consistent'],
  [/\bprompts de llm sempre em inglês\b/gi, 'LLM prompts must always be in English'],
  [/\bresposta no idioma do sistema\/usuário\b/gi, 'respond in the system/user language'],
  [/\btraduzir prompts existentes\b/gi, 'translate existing prompts'],
  [/\bverificação per-arquivo\b/gi, 'per-file verification'],
  [/\bverificação cross-file\b/gi, 'cross-file verification'],
  [/\bverificação alternativa de sintaxe\b/gi, 'alternative syntax verification'],
  [/\bnunca instalar dependências\b/gi, 'never install dependencies'],
  [/\btelas devem ocupar 100% da largura\b/gi, 'screens must use 100% width'],
  [/\bqualidade de código\b/gi, 'code quality'],
  [/\bzero bugs é a única meta aceitável\b/gi, 'zero bugs is the only acceptable goal'],
  [/\bsempre corrigir bugs\b/gi, 'always fix bugs'],
  [/\bcorrigir todos os erros encontrados\b/gi, 'fix every error found'],
  [/\bnunca deixar código quebrado\b/gi, 'never leave broken code'],
  [/\bintegração completa\b/gi, 'complete integration'],
  [/\bnunca usar `alert\(\)` ou `prompt\(\)`\b/gi, 'never use `alert()` or `prompt()`'],
  [/\bnunca usar `confirm\(\)` nativo\b/gi, 'never use native `confirm()`'],
  [/\bservidor de desenvolvimento\b/gi, 'development server'],
  [/\bservidor de produção\b/gi, 'production server'],
  [/\bnunca executar o backend\b/gi, 'never start the backend'],
  [/\bproibido fazer deploy\b/gi, 'deploy is forbidden unless explicitly requested'],
  [/\bregra de ouro - commits limpos\b/gi, 'golden rule - clean commits'],
  [/\bcommits em inglês\b/gi, 'commits must be in English'],
  [/\bflutter com fvm\b/gi, 'Flutter with FVM'],
  [/\bmigrations\b/gi, 'migrations'],
  [/\barquitetura de módulos\b/gi, 'module architecture'],
  [/\bflowbuilder knowledge\b/gi, 'FlowBuilder knowledge'],
  [/\bresponder\b/gi, 'respond'],
  [/\busar\b/gi, 'use'],
  [/\bmanter\b/gi, 'keep'],
  [/\btraduzir\b/gi, 'translate'],
  [/\bsempre\b/gi, 'always'],
  [/\bnunca\b/gi, 'never'],
  [/\bjamais\b/gi, 'never'],
  [/\bdeve\b/gi, 'must'],
  [/\bdevem\b/gi, 'must'],
  [/\bobrigatório\b/gi, 'required'],
  [/\bproibido\b/gi, 'forbidden'],
  [/\berros?\b/gi, 'errors'],
  [/\bcódigo\b/gi, 'code'],
  [/\bcomandos?\b/gi, 'commands'],
  [/\barquivo\b/gi, 'file'],
  [/\barquivos\b/gi, 'files'],
  [/\blocalmente\b/gi, 'locally'],
  [/\bprodução\b/gi, 'production'],
  [/\bdesenvolvimento\b/gi, 'development'],
  [/\bservidor\b/gi, 'server'],
  [/\bidioma\b/gi, 'language'],
];

function translateHeading(text: string): string {
  return HEADING_TRANSLATIONS[text.trim()] || text.trim();
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function translateSentence(text: string): string {
  let out = compactWhitespace(text)
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '`$1`');
  for (const [pattern, replacement] of PHRASE_REPLACEMENTS) out = out.replace(pattern, replacement);
  return out.replace(/\s+([:;,.])/g, '$1').trim();
}

function canonicalizeRuleLine(text: string): string {
  const clean = translateSentence(text)
    .replace(/^[-*]\s*/, '')
    .replace(/^\d+\.\s*/, '');
  if (!clean) return '';
  const upper = clean.toUpperCase();
  if (upper.includes('STRICTLY FORBIDDEN') || upper.includes('FORBIDDEN') || upper.includes('NEVER')) {
    return `- NEVER: ${clean.replace(/^(STRICTLY FORBIDDEN|FORBIDDEN|NEVER)\s*:?\s*/i, '')}`;
  }
  if (upper.includes('REQUIRED') || upper.includes('ALWAYS') || upper.includes('MUST')) {
    return `- ALWAYS: ${clean.replace(/^(REQUIRED|ALWAYS|MUST)\s*:?\s*/i, '')}`;
  }
  return `- ${clean}`;
}

export function compactImportedRules(raw: string, fileName: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [
    `# Imported Project Rules (${fileName})`,
    '',
    'Compacted for prompt efficiency. Preserve these rules as hard constraints.',
    '',
  ];

  let paragraph: string[] = [];
  let inFence = false;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const joined = compactWhitespace(paragraph.join(' '));
    if (joined) out.push(canonicalizeRuleLine(joined));
    paragraph = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimRight();
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flushParagraph();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      if (trimmed) out.push(`- Command/example: ${trimmed}`);
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      if (out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      flushParagraph();
      const hashes = trimmed.match(/^#{1,6}/)?.[0] || '#';
      const title = trimmed.replace(/^#{1,6}\s+/, '');
      out.push(`${hashes} ${translateHeading(title)}`);
      continue;
    }
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      flushParagraph();
      out.push(canonicalizeRuleLine(trimmed));
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();

  const compacted = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (compacted.length <= MAX_COMPACT_CHARS) return compacted;
  return compacted.slice(0, MAX_COMPACT_CHARS) + '\n\n[... compacted rules truncated for prompt budget ...]';
}

// Check all case variants — macOS HFS+ is case-insensitive but Linux/VPS is not.
const CANDIDATE_NAMES = ['AGENT.md', 'agent.md', 'CLAUDE.md', 'claude.md'];
const MAX_PARENT_DEPTH = 3;
const MAX_FILE_SIZE = 64 * 1024; // 64 KB — cap to avoid token explosion

/**
 * Walk cwd → parent dirs, return the first matching config file found.
 */
export function findImportCandidate(cwd: string): ImportCandidate | null {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth <= MAX_PARENT_DEPTH; depth++) {
    for (const name of CANDIDATE_NAMES) {
      const candidate = path.join(dir, name);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && stat.size > 0) {
          return { filePath: candidate, fileName: name, sizeBytes: stat.size };
        }
      } catch (err) { swallow(err); }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Read and return file content, capped at MAX_FILE_SIZE.
 */
export function readImportFile(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf8');
  const capped = raw.length <= MAX_FILE_SIZE
    ? raw
    : raw.slice(0, MAX_FILE_SIZE) + '\n\n[... truncated at 64 KB — use the Read tool for the full file ...]';
  return compactImportedRules(capped, path.basename(filePath));
}

/**
 * Ask the user (via stdin/stdout, BEFORE Ink mounts) whether to import rules.
 * Returns true on "y/Y/yes/Enter", false on "n/no" or anything else.
 * Non-interactive stdin (piped): skips automatically after 500 ms.
 */
export async function askImport(candidate: ImportCandidate): Promise<boolean> {
  // Non-interactive stdin — skip silently (e.g. piped input, CI).
  if (!process.stdin.isTTY) return false;

  return new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const kb = Math.round(candidate.sizeBytes / 1024);
    const sizeLabel = kb > 0 ? `${kb} KB` : `${candidate.sizeBytes} B`;
    process.stdout.write(
      `  Found ${candidate.fileName} (${sizeLabel}) at ${candidate.filePath}\n` +
      `  Import rules into this session? [Y/n] `,
    );
    rl.once('line', (line) => {
      rl.close();
      const answer = line.trim().toLowerCase();
      resolve(answer === '' || answer === 'y' || answer === 'yes');
    });
  });
}
