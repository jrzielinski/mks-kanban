import { swallow } from '../utils/log';
/**
 * Side question (/ask) — lightweight LLM call with no tools, 1 turn max.
 * Runs parallel to the main agent without interrupting it.
 * Port of Claude Code's runSideQuestion / runForkedAgent pattern.
 */

import { ReplContext } from './context';
import { getProvider } from './ai/providers';
import * as fs from 'fs';
import * as path from 'path';

export interface SideQuestionResult {
  answer: string;
  error?: string;
}

/**
 * Build a concise project-context block so the side-question LLM can answer
 * about the codebase without needing tools. Reads package.json for version/engines.
 */
function buildProjectContext(ctx: ReplContext): string {
  const parts: string[] = [];

  parts.push(`Working directory: ${ctx.cwd}`);
  parts.push(`User: ${ctx.user?.email || 'unknown'} (tenantId: ${ctx.user?.tenantId || 'unknown'})`);
  if (ctx.activeProject) {
    parts.push(`Active project: "${ctx.activeProject.name}" (id: ${ctx.activeProject.id})`);
  }

  // Read package.json for name/version/engines
  try {
    const pkgPath = path.join(ctx.cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name) parts.push(`Project name: ${pkg.name}`);
      if (pkg.version) parts.push(`Version: ${pkg.version}`);
      if (pkg.engines?.node) parts.push(`Required Node.js: ${pkg.engines.node}`);
      if (pkg.description) parts.push(`Description: ${pkg.description}`);
    }
  } catch (err) { swallow(err); }

  // Imported rules from CLAUDE.md / AGENT.md
  if (ctx.importedRules) {
    const rules = ctx.importedRules.split('\n').filter(l => l.trim()).slice(0, 10).join('\n');
    parts.push(`Project rules:\n${rules}`);
  }

  return parts.join('\n');
}

/**
 * Send a quick question to the LLM with no tools, low effort, low maxTokens.
 * Tries sendSmall (fast tier) first, falls back to sendMessage.
 */
export async function runSideQuestion(question: string, ctx: ReplContext): Promise<SideQuestionResult> {
  const provider = getProvider(ctx.provider);
  const projectCtx = buildProjectContext(ctx);

  const system =
    `You are a helpful assistant answering a quick side question. The user is working on a coding project.

Project context:
${projectCtx}

Answer concisely in the language the question was asked (pt-BR, en, or es). Keep it short: 1-3 paragraphs max. If you don't know the answer based on the project context provided, say so.`;

  const messages = [{ role: 'user', content: question }] as any[];

  try {
    let resp: any = null;

    // Try fast tier first (cheaper, faster)
    if (provider.sendSmall) {
      resp = await provider.sendSmall({ system, messages, effort: 'low' });
    }

    // Fallback to full sendMessage
    if (!resp) {
      resp = await provider.sendMessage({
        system,
        messages,
        tools: [],
        effort: 'low',
        maxTokens: 500,
      });
    }

    const text = (resp.content || [])
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n')
      .trim();

    return { answer: text || '(empty response)' };
  } catch (err: any) {
    return { answer: '', error: err.message || String(err) };
  }
}
