/**
 * `analyze` command — cli module. Extracted from analyze.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import chalk from 'chalk';

const dim    = chalk.hex('#64748B');
const yellow = chalk.hex('#FBBF24');
const green  = chalk.hex('#22C55E');
const cyan   = chalk.hex('#22D3EE');
const red    = chalk.hex('#EF4444');
const blue   = chalk.hex('#60A5FA');
import { logInfo, logSuccess, logError, logWarning, logTool } from '../ui/terminal';
import { getCLICommand } from '../core/cli-detector';


export function startHeartbeat(
  passStart: number,
  getStats: () => { toolCalls: number; cost: number },
): { markActivity: () => void; stop: () => void } {
  let lastVisibleActivityAt = Date.now();

  // Only reset on actual VISIBLE activity (tool calls / text output), not system messages
  const markActivity = () => { lastVisibleActivityAt = Date.now(); };

  // Print status every 15s — always show elapsed+tool calls, add "silent" note if quiet > 30s
  const timer = setInterval(() => {
    const totalSecs = Math.round((Date.now() - passStart) / 1000);
    const silentSecs = Math.round((Date.now() - lastVisibleActivityAt) / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    const { toolCalls, cost } = getStats();
    const silentNote = silentSecs >= 30 ? chalk.yellow(` | sem output há ${silentSecs}s`) : '';
    process.stdout.write(
      chalk.dim(`  ⏳ Aguardando Claude... ${mins}m${String(secs).padStart(2, '0')}s | ${toolCalls} tool calls | $${cost.toFixed(4)}${silentNote}\n`),
    );
  }, 15_000);

  return { markActivity, stop: () => clearInterval(timer) };
}


export function parseStreamLine(
  line: string,
  startTime: number,
  onCost?: (cost: number) => void,
): { resultText?: string; hadActivity: boolean } | null {
  if (!line.trim()) return null;

  try {
    const parsed = JSON.parse(line);

    // Skip noise
    if (parsed.type === 'system' || parsed.type === 'user' || parsed.type === 'rate_limit_event') {
      return null;
    }

    // ── makestudio -p --json shape ───────────────────────────────
    // Emitted by runHeadless's emit/console.log shim while the tool loop
    // is running. Distinct from claude's stream-json (no `message` field,
    // payload is flat with `type` + `message`/`text`).
    if (parsed.type === 'log' && typeof parsed.message === 'string') {
      const m = parsed.message.trim();
      if (!m) return null;
      const toolMatch = m.match(/^\s*\[tool\]\s+(\w+)\s*(.*)$/);
      if (toolMatch) {
        const [, name, rest] = toolMatch;
        logTool(name, rest.replace(/^\(|\)$/g, '').slice(0, 100));
      } else if (m.length < 500) {
        logInfo(m);
      }
      return { hadActivity: true };
    }
    if (parsed.type === 'info' && typeof parsed.message === 'string') {
      logInfo(parsed.message);
      return { hadActivity: false };
    }
    if (parsed.type === 'error' && typeof parsed.message === 'string') {
      console.log(chalk.red(`  ✗ ${parsed.message}`));
      return { hadActivity: true };
    }
    if (parsed.type === 'assistant' && typeof parsed.text === 'string' && !parsed.message) {
      // makestudio's flat assistant final message (distinct from claude's
      // nested `message.content` form handled below).
      const text = parsed.text.trim();
      return { resultText: text, hadActivity: !!text };
    }

    // ── claude stream-json shape (nested message.content) ────────
    if (parsed.type === 'assistant' && parsed.message?.content) {
      const content = parsed.message.content;
      let hadActivity = false;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') {
            const tool = block.name || 'unknown';
            let detail = '';
            if (block.input) {
              detail = block.input.file_path
                || block.input.pattern
                || block.input.command?.substring(0, 100)
                || block.input.content?.substring(0, 80)
                || block.input.query?.substring(0, 80)
                || block.input.url?.substring(0, 80)
                || '';
            }
            logTool(tool, detail);
            hadActivity = true;
          }

          if (block.type === 'text' && block.text) {
            const text = block.text.trim();
            if (text.length > 0 && text.length < 500) {
              // Highlight token limit warnings
              if (/token|context|limit|excedeu|continuar/i.test(text)) {
                console.log(chalk.yellow(`  ⚠ ${text}`));
              } else {
                logInfo(text);
              }
              hadActivity = true;
            }
          }
        }
      }
      return { hadActivity };
    }

    // Result — contains the final output text and cost info
    if (parsed.type === 'result') {
      const cost = parsed.total_cost_usd || 0;
      const turns = parsed.num_turns || 0;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      onCost?.(cost);
      logSuccess(`Analysis finished: ${turns} turns, ${elapsed}s, $${cost.toFixed(4)}`);
      return { resultText: parsed.result || '', hadActivity: true };
    }

    // Extract cost from any event that carries it
    if (parsed.total_cost_usd) {
      onCost?.(parsed.total_cost_usd);
    }

    return null;
  } catch {
    // Not JSON — plain text output (codex/gemini)
    const trimmed = line.trim();
    if (trimmed.length > 3 && trimmed.length < 300) {
      logInfo(trimmed);
    }
    return { hadActivity: !!trimmed };
  }
}




export async function runSinglePass(
  targetPath: string,
  prompt: string,
  maxTurns: string,
  cliInfo: { name: string; version: string },
  options: { cli?: string },
): Promise<{ output: string; cost: number; toolCalls: number; startTime: number }> {
  const cliCmd = getCLICommand(cliInfo.name);
  const args: string[] = [];
  const isStreamJson = cliInfo.name === 'claude' || cliInfo.name === 'makestudio'
    || cliInfo.name === 'self' || cliInfo.name === 'ms';
  const isMakestudio = cliInfo.name === 'makestudio' || cliInfo.name === 'self' || cliInfo.name === 'ms';

  if (cliInfo.name === 'claude') {
    args.push('-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--max-turns', maxTurns);
  } else if (cliInfo.name === 'codex') {
    args.push('exec', '--full-auto');
  } else if (cliInfo.name === 'gemini') {
    args.push('-y');
  } else if (isMakestudio) {
    // No --max-turns — same rationale as the deep-analyze callsite above:
    // an external cap on the inner tool loop (claude convention) cut
    // makestudio short and produced 8KB DUM stubs instead of full ones.
    // runHeadless defaults to MAX_TOOL_LOOPS=200, which is the right cap.
    args.push('-p', '--yes', '--json');
  }

  const passStart = Date.now();
  let toolCallCount = 0;
  let passCost = 0;

  const heartbeat = startHeartbeat(passStart, () => ({ toolCalls: toolCallCount, cost: passCost }));

  const output = await new Promise<string>((resolve, reject) => {
    let allOutput = '';
    let resultText = '';
    let errorOutput = '';
    let lineBuffer = '';

    const finalArgs = isMakestudio ? [...args, prompt] : args;
    const proc = spawn(cliCmd, finalArgs, {
      cwd: targetPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      allOutput += chunk;
      // NOTE: do NOT call markActivity() here — system/noise messages would reset it.
      // markActivity() is called only on actual visible output (tool calls, text) below.

      if (isStreamJson) {
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          const result = parseStreamLine(line, passStart, (cost) => { passCost = cost; });
          if (result?.resultText) resultText = result.resultText;
          if (result?.hadActivity) heartbeat.markActivity(); // only reset on visible events
          if (line.includes('"tool_use"') || line.includes('[tool]')) toolCallCount++;
        }
      } else {
        const lines = chunk.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 3 && trimmed.length < 300) {
            logInfo(trimmed);
            heartbeat.markActivity();
          }
        }
      }
    });

    // makestudio --json emits info/log/error to STDERR (stdout is reserved
    // for the final assistant text). Parse stderr the same way as stdout
    // so the user sees tool calls + info while the loop runs.
    let stderrBuffer = '';
    proc.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      errorOutput += chunk;
      if (!isStreamJson) return;
      stderrBuffer += chunk;
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        const result = parseStreamLine(line, passStart, (cost) => { passCost = cost; });
        if (result?.hadActivity) heartbeat.markActivity();
        if (line.includes('"tool_use"') || line.includes('[tool]')) toolCallCount++;
      }
    });

    proc.on('close', (code) => {
      heartbeat.stop();
      if (lineBuffer.trim()) {
        const result = parseStreamLine(lineBuffer, passStart, (cost) => { passCost = cost; });
        if (result?.resultText) resultText = result.resultText;
      }
      if (stderrBuffer.trim()) {
        parseStreamLine(stderrBuffer, passStart, (cost) => { passCost = cost; });
      }
      if (code !== 0) {
        reject(new Error(`CLI exited with code ${code}: ${errorOutput.slice(0, 500)}`));
      } else {
        resolve(resultText || allOutput);
      }
    });

    proc.on('error', (err) => { heartbeat.stop(); reject(err); });
    if (!isMakestudio) {
      proc.stdin.write(prompt);
    }
    proc.stdin.end();
  });

  const elapsed = Math.round((Date.now() - passStart) / 1000);
  logSuccess(`Passada concluída: ${elapsed}s, ${toolCallCount} tool calls, $${passCost.toFixed(4)}`);

  return { output, cost: passCost, toolCalls: toolCallCount, startTime: passStart };
}

