/**
 * FS tool handlers — extracted from the giant switch in
 * tools.ts:runUnderlyingTool.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ReplContext } from '../../context';
import { getApiClient } from '../../../network/api-client';
import { asArray, findProjectMatch, safePath, truncate, fallbackGrepDefinition, fallbackGrepReferences, fallbackGrepSymbols } from '../helpers';



export async function toolReadFile(input: any, _ctx: ReplContext): Promise<string> {
  if (typeof input?.projectPath !== 'string' || typeof input?.filePath !== 'string') {
    return JSON.stringify({
      error: 'read_file requires projectPath (string) AND filePath (string).',
      got: { projectPath: typeof input?.projectPath, filePath: typeof input?.filePath },
    });
  }
  // Catch every shape the model uses when it really wants an attachment
  // but reaches for read_file instead. Order: first the disk-path forms
  // (more specific), then the placeholder forms (looser regexes), so a
  // path like ~/.makestudio/attachments/paste-1778-54.txt resolves to
  // id=54, not id=1778.
  const combined = `${input.projectPath}/${input.filePath}`;
  const diskPathMatch =
    combined.match(/[/\\]\.makestudio[/\\]attachments[/\\]paste-\d+-(\d+)\.txt\b/i);
  if (diskPathMatch) {
    return JSON.stringify({
      error: 'Reading the on-disk attachment file directly is the wrong path.',
      hint: `Use read_attachment(id=${diskPathMatch[1]}) — it bypasses the path-traversal guard and returns the same content via the proper channel.`,
    });
  }
  if (/[/\\]\.makestudio[/\\]attachments[/\\]manifest\.json\b/i.test(combined)) {
    return JSON.stringify({
      error: 'The attachments manifest is internal — do not read it directly.',
      hint: 'The IDs you need are already in the message text as [Pasted #N]. Call read_attachment(id=N) for each.',
    });
  }
  const pasteMatch = combined.match(/pasted[_-]?content[_-]?(\d+)/i)
    || combined.match(/\[?Pasted\s*#?(\d+)\]?/i);
  if (pasteMatch) {
    return JSON.stringify({
      error: 'That path looks like a paste/attachment placeholder, not a real file.',
      hint: `Use read_attachment(id=${pasteMatch[1]}) instead. Pastes live in ~/.makestudio/attachments — they are never under the project tree.`,
    });
  }
  // Wrap safePath: when it throws "Path traversal blocked" return a JSON
  // error explaining the projectPath/filePath contract, plus a hint at
  // read_attachment when there's any [Pasted #N] in the failed path. Raw
  // throws used to bubble up as `Error in read_file: Path traversal blocked`
  // with no actionable info, and the model would loop guessing paths.
  let abs: string;
  try {
    abs = safePath(input.projectPath, input.filePath);
  } catch (err: any) {
    return JSON.stringify({
      error: `read_file rejected the path: ${err?.message || String(err)}`,
      hint: 'filePath must be RELATIVE to projectPath (e.g. "src/foo.ts", not "/abs/proj/src/foo.ts"). If you meant to read an attachment, call read_attachment(id=N).',
      got: { projectPath: input.projectPath, filePath: input.filePath },
    });
  }
  if (!fs.existsSync(abs)) return `File not found: ${input.filePath}`;
  return truncate(fs.readFileSync(abs, 'utf8'));
}

export async function toolSearchCode(input: any, _ctx: ReplContext): Promise<string> {
  const globArg = input.glob ? `--include='${input.glob}'` : `--include='*.ts' --include='*.dart' --include='*.tsx' --include='*.json'`;
  // Default excludes — without these, search_code in any JS/TS repo
  // returns hundreds of irrelevant matches from node_modules / dist /
  // generated build artefacts. Real session caught a 123KB dump of
  // AWS-SDK declarations on a "search for insights" query. User can
  // override via input.includeDeps=true to opt back in.
  const excludeArgs = input.includeDeps === true
    ? ''
    : `--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.git`;
  const cmd = `grep -rn ${excludeArgs} ${globArg} -E "${input.pattern.replace(/"/g, '\\"')}" . 2>/dev/null | head -50`;
  const out = execSync(cmd, {
    cwd: input.projectPath,
    timeout: 10_000,
    shell: '/bin/sh',
  }).toString();
  return out || '(no matches)';
}

export async function toolReadAttachment(input: any, _ctx: ReplContext): Promise<string> {
  const { readAttachmentContent, getAttachment } = require('../../attachments');
  const att = getAttachment(input.id);
  if (!att) return JSON.stringify({ error: `Attachment #${input.id} not found` });
  const content = readAttachmentContent(input.id);
  if (content === null) return JSON.stringify({ error: 'Failed to read attachment' });
  return truncate(content, 8000);
}

export async function toolListFiles(input: any, _ctx: ReplContext): Promise<string> {
  const cmd = `find . -path '${input.pattern}' -type f 2>/dev/null | head -50 | sort`;
  const out = execSync(cmd, {
    cwd: input.projectPath,
    timeout: 10_000,
    shell: '/bin/sh',
  }).toString();
  return out || '(no files found)';
}


export const FS_TOOL_HANDLERS = [
  { name: 'read_file', handler: toolReadFile },
  { name: 'search_code', handler: toolSearchCode },
  { name: 'read_attachment', handler: toolReadAttachment },
  { name: 'list_files', handler: toolListFiles },
];
