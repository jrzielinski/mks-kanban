import { swallow } from '../utils/log';
/**
 * Attachment system — replace large pastes with [Pasted #N] refs.
 *
 * When user input is > THRESHOLD chars, extract it into an external store
 * and replace in the message with a reference. The AI can request the
 * content via a `read_attachment` tool when needed.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const STORE_DIR = path.join(os.homedir(), '.makestudio', 'attachments');
// Pastes above this size get extracted to disk and replaced with [Pasted #N]
// in the message stream. Below this, they stay inline.
//
// Was 1000 (≈250 tokens) — too aggressive: every typed user prompt of
// ~3-5k chars (a normal "go fix X" instruction set) got externalized,
// forcing a tool round-trip through read_attachment that the model
// fumbled regularly (wrong path, "Path traversal blocked" errors,
// hand-grepping the manifest). Worse, the read_attachment result
// printed the user's own paste back into the TUI which made every
// long prompt look "weird as fuck" (operator's words 2026-05-05).
//
// 8000 chars (≈2k tokens) is the new floor. Typical user prompts
// stay inline; only genuinely huge dumps (logs, dataset rows, full
// transcripts of someone else's session) externalize.
const THRESHOLD_CHARS = 8000;
const PREVIEW_CHARS = 200;

export interface Attachment {
  id: number;
  path: string;
  lines: number;
  chars: number;
  preview: string;
  mime: string;
}

const MANIFEST_FILE = path.join(STORE_DIR, 'manifest.json');
let sessionCounter = 0;
const sessionAttachments = new Map<number, Attachment>();

function loadManifest(): Record<string, Attachment> {
  try {
    if (!fs.existsSync(MANIFEST_FILE)) return {};
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch { return {}; }
}

function saveManifest(): void {
  try {
    const obj: Record<string, Attachment> = {};
    for (const [id, att] of sessionAttachments.entries()) {
      obj[String(id)] = att;
    }
    fs.writeFileSync(MANIFEST_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) { swallow(err); }
}

export function restoreAttachments(): void {
  ensureDir();
  const manifest = loadManifest();
  let maxId = 0;
  for (const [idStr, att] of Object.entries(manifest)) {
    const id = parseInt(idStr, 10);
    if (!isNaN(id)) {
      sessionAttachments.set(id, att);
      if (id > maxId) maxId = id;
    }
  }
  sessionCounter = maxId;
}

// Call restore at module load
restoreAttachments();

function ensureDir() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

/**
 * Detect if input has embedded long pastes.
 * Long paste heuristic: 20+ consecutive lines OR > THRESHOLD_CHARS in a block.
 */
export function extractAttachments(input: string): { message: string; attachments: Attachment[] } {
  if (input.length <= THRESHOLD_CHARS) return { message: input, attachments: [] };

  ensureDir();

  // If the entire input is one big block, externalize it as one attachment
  const attachments: Attachment[] = [];

  // Detect code blocks: ```lang\n...code...\n```
  let processed = input;
  const codeBlockRe = /```[\w-]*\n([\s\S]+?)\n```/g;
  processed = processed.replace(codeBlockRe, (_m, body: string) => {
    if (body.length < THRESHOLD_CHARS) return _m;
    const att = storeAttachment(body, 'code');
    attachments.push(att);
    return `[Pasted #${att.id}, ${att.lines} lines, code block]`;
  });

  // After stripping code blocks, if rest is still huge, externalize it
  if (processed.length > THRESHOLD_CHARS * 2) {
    const att = storeAttachment(processed, 'text');
    attachments.push(att);
    return { message: `[Pasted #${att.id}, ${att.lines} lines, ${att.chars} chars]`, attachments };
  }

  return { message: processed, attachments };
}

function storeAttachment(content: string, mime: string): Attachment {
  sessionCounter++;
  const id = sessionCounter;
  const lines = content.split('\n').length;
  const chars = content.length;
  const preview = content.substring(0, PREVIEW_CHARS).replace(/\n/g, ' ') + (content.length > PREVIEW_CHARS ? '...' : '');
  const filePath = path.join(STORE_DIR, `paste-${Date.now()}-${id}.txt`);
  fs.writeFileSync(filePath, content, 'utf8');

  const att: Attachment = { id, path: filePath, lines, chars, preview, mime };
  sessionAttachments.set(id, att);
  saveManifest();
  return att;
}

export function getAttachment(id: number): Attachment | null {
  const att = sessionAttachments.get(id);
  if (!att) return null;
  return att;
}

export function readAttachmentContent(id: number): string | null {
  const att = sessionAttachments.get(id);
  if (!att) return null;
  try {
    return fs.readFileSync(att.path, 'utf8');
  } catch {
    return null;
  }
}

export function listSessionAttachments(): Attachment[] {
  return Array.from(sessionAttachments.values());
}
