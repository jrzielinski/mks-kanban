/**
 * Bash security — AST-based command analysis.
 *
 * Uses bash-parser to get a proper AST of shell input, then walks commands
 * to classify each by risk. Handles: pipes, redirects, subshells, env vars,
 * compound commands (&&, ||, ;), process substitution.
 *
 * Classification: safe (read-only) / warn / dangerous.
 */

export type CommandRisk = 'safe' | 'warn' | 'dangerous';

export interface SecurityCheck {
  risk: CommandRisk;
  reasons: string[];
  commands: string[]; // individual commands found in the AST
  command: string;    // original input
}

// Commands that only READ filesystem/process state
const SAFE_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ripgrep',
  'find', 'fd', 'locate', 'which', 'whereis', 'file', 'stat', 'wc', 'du', 'df',
  'echo', 'printf', 'pwd', 'env', 'printenv', 'date', 'uname', 'hostname', 'whoami', 'id',
  'ps', 'top', 'htop', 'free', 'uptime', 'lsof', 'netstat', 'ss', 'ip', 'ifconfig',
  'awk', 'sed', 'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'xargs', 'tee',
  'diff', 'cmp', 'md5sum', 'sha256sum', 'sha1sum',
  'true', 'false', 'test', '[', ':', 'type', 'command', 'hash',
  'history', 'alias', 'pwd', 'dirs', 'pushd', 'popd',
  // Shell builtins — no real effect outside the spawned bash subprocess.
  // Without these the warning "comando desconhecido: cd" fires every time
  // the model writes the standard `cd /repo && git ...` pattern.
  'cd', 'set', 'unset', 'export', 'local', 'declare', 'readonly', 'shift',
  'getopts', 'exit', 'return', 'wait', 'jobs', 'fg', 'bg',
  'sleep', 'tput', 'clear', 'reset', 'stty',
  'basename', 'dirname', 'realpath', 'readlink',
  // Type-checkers / linters / test runners — read-only on the codebase.
  'tsc', 'eslint', 'vitest', 'jest', 'tsx', 'ts-node',
  // (intentionally excluded: eval, exec, kill, trap — these are real
  // attack surfaces or destructive and should keep warning behaviour.)
]);

// Commands that MODIFY local state but not destructive
const WRITE_COMMANDS = new Set([
  'cp', 'mv', 'mkdir', 'touch', 'ln',
  'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'bzip2',
  'node', 'python', 'python3', 'ruby', 'go', 'npx', 'npm', 'yarn', 'pnpm', 'bun',
  'docker', 'docker-compose', 'kubectl',
  'ssh', 'scp', 'rsync',
  'make', 'cmake', 'gcc', 'clang',
  'git', 'hg', 'svn',
  'fvm', 'flutter', 'dart', 'gradle', 'mvn',
  'sqlite3', 'psql', 'mysql', 'redis-cli', 'mongo', 'mongosh',
  'curl', 'wget', 'nc', 'netcat',
]);

// Always dangerous regardless of args
const ALWAYS_DANGEROUS = new Set([
  'shutdown', 'halt', 'poweroff', 'reboot', 'init', 'systemctl',
  'mkfs', 'mkfs.ext4', 'mkfs.xfs', 'mkfs.btrfs',
  'dd',
  'fdisk', 'parted', 'mkswap',
]);

interface CommandAnalysis {
  name: string;
  args: string[];
  risk: CommandRisk;
  reason?: string;
}

/**
 * Parse a bash command into an AST and extract individual commands with args.
 * bash-parser returns a tree; we walk it to find all "Command" nodes.
 */
function extractCommands(input: string): CommandAnalysis[] {
  let ast: any;
  try {
    const parse = require('bash-parser');
    ast = parse(input);
  } catch {
    // Fallback to naive splitting on ; && || |
    return naiveSplit(input);
  }

  const commands: CommandAnalysis[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Command' && node.name) {
      const name = node.name.text || '';
      const args: string[] = [];
      if (Array.isArray(node.suffix)) {
        for (const s of node.suffix) {
          if (s.text !== undefined) args.push(s.text);
        }
      }
      commands.push(classify(name, args));
    }
    // Walk children for all known container types
    for (const key of ['commands', 'list', 'body', 'then', 'else', 'do', 'elif', 'cases', 'pipeline']) {
      const v = node[key];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v) walk(v);
    }
  };
  walk(ast);

  if (commands.length === 0) return naiveSplit(input);
  return commands;
}

