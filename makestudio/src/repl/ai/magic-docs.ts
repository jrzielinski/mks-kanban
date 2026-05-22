import { swallow } from '../../utils/log';
/**
 * magic-docs.ts
 *
 * Port of Claude Code's services/MagicDocs (magicDocs.ts + prompts.ts).
 * A Magic Doc is a markdown file whose first line is `# MAGIC DOC: <title>`.
 * After any turn where that file was Read (or already tracked), the REPL
 * fires a background LLM call that rewrites the doc to capture new
 * learnings from the conversation.
 *
 * Regex + prompt are VERBATIM from Claude Code. The orchestration is
 * simplified — we don't have runAgent/forkedAgent, so we call the main
 * provider directly with tools:[] and overwrite the file ourselves.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ReplContext, ChatMessage } from '../context';
import { getProvider } from './providers';

// Verbatim from Claude Code magicDocs.ts:33.
export const MAGIC_DOC_HEADER_PATTERN = /^#\s*MAGIC\s+DOC:\s*(.+)$/im;
// Verbatim from Claude Code magicDocs.ts:35 — optional italicised instruction
// on the line after the header.
export const ITALICS_PATTERN = /^[_*](.+?)[_*]\s*$/m;

export interface MagicDocHeader {
  title: string;
  instructions?: string;
}

/**
 * Verbatim logic from Claude Code detectMagicDocHeader. Returns null when
 * the file isn't a magic doc, the title + optional instructions otherwise.
 */
export function detectMagicDocHeader(content: string): MagicDocHeader | null {
  const match = content.match(MAGIC_DOC_HEADER_PATTERN);
  if (!match || !match[1]) return null;
  const title = match[1].trim();
  const headerEndIndex = match.index! + match[0].length;
  const afterHeader = content.slice(headerEndIndex);
  const nextLineMatch = afterHeader.match(/^\s*\n(?:\s*\n)?(.+?)(?:\n|$)/);
  if (nextLineMatch && nextLineMatch[1]) {
    const italics = nextLineMatch[1].match(ITALICS_PATTERN);
    if (italics && italics[1]) {
      return { title, instructions: italics[1].trim() };
    }
  }
  return { title };
}

// ── Tracking state (one set per ctx, WeakMap avoids leaks) ───────────────

const trackedByCtx: WeakMap<ReplContext, Set<string>> = new WeakMap();

function tracked(ctx: ReplContext): Set<string> {
  let s = trackedByCtx.get(ctx);
  if (!s) { s = new Set(); trackedByCtx.set(ctx, s); }
  return s;
}

/** Tests: reset tracking state for a fresh ctx. */
export function clearTrackedMagicDocs(ctx: ReplContext): void {
  trackedByCtx.delete(ctx);
}

/**
 * Call from the Read tool with the absolute file path and its content.
 * If it's a magic doc, it gets added to the tracked set for this ctx.
 */
export function onFileRead(ctx: ReplContext, filePath: string, content: string): void {
  if (detectMagicDocHeader(content)) tracked(ctx).add(path.resolve(filePath));
}

export function listTrackedMagicDocs(ctx: ReplContext): string[] {
  return Array.from(tracked(ctx));
}

// ── Update prompt (verbatim port from Claude Code prompts.ts:9) ──────────

const UPDATE_PROMPT_TEMPLATE = `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT include any references to "documentation updates", "magic docs", or these update instructions in the document content.

Based on the user conversation above (EXCLUDING this documentation update instruction message), update the Magic Doc file to incorporate any NEW learnings, insights, or information that would be valuable to preserve.

The file {{docPath}} has already been read for you. Here are its current contents:
<current_doc_content>
{{docContents}}
</current_doc_content>

Document title: {{docTitle}}
{{customInstructions}}

Your ONLY task is to output the COMPLETE updated documentation file content as the ENTIRE response, OR respond with the exact literal string "NO_UPDATE" (no quotes, no other text) if there is nothing substantial to add.

CRITICAL RULES FOR EDITING:
- Preserve the Magic Doc header exactly as-is: # MAGIC DOC: {{docTitle}}
- If there's an italicized line immediately after the header, preserve it exactly as-is
- Keep the document CURRENT with the latest state of the codebase - this is NOT a changelog or history
- Update information IN-PLACE to reflect the current state - do NOT append historical notes or track changes over time
- Remove or replace outdated information rather than adding "Previously..." or "Updated to..." notes
- Clean up or DELETE sections that are no longer relevant or don't align with the document's purpose
- Fix obvious errors: typos, grammar mistakes, broken formatting, incorrect information, or confusing statements
- Keep the document well organized: use clear headings, logical section order, consistent formatting, and proper nesting

DOCUMENTATION PHILOSOPHY - READ CAREFULLY:
- BE TERSE. High signal only. No filler words or unnecessary elaboration.
- Documentation is for OVERVIEWS, ARCHITECTURE, and ENTRY POINTS - not detailed code walkthroughs
- Do NOT duplicate information that's already obvious from reading the source code
- Do NOT document every function, parameter, or line number reference
- Focus on: WHY things exist, HOW components connect, WHERE to start reading, WHAT patterns are used
- Skip: detailed implementation steps, exhaustive API docs, play-by-play narratives

What TO document:
- High-level architecture and system design
- Non-obvious patterns, conventions, or gotchas
- Key entry points and where to start reading code
- Important design decisions and their rationale
- Critical dependencies or integration points
- References to related files, docs, or code (like a wiki) - help readers navigate to relevant context

What NOT to document:
- Anything obvious from reading the code itself
- Exhaustive lists of files, functions, or parameters
- Step-by-step implementation details
- Low-level code mechanics
- Information already in CLAUDE.md or other project docs

REMEMBER: Only update if there is substantial new information. The Magic Doc header (# MAGIC DOC: {{docTitle}}) must remain unchanged. Output only the full new file content, or the literal token NO_UPDATE.`;

