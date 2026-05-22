import { swallow } from '../utils/log';
/**
 * Refine pipeline — prompts topic. Extracted from refine.ts.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import chalk from 'chalk';
import { getApiClient } from '../network/api-client';

const dim = chalk.hex('#64748B');
const yellow = chalk.hex('#FBBF24');
const green = chalk.hex('#22C55E');
const cyan = chalk.hex('#22D3EE');
const red = chalk.hex('#EF4444');
const blue = chalk.hex('#60A5FA');
import { getCLICommand } from '../core/cli-detector';

export async function runLocalCLI(cliName: string, prompt: string, cwd: string, timeoutMs?: number): Promise<string | null> {
  return new Promise((resolve) => {
    const cliCmd = getCLICommand(cliName);
    const args: string[] = [];
    // claude AND makestudio both stream JSONL — the parser below treats them
    // uniformly. Without this, makestudio's --json output looked like noise
    // and tool calls weren't counted.
    const isStreamJson = cliName === 'claude' || cliName === 'makestudio'
      || cliName === 'self' || cliName === 'ms';
    const isMakestudio = cliName === 'makestudio' || cliName === 'self' || cliName === 'ms';
    const startTime = Date.now();
    // Default: 15 minutes. Audit/regen/correction callers should pass shorter timeouts.
    const effectiveTimeout = timeoutMs || 15 * 60 * 1000;

    if (cliName === 'claude') {
      args.push('-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--max-turns', '20');
    } else if (cliName === 'codex') {
      // --full-auto activates bubblewrap sandbox; on hosts where
      // unprivileged user_namespaces are restricted, bwrap fails with
      // "Failed RTM_NEWADDR: Operation not permitted" and codex aborts
      // before any tool call. The user already opted into the local agent
      // (makestudio start), so we run codex with sandbox/approvals fully
      // bypassed — equivalent to `--yes` for claude.
      args.push('exec', '--dangerously-bypass-approvals-and-sandbox');
    } else if (cliName === 'gemini') {
      args.push('-y');
    } else if (isMakestudio) {
      // makestudio self-spawn: -p triggers runHeadless (without it the
      // binary opens the Ink REPL and tries to interpret the prompt as
      // user input). --json gives a JSONL stream we parse below.
      // No --max-turns: the inner runHeadless defaults to MAX_TOOL_LOOPS=200,
      // which is what the model needs to write a full multi-section DUM
      // with 5+ tasks. Earlier `--max-turns 20` cut the tool loop short
      // and produced 8KB stubs instead of 25-35KB rich DUMs.
      args.push('-p', '--yes', '--json');
    }

    // Strip claude-code env vars that put a spawned `claude` CLI into
    // "I'm a child of claude-code, stay quiet" mode (no streaming output,
    // exits cleanly after ~3 min without producing files). Same filter as
    // per-requirement-loop's spawnCliAndCapture — must stay in sync.
    const cleanEnv: NodeJS.ProcessEnv = {};
    const blocked = new Set([
      'CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_AGENT_SDK', 'CLAUDE_CODE_SUBAGENT',
    ]);
    for (const [k, v] of Object.entries(process.env)) {
      if (!blocked.has(k)) cleanEnv[k] = v;
    }

    // makestudio reads its prompt from argv positional. Other CLIs read stdin.
    const finalArgs = isMakestudio ? [...args, prompt] : args;
    const proc = spawn(cliCmd, finalArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });

    // Hard timeout — kills the process if it runs too long without completing
    const timeoutHandle = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (err) { swallow(err); }
    }, effectiveTimeout);

    if (!isMakestudio) {
      proc.stdin.write(prompt);
    }
    proc.stdin.end();

    let allOutput = '';
    let resultText = '';
    let lineBuffer = '';
    let toolCalls = 0;
    let lastActivityAt = Date.now();

    // ── Heartbeat: elapsed timer every 5s + silence warning ──────
    const heartbeatTimer = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const silentSecs = Math.round((Date.now() - lastActivityAt) / 1000);
      const elapsedStr = mins > 0 ? `${mins}m${String(secs).padStart(2,'0')}s` : `${secs}s`;
      const silentHint = silentSecs >= 30 ? dim(` · sem output há ${silentSecs}s`) : '';
      process.stdout.write(`\r  ${dim('⏳')} ${cyan(cliName.toUpperCase())} trabalhando... ${dim(elapsedStr)} · ${dim(`${toolCalls} tool calls`)}${silentHint}   `);
    }, 3_000);

    const markActivity = () => { lastActivityAt = Date.now(); };

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      allOutput += chunk;
      markActivity();

      if (isStreamJson) {
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            // claude stream-json shape (nested message.content)
            if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
              for (const block of parsed.message.content) {
                if (block.type === 'tool_use') {
                  toolCalls++;
                  const detail = block.input?.command?.substring(0, 80)
                    || block.input?.file_path
                    || block.input?.pattern
                    || block.input?.query?.substring(0, 80)
                    || '';
                  process.stdout.write('\r' + ' '.repeat(80) + '\r');
                  console.log(`  ${dim('·')} ${cyan(block.name)} ${dim(detail)}`);
                }
                if (block.type === 'text' && block.text?.trim()) {
                  const text = block.text.trim();
                  if (text.length > 0 && text.length < 400) {
                    process.stdout.write('\r' + ' '.repeat(80) + '\r');
                    console.log(`  ${dim(text)}`);
                  }
                }
              }
            }
            // makestudio --json shape (flat). Tool calls come as
            // {type:'log',message:'[tool] Read (...)'} from runHeadless's
            // console.log shim.
            if (parsed.type === 'log' && typeof parsed.message === 'string') {
              const m = parsed.message.trim();
              const toolMatch = m.match(/^\s*\[tool\]\s+(\w+)\s*(.*)$/);
              if (toolMatch) {
                toolCalls++;
                const [, name, rest] = toolMatch;
                process.stdout.write('\r' + ' '.repeat(80) + '\r');
                console.log(`  ${dim('·')} ${cyan(name)} ${dim(rest.replace(/^\(|\)$/g, '').slice(0, 100))}`);
              } else if (m && m.length < 400) {
                process.stdout.write('\r' + ' '.repeat(80) + '\r');
                console.log(`  ${dim(m)}`);
              }
            }
            if (parsed.type === 'info' && typeof parsed.message === 'string') {
              process.stdout.write('\r' + ' '.repeat(80) + '\r');
              console.log(`  ${dim('ℹ')} ${dim(parsed.message)}`);
            }
            if (parsed.type === 'assistant' && typeof parsed.text === 'string' && !parsed.message) {
              resultText = parsed.text;
            }
            if (parsed.type === 'result' && parsed.result) {
              resultText = parsed.result;
            }
          } catch (err) { swallow(err); }
        }
      } else {
        const lines = chunk.split('\n');
        for (const line of lines) {
          const t = line.trim();
          if (t.length > 3 && t.length < 300) {
            process.stdout.write('\r' + ' '.repeat(80) + '\r');
            console.log(`  ${dim(t)}`);
          }
        }
      }
    });

    let stderrBuffer = '';
    proc.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      // makestudio --json puts info/log/error events on STDERR (stdout is
      // reserved for the final assistant text). Parse them as JSONL so the
      // user sees tool calls in real time.
      if (isMakestudio) {
        markActivity();
        stderrBuffer += chunk;
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === 'log' && typeof parsed.message === 'string') {
              const m = parsed.message.trim();
              const toolMatch = m.match(/^\s*\[tool\]\s+(\w+)\s*(.*)$/);
              if (toolMatch) {
                toolCalls++;
                const [, name, rest] = toolMatch;
                process.stdout.write('\r' + ' '.repeat(80) + '\r');
                console.log(`  ${dim('·')} ${cyan(name)} ${dim(rest.replace(/^\(|\)$/g, '').slice(0, 100))}`);
              } else if (m && m.length < 400) {
                process.stdout.write('\r' + ' '.repeat(80) + '\r');
                console.log(`  ${dim(m)}`);
              }
            } else if (parsed.type === 'info' && typeof parsed.message === 'string') {
              process.stdout.write('\r' + ' '.repeat(80) + '\r');
              console.log(`  ${dim('ℹ')} ${dim(parsed.message)}`);
            } else if (parsed.type === 'error' && typeof parsed.message === 'string') {
              process.stdout.write('\r' + ' '.repeat(80) + '\r');
              console.log(`  ${red('✗')} ${red(parsed.message)}`);
            }
          } catch (err) { swallow(err); }
        }
        return;
      }
      const lines = chunk.split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (t && !t.includes('ExperimentalWarning') && !t.includes('DeprecationWarning')) {
          process.stdout.write('\r' + ' '.repeat(80) + '\r');
          console.log(`  ${yellow('!')} ${dim(t.substring(0, 150))}`);
        }
      }
    });

    proc.on('close', (code) => {
      clearInterval(heartbeatTimer);
      clearTimeout(timeoutHandle);
      process.stdout.write('\r' + ' '.repeat(80) + '\r');

      if (lineBuffer.trim()) {
        try {
          const parsed = JSON.parse(lineBuffer);
          if (parsed.type === 'result' && parsed.result) resultText = parsed.result;
          // makestudio --json final assistant message — flat shape
          if (parsed.type === 'assistant' && typeof parsed.text === 'string' && !parsed.message) {
            resultText = parsed.text;
          }
        } catch (err) { swallow(err); }
      }
      // Flush any partial JSONL line still buffered on stderr — without
      // this, the LAST `info`/`log`/`error` event of the subprocess is
      // dropped silently when the inner CLI exits without a trailing
      // newline. Affects diagnosis but not correctness; keep it best-effort.
      if (isMakestudio && stderrBuffer.trim()) {
        try {
          const parsed = JSON.parse(stderrBuffer);
          if (parsed.type === 'error' && typeof parsed.message === 'string') {
            console.log(`  ${red('✗')} ${red(parsed.message)}`);
          } else if (parsed.type === 'info' && typeof parsed.message === 'string') {
            console.log(`  ${dim('ℹ')} ${dim(parsed.message)}`);
          }
        } catch (err) { swallow(err); }
        stderrBuffer = '';
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const killedByTimeout = code === null || (code as any) === 'SIGKILL';
      if (killedByTimeout && elapsed * 1000 >= effectiveTimeout - 1000) {
        console.log(`  ${red(`✗ ${cliName.toUpperCase()} matado por timeout após ${elapsed}s (${Math.round(effectiveTimeout/60000)}min)`)}`);
        resolve(resultText || allOutput || null);
        return;
      }
      console.log(`  ${dim(`✓ ${cliName.toUpperCase()} concluído em ${elapsed}s · ${toolCalls} tool calls`)}`);

      resolve(code !== 0 && !resultText && !allOutput ? null : resultText || allOutput);
    });

    proc.on('error', () => {
      clearInterval(heartbeatTimer);
      clearTimeout(timeoutHandle);
      resolve(null);
    });
  });
}

export class UserCancelled extends Error {
  constructor() { super('User cancelled (Esc Esc)'); this.name = 'UserCancelled'; }
}

export function ask(question: string): Promise<string> {
  // Runs in RAW mode. Cooked mode lets the terminal buffer the line
  // until Enter, which means Esc (and backspace, arrow keys, etc.) never
  // reach our handler — they're visible only as `^[` echo. Raw mode
  // gives us each keypress immediately and we handle echo ourselves.
  const stdin = process.stdin as any;
  const wasRaw = !!stdin.isRaw;
  try {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
    }
  } catch (err) { swallow(err); }
  stdin.removeAllListeners('data');
  stdin.removeAllListeners('keypress');
  if (stdin.isPaused?.()) stdin.resume();

  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    let buf = '';
    let lastEscAt = 0;
    const restore = () => {
      try {
        if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
          stdin.setRawMode(wasRaw);
        }
      } catch (err) { swallow(err); }
      stdin.removeListener('data', onData);
    };
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];

        // Esc sequences: `\x1b` alone is bare Esc; `\x1b[...` / `\x1bO...`
        // are arrow keys / function keys. Swallow the whole sequence.
        if (ch === '\x1b') {
          const next = s[i + 1];
          if (next === '[' || next === 'O') {
            // skip the CSI: ESC [ <zero or more intermediates> <final byte>
            let j = i + 2;
            while (j < s.length && !/[@-~]/.test(s[j])) j++;
            i = j; // will be incremented by for loop → past final byte
            continue;
          }
          // Bare Esc — double-tap cancels, single clears the buffer
          const now = Date.now();
          if (now - lastEscAt < 600) {
            process.stdout.write('\n');
            restore();
            reject(new UserCancelled());
            return;
          }
          lastEscAt = now;
          if (buf.length > 0) {
            // Redraw: cursor to col 0, erase line, rewrite prompt
            process.stdout.write('\r\x1b[K' + question);
            buf = '';
          }
          continue;
        }

        if (ch === '\n' || ch === '\r') {
          process.stdout.write('\n');
          restore();
          resolve(buf.trim());
          return;
        }
        if (ch === '\u0003') { // Ctrl+C
          restore();
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') { // backspace
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        // Skip other non-printable controls
        const code = ch.charCodeAt(0);
        if (code < 32) continue;

        buf += ch;
        process.stdout.write(ch);
      }
    };
    stdin.on('data', onData);
  });
}

export function askWithTimeout(question: string, defaultAnswer = 's', timeoutSecs = 20): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    let remaining = timeoutSecs;

    const d = chalk.hex('#64748B');

    const finish = (ans: string, auto = false) => {
      if (done) return;
      done = true;
      clearInterval(tick);
      try { rl.close(); } catch (err) { swallow(err); }
      if (auto) {
        process.stdout.write('\n');
        console.log(`  ${d(`→ continuando automaticamente (${defaultAnswer})`)}`);
      }
      resolve(ans || defaultAnswer);
    };

    const renderPrompt = () => {
      process.stdout.write(`\r  ${question} ${d(`[auto:${defaultAnswer} em ${remaining}s]`)}: `);
    };

    renderPrompt();

    const tick = setInterval(() => {
      if (done) return;
      remaining--;
      if (remaining <= 0) {
        finish(defaultAnswer, true);
      } else {
        renderPrompt();
      }
    }, 1_000);

    rl.on('line', (line) => finish(line.trim(), false));
    rl.on('close', () => { if (!done) finish(defaultAnswer, true); });
  });
}

export function spinner(text: string): () => void {
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  const timer = setInterval(() => {
    process.stdout.write(`\r  ${cyan(frames[i++ % frames.length])} ${dim(text)}`);
  }, 80);
  return () => { clearInterval(timer); process.stdout.write('\r' + ' '.repeat(text.length + 8) + '\r'); };
}