function naiveSplit(input: string): CommandAnalysis[] {
  const parts = input.split(/\s*(?:&&|\|\||;|\|)\s*/);
  return parts.filter(Boolean).map((p) => {
    const tokens = p.trim().split(/\s+/);
    return classify(tokens[0] || '', tokens.slice(1));
  });
}

function classify(name: string, args: string[]): CommandAnalysis {
  const bareName = name.split('/').pop() || name;

  if (ALWAYS_DANGEROUS.has(bareName)) {
    return { name, args, risk: 'dangerous', reason: `${bareName} e sempre perigoso` };
  }

  // rm: analyze flags
  if (bareName === 'rm') {
    const flags = args.filter((a) => a.startsWith('-')).join('');
    const targets = args.filter((a) => !a.startsWith('-'));
    const recursive = /[rR]/.test(flags);
    const force = /f/.test(flags);
    if (recursive && (targets.some((t) => t === '/' || t === '~' || t === '*' || t === '.' || t === '..'))) {
      return { name, args, risk: 'dangerous', reason: 'rm -r com alvo critico (/, ~, *, .)' };
    }
    if (recursive && force) {
      return { name, args, risk: 'dangerous', reason: 'rm -rf — remocao recursiva forcada' };
    }
    return { name, args, risk: 'warn', reason: 'rm — verifique arquivos' };
  }

  // git: specific subcommand analysis
  if (bareName === 'git') {
    const sub = args[0];
    const rest = args.slice(1).join(' ');
    if (sub === 'push' && /--force(?!-with-lease)|(\s|^)-f(\s|$)/.test(rest)) {
      return { name, args, risk: 'dangerous', reason: 'git push --force sem --force-with-lease' };
    }
    if (sub === 'reset' && /--hard/.test(rest) && /(HEAD~|origin|[a-f0-9]{7,})/.test(rest)) {
      return { name, args, risk: 'dangerous', reason: 'git reset --hard descarta trabalho' };
    }
    if (sub === 'clean' && /-[fdx]+/.test(rest)) {
      return { name, args, risk: 'dangerous', reason: 'git clean -fd remove untracked' };
    }
    if (sub === 'branch' && /-D/.test(rest)) {
      return { name, args, risk: 'dangerous', reason: 'git branch -D forca delecao' };
    }
    if (sub === 'rebase' && /--onto|--interactive|-i/.test(rest)) {
      return { name, args, risk: 'warn', reason: 'git rebase altera historico' };
    }
    if (['checkout', 'reset', 'clean', 'stash'].includes(sub || '')) {
      return { name, args, risk: 'warn', reason: `git ${sub} altera working tree` };
    }
    if (['status', 'log', 'diff', 'show', 'blame', 'branch', 'remote', 'config'].includes(sub || '')) {
      return { name, args, risk: 'safe' };
    }
    return { name, args, risk: 'warn', reason: `git ${sub}` };
  }

  // docker: prune/volume rm
  if (bareName === 'docker') {
    const sub = args[0];
    if (sub === 'prune' || (sub === 'system' && args[1] === 'prune')) {
      return { name, args, risk: 'dangerous', reason: 'docker prune apaga volumes/containers' };
    }
    if (sub === 'volume' && args[1] === 'rm') {
      return { name, args, risk: 'dangerous', reason: 'docker volume rm apaga dados' };
    }
    if (sub === 'rm' && args.some((a) => a === '-f' || a === '--force')) {
      return { name, args, risk: 'warn', reason: 'docker rm -f' };
    }
  }

  // SQL-like in-inline commands (curl to DB, etc.)
  const joined = [name, ...args].join(' ').toLowerCase();
  if (/\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from\s+\w+(?!\s+where))\b/.test(joined)) {
    return { name, args, risk: 'dangerous', reason: 'SQL destrutivo sem WHERE' };
  }

  // chmod 777 recursive
  if (bareName === 'chmod' && /-R/.test(args.join(' ')) && args.includes('777')) {
    return { name, args, risk: 'dangerous', reason: 'chmod -R 777' };
  }

  // curl|bash or wget|bash is handled at pipeline level below

  // Fork bomb
  if (/:\(\)\{.*\|\:&\};\:/.test(joined)) {
    return { name, args, risk: 'dangerous', reason: 'fork bomb' };
  }

  if (SAFE_COMMANDS.has(bareName)) return { name, args, risk: 'safe' };
  if (WRITE_COMMANDS.has(bareName)) return { name, args, risk: 'warn', reason: `${bareName} altera estado` };

  // sudo: always warn
  if (bareName === 'sudo') return { name, args, risk: 'warn', reason: 'sudo — privilegio elevado' };

  // Unknown command: warn (not dangerous, but not whitelisted)
  return { name, args, risk: 'warn', reason: `comando desconhecido: ${bareName}` };
}