/** Verbatim: single-pass replace matches Claude Code's substituteVariables. */
export function substituteVariables(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? vars[k]! : m,
  );
}

export function buildMagicDocsUpdatePrompt(
  docContents: string,
  docPath: string,
  docTitle: string,
  instructions?: string,
): string {
  const customInstructions = instructions
    ? `\n\nDOCUMENT-SPECIFIC UPDATE INSTRUCTIONS:\nThe document author has provided specific instructions for how this file should be updated. Pay extra attention to these instructions and follow them carefully:\n\n"${instructions}"\n\nThese instructions take priority over the general rules below. Make sure your updates align with these specific guidelines.`
    : '';
  return substituteVariables(UPDATE_PROMPT_TEMPLATE, {
    docContents, docPath, docTitle, customInstructions,
  });
}

// ── Update loop ──────────────────────────────────────────────────────────

async function updateOne(ctx: ReplContext, docPath: string, messages: ChatMessage[], signal?: AbortSignal): Promise<{ updated: boolean; reason?: string }> {
  let currentContent = '';
  try { currentContent = fs.readFileSync(docPath, 'utf8'); }
  catch { tracked(ctx).delete(docPath); return { updated: false, reason: 'file missing' }; }

  const header = detectMagicDocHeader(currentContent);
  if (!header) { tracked(ctx).delete(docPath); return { updated: false, reason: 'header removed' }; }

  const userPrompt = buildMagicDocsUpdatePrompt(currentContent, docPath, header.title, header.instructions);
  const provider = getProvider(ctx.provider);
  if (!provider.sendMessage) return { updated: false, reason: 'provider cannot send' };

  const payload = messages.slice(-20).map(m => ({ role: m.role, content: m.content }));
  payload.push({ role: 'user', content: userPrompt });
  try {
    const response = await provider.sendMessage({
      system: 'You are the Magic Docs updater. Follow the instruction in the last user message precisely.',
      messages: payload,
      tools: [],
      effort: 'low',
      // @ts-ignore
      signal,
    } as any);
    const raw: string = (response?.content || [])
      .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('')
      .trim();
    if (!raw || raw === 'NO_UPDATE') return { updated: false, reason: 'no update needed' };
    // Safety check: the returned doc must still contain the magic header.
    const confirmed = detectMagicDocHeader(raw);
    if (!confirmed) return { updated: false, reason: 'model dropped header — refusing write' };
    fs.writeFileSync(docPath, raw.endsWith('\n') ? raw : raw + '\n', 'utf8');
    return { updated: true };
  } catch (e: any) {
    return { updated: false, reason: e?.message || String(e) };
  }
}

/**
 * Post-turn hook — iterates tracked docs and updates each. Non-blocking
 * from the chat flow's perspective; fire and forget.
 */
export async function runMagicDocsUpdates(ctx: ReplContext, signal?: AbortSignal): Promise<Array<{ path: string; updated: boolean; reason?: string }>> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    if (require('../settings').loadSettings().magicDocsDisabled) return [];
  } catch (err) { swallow(err); }
  const paths = Array.from(tracked(ctx));
  if (paths.length === 0) return [];
  const out: Array<{ path: string; updated: boolean; reason?: string }> = [];
  for (const p of paths) {
    if (signal?.aborted) break;
    const r = await updateOne(ctx, p, ctx.messages, signal);
    out.push({ path: p, ...r });
  }
  return out;
}
