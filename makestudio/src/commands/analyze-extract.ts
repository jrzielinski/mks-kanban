import { swallow } from '../utils/log';
/**
 * `analyze` command — extract module. Extracted from analyze.ts.
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
import type { CodebaseAnalysis } from './analyze';


export function extractJson(raw: string, runStartTime?: number): CodebaseAnalysis {
  const trimmed = raw.trim();
  const TEMP_FILE = '/tmp/codebase_analysis.json';

  // Helper: try to read and parse the temp file (with optional freshness check)
  const tryTempFile = (filePath: string): CodebaseAnalysis | null => {
    if (!fs.existsSync(filePath)) return null;
    try {
      // If we know when the run started, reject stale files from previous runs
      if (runStartTime) {
        const mtime = fs.statSync(filePath).mtimeMs;
        if (mtime < runStartTime - 5000) return null; // >5s older than run start
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  };

  // Priority 1: explicit signal from agent (JSON_SAVED:/path/to/file.json)
  const savedMatch = trimmed.match(/JSON_SAVED:([^\s]+\.json)/);
  if (savedMatch) {
    const parsed = tryTempFile(savedMatch[1].trim());
    if (parsed) return parsed;
  }

  // Priority 2: agent mentioned the temp file path — try it immediately before
  // attempting heuristic text extraction (avoids false positives from Markdown)
  if (trimmed.includes(TEMP_FILE) || trimmed.includes('codebase_analysis.json')) {
    const parsed = tryTempFile(TEMP_FILE);
    if (parsed) {
      logInfo(`JSON lido de ${TEMP_FILE}`);
      return parsed;
    }
  }

  // Priority 3: output is pure JSON
  try {
    return JSON.parse(trimmed);
  } catch (err) { swallow(err); }

  // Priority 4: JSON inside a ```json ... ``` fence
  const jsonFence = trimmed.match(/```json\s*\n([\s\S]*?)\n```/s);
  if (jsonFence) {
    try { return JSON.parse(jsonFence[1].trim()); } catch (err) { swallow(err); }
  }

  // Priority 5: outermost { ... } block
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try { return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)); } catch (err) { swallow(err); }
  }

  // Priority 6: unconditional temp file fallback (any age)
  const fallback = tryTempFile(TEMP_FILE);
  if (fallback) {
    logInfo(`JSON recuperado de ${TEMP_FILE} (fallback final)`);
    return fallback;
  }

  throw new Error('No JSON found in CLI output');
}