/**
 * Detect dangerous pipelines: curl|bash, wget|bash, unknown|sh
 */
function detectDangerousPipeline(input: string): string | null {
  if (/\b(curl|wget|fetch)\b[^|]*\|\s*(bash|sh|zsh|fish)\b/.test(input)) {
    return 'curl|bash ou wget|bash — executa script remoto como shell';
  }
  return null;
}

export function analyzeCommand(cmd: string): SecurityCheck {
  const normalized = cmd.replace(/\s+/g, ' ').trim();
  const commands = extractCommands(normalized);

  // Pipeline-level check
  const pipelineReason = detectDangerousPipeline(normalized);
  const reasons: string[] = [];
  let maxRisk: CommandRisk = 'safe';

  if (pipelineReason) {
    reasons.push(pipelineReason);
    maxRisk = 'dangerous';
  }

  for (const c of commands) {
    if (c.risk === 'dangerous' && c.reason) reasons.push(c.reason);
    else if (c.risk === 'warn' && c.reason && maxRisk !== 'dangerous') reasons.push(c.reason);
    if (c.risk === 'dangerous') maxRisk = 'dangerous';
    else if (c.risk === 'warn' && maxRisk === 'safe') maxRisk = 'warn';
  }

  return {
    risk: maxRisk,
    reasons,
    commands: commands.map((c) => `${c.name} ${c.args.join(' ')}`.trim()),
    command: normalized,
  };
}

// ── Binary-read guard ──────────────────────────────────────────────────────
//
// `cat foo.pdf` (and head/tail/less/more/view variants) emits binary garbage
// into the agent's context window — zero useful information, just thousands
// of malformed UTF-8 bytes that crowd out the real working set. The agent
// has perfectly good alternatives (Read tool with PDF text extraction,
// `unzip -p` for archives, `file` / `strings` for inspection) but defaults
// to `cat` because that's what works on .txt files.
//
// We block deterministically before bash spawns. The error message names the
// right tool for each format so the agent can recover on the next turn
// without a wasted pdf-parse-via-cat hallucination.

const BINARY_READER_TOOLS = ['cat', 'head', 'tail', 'less', 'more', 'view', 'bat'];

interface BinaryFormatGroup {
  /** Lower-case extensions (no leading dot) that belong to this group. */
  exts: string[];
  /** Human-readable name in the error message. */
  label: string;
  /** What the agent should do instead. Must be actionable, not a lecture. */
  suggestion: string;
}

const BINARY_FORMAT_GROUPS: BinaryFormatGroup[] = [
  {
    exts: ['pdf'],
    label: 'PDF',
    suggestion:
      'Use the Read tool — it has built-in PDF text extraction (pdf-parse). For huge PDFs, pass `pages: "1-5"`.',
  },
  {
    exts: ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'],
    label: 'Office document',
    suggestion:
      'Office files are zipped XML. `unzip -p file.docx word/document.xml` to peek, or `pandoc file.docx -t plain` for the text layer.',
  },
  {
    exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'ico'],
    label: 'image',
    suggestion:
      'Use the Read tool — it returns the image visually (multimodal). For metadata only: `file img.png` or `identify img.png`.',
  },
  {
    exts: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', '7z', 'rar'],
    label: 'archive',
    suggestion:
      'Inspect contents with `unzip -l file.zip`, `tar tf file.tar`, `tar tzf file.tgz`. Extract one file with `unzip -p` / `tar xOf`.',
  },
  {
    exts: ['mp3', 'mp4', 'wav', 'ogg', 'webm', 'avi', 'mkv', 'mov', 'flac', 'm4a', 'm4v'],
    label: 'media',
    suggestion: 'Use `ffprobe file.mp4` for metadata or `file file.mp4` for a quick header check.',
  },
  {
    exts: ['exe', 'bin', 'so', 'dylib', 'dll', 'a', 'o', 'class', 'jar', 'war', 'ear', 'wasm'],
    label: 'compiled binary',
    suggestion:
      'Use `file binary` for a quick header sniff, `nm binary` / `objdump -d binary` / `strings binary` for symbols/strings.',
  },
  {
    exts: ['sqlite', 'sqlite3', 'db', 'mdb', 'parquet', 'avro', 'orc'],
    label: 'binary database',
    suggestion:
      'Use the actual client: `sqlite3 file.db ".tables"` / `sqlite3 file.db ".schema"`, or `parquet-tools` for parquet.',
  },
  {
    exts: ['woff', 'woff2', 'ttf', 'otf', 'eot'],
    label: 'font',
    suggestion: 'Use `fc-query font.ttf` or `otfinfo --info font.ttf` for metadata.',
  },
];

const BLOCKED_EXT_INDEX: Map<string, BinaryFormatGroup> = (() => {
  const m = new Map<string, BinaryFormatGroup>();
  for (const g of BINARY_FORMAT_GROUPS) {
    for (const e of g.exts) m.set(e, g);
  }
  return m;
})();

export interface BinaryReadFinding {
  tool: string;
  target: string;
  format: string;
  reason: string;
  suggestion: string;
}

/**
 * Detect `cat <binary-file>`-style commands across pipelines and compound
 * statements. Returns the first offending segment, or null if the command
 * is fine.
 *
 * Pipeline-aware: `cat a.pdf | grep foo` flags the cat segment.
 * Glob-aware:     `cat *.pdf` flags by the literal extension on the glob.
 * Flag-tolerant:  `cat -n file.pdf` and `head -c 100 file.pdf` still flag.
 *
 * Does NOT flag:
 *  - tools not in BINARY_READER_TOOLS (e.g. `pdftotext`, `xxd`, `strings`)
 *  - text files even if they share a name with a binary (`cat foo.pdf.txt`
 *    matches by LAST extension `.txt` → not blocked)
 *  - `cat /dev/stdin`, `cat <<EOF`, here-strings — no extension, skipped
 */
export function detectBinaryRead(command: string): BinaryReadFinding | null {
  if (!command) return null;
  // Cheap pre-filter: skip the regex pipeline if no candidate tool name appears
  // anywhere in the command. Keeps the hot path on every Bash call near zero cost.
  if (!new RegExp(`\\b(${BINARY_READER_TOOLS.join('|')})\\b`).test(command)) return null;

  // Split on shell separators (; && || |) and inspect each segment independently.
  // We intentionally don't try to parse subshells / process-substitution here —
  // the regex on the whole segment string is sufficient to catch the common
  // failure modes; exotic constructs are rare and the worst-case is an
  // over-conservative allow.
  const segments = command.split(/[;|&]+/).map((s) => s.trim()).filter(Boolean);

  for (const seg of segments) {
    // Tokenize on whitespace, drop redirections (`>file`, `<file`).
    const tokens = seg
      .split(/\s+/)
      .filter((t) => t && !t.startsWith('>') && !t.startsWith('<'));
    if (tokens.length < 2) continue;

    const tool = tokens[0];
    if (!BINARY_READER_TOOLS.includes(tool)) continue;

    // Walk every other token (flags AND flag-values are both fine to skip
    // — we don't need to know the flag schema; we only care if any token
    // points at a path with a blocked extension). First match wins.
    //
    // Tokens dropped:
    //  - flags (start with `-`)
    //  - shell metacharacters that snuck through the segment split
    //  - explicit redirect file targets we can't tell apart cheaply
    for (let i = 1; i < tokens.length; i++) {
      const raw = tokens[i];
      if (raw.startsWith('-')) continue;

      // Strip surrounding quotes that may have come from the model.
      const cleaned = raw.replace(/^['"]|['"]$/g, '');
      if (!cleaned) continue;

      const extMatch = cleaned.match(/\.([A-Za-z0-9]+)$/);
      if (!extMatch) continue;
      const ext = extMatch[1].toLowerCase();
      const group = BLOCKED_EXT_INDEX.get(ext);
      if (!group) continue;

      return {
        tool,
        target: cleaned,
        format: group.label,
        reason: `\`${tool} ${cleaned}\` would dump raw ${group.label} bytes into the conversation. Binary content is unreadable as text.`,
        suggestion: group.suggestion,
      };
    }
  }

  return null;
}

export async function requestApproval(check: SecurityCheck): Promise<boolean> {
  if (check.risk === 'safe') return true;
  if (!process.stdin.isTTY) return false;

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const icon = check.risk === 'dangerous' ? '\x1B[31m⚠ PERIGO\x1B[0m' : '\x1B[33m⚠ ATENCAO\x1B[0m';
  const reasonList = check.reasons.length > 0
    ? '\n  ' + check.reasons.map((r) => '· ' + r).join('\n  ')
    : '';
  const prompt = `\n  ${icon}${reasonList}\n  ${check.command}\n\n  Executar mesmo assim? [s/N]: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer: string) => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      resolve(a === 's' || a === 'y' || a === 'sim' || a === 'yes');
    });
  });
}
