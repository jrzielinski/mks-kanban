/**
 * context-writer.ts
 *
 * Materializes project context as markdown files inside the repo's .makestudio/context/ directory.
 * The CLI (Claude/Codex/Gemini) reads these files instead of receiving everything inline in the prompt.
 * This keeps the prompt clean and allows the CLI to process large amounts of context.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pluginRegistry } from './plugin-registry';
import { logInfo, logError } from '../ui/terminal';

export interface ContextData {
  projectName: string;
  briefing?: string;
  specDocument?: any;
  requirements: Array<{
    id: string;
    title: string;
    description: string;
    type: string;
    priority: string;
    tag?: string;
    source?: string;
    acceptanceCriteria?: string[];
  }>;
  /** ALL project requirements — used for DUM-001/DUM-002 master context (not filtered by range) */
  allRequirements?: Array<{
    id: string;
    title: string;
    description: string;
    type: string;
    priority: string;
    tag?: string;
    source?: string;
  }>;
  stack?: {
    backend?: string[];
    frontend?: string[];
    mobile?: string[];
    database?: string[];
    infra?: string[];
  };
  existingDums?: Array<{
    id: string;
    title: string;
    dumNumber?: string;
    description?: string;
    tasks?: string[];
  }>;
  codebaseAnalysis?: any;
  decompositionRules?: string;
  // Full context sections (same as LLM API buildPrompt)
  boilerplateContext?: string | null;
  decisions?: Array<{ id: string; title: string; status: string; rationale?: string; decisionNumber?: number }>;
  designSystem?: any;
  clarifications?: Array<{ question: string; status: string; response?: string }>;
  textResults?: Array<{ title: string; snippet?: string; url?: string }>;
  imageResults?: Array<{ title: string; imageUrl: string; sourceUrl?: string }>;
  flowBuilderContext?: any;
  existingDumsRaw?: any[];  // Full DUM objects for the memory/ directory
}

export interface ContextFilesResult {
  dir: string;
  files: string[];
  totalSizeKB: number;
}

const CONTEXT_DIR = '.makestudio/context';

/**
 * Write all project context as markdown files inside the repo.
 */
export async function writeContextFiles(repoPath: string, data: ContextData): Promise<ContextFilesResult> {
  const dir = path.join(repoPath, CONTEXT_DIR);
  fs.mkdirSync(dir, { recursive: true });

  const files: string[] = [];
  let totalBytes = 0;

  // 1. Briefing
  if (data.briefing) {
    const content = `# Project Briefing: ${data.projectName}\n\n${data.briefing}`;
    const filePath = path.join(dir, 'briefing.md');
    fs.writeFileSync(filePath, content, 'utf8');
    files.push('briefing.md');
    totalBytes += Buffer.byteLength(content);
  }

  // 2. Specification (DUM-001)
  if (data.specDocument) {
    const content = formatSpec(data.projectName, data.specDocument);
    const filePath = path.join(dir, 'spec.md');
    fs.writeFileSync(filePath, content, 'utf8');
    files.push('spec.md');
    totalBytes += Buffer.byteLength(content);
  }

  // 3. Requirements (selected range — what agent will decompose into feature DUMs)
  if (data.requirements?.length) {
    const content = formatRequirements(data.requirements);
    const filePath = path.join(dir, 'requirements.md');
    fs.writeFileSync(filePath, content, 'utf8');
    files.push('requirements.md');
    totalBytes += Buffer.byteLength(content);
  }

  // 3b. All requirements (full list — used by DUM-001 master and DUM-002 for complete context)
  if (data.allRequirements?.length) {
    const content = formatRequirements(data.allRequirements as ContextData['requirements']);
    const filePath = path.join(dir, 'all-requirements.md');
    fs.writeFileSync(filePath, content, 'utf8');
    files.push('all-requirements.md');
    totalBytes += Buffer.byteLength(content);
  }

  // 4. Stack
  if (data.stack) {
    const content = formatStack(data.stack);
    if (content) {
      const filePath = path.join(dir, 'stack.md');
      fs.writeFileSync(filePath, content, 'utf8');
      files.push('stack.md');
      totalBytes += Buffer.byteLength(content);
    }
  }

  // 5. Existing DUMs — summary markdown
  if (data.existingDums?.length) {
    const content = formatExistingDums(data.existingDums);
    const filePath = path.join(dir, 'existing-dums.md');
    fs.writeFileSync(filePath, content, 'utf8');
    files.push('existing-dums.md');
    totalBytes += Buffer.byteLength(content);
  }

  // 5b. Existing DUMs — full JSON in context/memory/ for deep analysis
  // NEVER overwrite existing memory files — local-generated DUMs are always higher quality
  if (data.existingDumsRaw?.length) {
    const memoryDir = path.join(dir, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    let written = 0;
    for (const dum of data.existingDumsRaw) {
      const dumId = dum.dumNumber?.toLowerCase().replace('-', '_') || dum.id;
      const fileName = `${dumId}.json`;
      const destPath = path.join(memoryDir, fileName);
      // Skip if file already exists — local version is always better than backend summary
      if (fs.existsSync(destPath)) continue;
      const content = JSON.stringify(dum, null, 2);
      fs.writeFileSync(destPath, content, 'utf8');
      totalBytes += Buffer.byteLength(content);
      written++;
    }
    if (written > 0) files.push(`memory/ (${written} DUMs novos do backend)`);
  }

  // 6. Codebase Analysis
  if (data.codebaseAnalysis) {
    const content = formatCodebaseAnalysis(data.codebaseAnalysis);
    if (content) {
      const filePath = path.join(dir, 'codebase-analysis.md');
      fs.writeFileSync(filePath, content, 'utf8');
      files.push('codebase-analysis.md');
      totalBytes += Buffer.byteLength(content);
    }
  }

  // 7. Decomposition Rules (from backend — single source of truth)
  if (data.decompositionRules) {
    const filePath = path.join(dir, 'decomposition-rules.md');
    fs.writeFileSync(filePath, data.decompositionRules, 'utf8');
    files.push('decomposition-rules.md');
    totalBytes += Buffer.byteLength(data.decompositionRules);
  }

  // 8. Boilerplate Context (existing code — DO NOT RECREATE)
  if (data.boilerplateContext) {
    const content = `# Boilerplate — Existing Code (DO NOT RECREATE)\n\n${data.boilerplateContext}`;
    const filePath = path.join(dir, 'boilerplate.md');
    fs.writeFileSync(filePath, content, 'utf8');
    files.push('boilerplate.md');
    totalBytes += Buffer.byteLength(content);
  }

  // 9. Architectural Decisions
  if (data.decisions?.length) {
    const lines = data.decisions.filter((d) => d.title).map((d) =>
      `### Decision #${d.decisionNumber || d.id?.slice(0, 8) || '?'} [${d.status || 'pending'}]: ${d.title}${d.rationale ? `\n${d.rationale}` : ''}`
    );
    const content = `# Architectural Decisions\n\n${lines.join('\n\n')}`;
    const filePath = path.join(dir, 'decisions.md');
    fs.writeFileSync(filePath, content, 'utf8');
    files.push('decisions.md');
    totalBytes += Buffer.byteLength(content);
  }

  // 10. Design System
  if (data.designSystem) {
    const ds = data.designSystem;
    const parts: string[] = ['# Design System\n'];
    if (ds.colors) parts.push(`## Colors\n${JSON.stringify(ds.colors, null, 2)}\n`);
    if (ds.typography) parts.push(`## Typography\n${JSON.stringify(ds.typography, null, 2)}\n`);
    if (ds.spacing) parts.push(`## Spacing\n${JSON.stringify(ds.spacing, null, 2)}\n`);
    if (ds.components) parts.push(`## Components\n${JSON.stringify(ds.components, null, 2)}\n`);
    if (parts.length > 1) {
      const content = parts.join('\n');
      const filePath = path.join(dir, 'design-system.md');
      fs.writeFileSync(filePath, content, 'utf8');
      files.push('design-system.md');
      totalBytes += Buffer.byteLength(content);
    }
  }

  // 11. Clarifications
  if (data.clarifications?.length) {
    const lines = data.clarifications.map((c) =>
      `- **[${c.status}]** ${c.question}${c.response ? `\n  → ${c.response}` : ''}`
    );
    const content = `# Pending Clarifications\n\n${lines.join('\n')}`;
    const filePath = path.join(dir, 'clarifications.md');
    fs.writeFileSync(filePath, content, 'utf8');
    files.push('clarifications.md');
    totalBytes += Buffer.byteLength(content);
  }

  // 12. Web Search Results (market research)
  if (data.textResults?.length) {
    const lines = data.textResults.map((r) => `- **${r.title}**: ${r.snippet || ''}`);
    const content = `# Market Research\n\n${lines.join('\n')}`;
    const filePath = path.join(dir, 'market-research.md');
    fs.writeFileSync(filePath, content, 'utf8');
    files.push('market-research.md');
    totalBytes += Buffer.byteLength(content);
  }

  // 13. Visual References (images)
  if (data.imageResults?.length) {
    const lines = data.imageResults.map((img) =>
      `- **${img.title || 'Reference'}**: ${img.imageUrl}${img.sourceUrl ? `\n  Source: ${img.sourceUrl}` : ''}`
    );
    const content = `# Visual References\n\n${lines.join('\n')}`;
    const filePath = path.join(dir, 'visual-references.md');
    fs.writeFileSync(filePath, content, 'utf8');
    files.push('visual-references.md');
    totalBytes += Buffer.byteLength(content);
  }

  // 14. FlowBuilder Context
  if (data.flowBuilderContext) {
    const content = typeof data.flowBuilderContext === 'string'
      ? data.flowBuilderContext
      : `# FlowBuilder Context\n\n${JSON.stringify(data.flowBuilderContext, null, 2)}`;
    const filePath = path.join(dir, 'flowbuilder.md');
    fs.writeFileSync(filePath, content, 'utf8');
    files.push('flowbuilder.md');
    totalBytes += Buffer.byteLength(content);
  }

  // 15. Plugin context providers
  const pluginProviders = pluginRegistry.getContextProviders();
  for (const provider of pluginProviders) {
    try {
      const content = await provider.generate(undefined, repoPath);
      if (content) {
        const filePath = path.join(dir, provider.fileName);
        fs.writeFileSync(filePath, content, 'utf8');
        files.push(provider.fileName);
        totalBytes += Buffer.byteLength(content);
        logInfo(`[context] Plugin provider "${provider.name}" wrote ${provider.fileName}`);
      }
    } catch (err: any) {
      logError(`[context] Plugin provider "${provider.name}" failed: ${err.message}`);
    }
  }

  return {
    dir,
    files,
    totalSizeKB: Math.round(totalBytes / 1024),
  };
}

/**
 * Ensure .makestudio/ is in .gitignore
 */
export function ensureGitignore(repoPath: string): void {
  const gitignorePath = path.join(repoPath, '.gitignore');
  const entry = '.makestudio/';

  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    if (content.includes(entry)) return;
    fs.appendFileSync(gitignorePath, `\n# MakeStudio working files\n${entry}\n`);
  } else {
    fs.writeFileSync(gitignorePath, `# MakeStudio working files\n${entry}\n`, 'utf8');
  }
}

/**
 * Remove .makestudio/context/ directory
 */
export function cleanupContextFiles(repoPath: string): void {
  const dir = path.join(repoPath, CONTEXT_DIR);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Formatters ──────────────────────────────────────────

function formatSpec(projectName: string, spec: any): string {
  const parts: string[] = [`# Project Specification: ${projectName}\n`];

  if (spec.projectGoals?.length) {
    parts.push(`## Project Goals\n${spec.projectGoals.map((g: string) => `- ${g}`).join('\n')}\n`);
  }

  if (spec.userPersonas?.length) {
    parts.push(`## User Personas\n${spec.userPersonas.map((p: any) =>
      `### ${p.name}\n${p.description}${p.goals ? `\n**Goals:** ${p.goals}` : ''}`
    ).join('\n\n')}\n`);
  }

  if (spec.functionalAreas?.length) {
    parts.push(`## Functional Areas (${spec.functionalAreas.length})\n${spec.functionalAreas.map((a: any) =>
      `### ${a.name}\n${a.description}${a.features?.length ? `\n\n**Features:**\n${a.features.map((f: string) => `- ${f}`).join('\n')}` : ''}`
    ).join('\n\n')}\n`);
  }

  if (spec.nonFunctionalRequirements?.length) {
    parts.push(`## Non-Functional Requirements\n${spec.nonFunctionalRequirements.map((n: any) =>
      `- **[${n.category}]** ${n.description}`
    ).join('\n')}\n`);
  }

  if (spec.constraints?.length) {
    parts.push(`## Constraints\n${spec.constraints.map((c: string) => `- ${c}`).join('\n')}\n`);
  }

  if (spec.outOfScope?.length) {
    parts.push(`## Out of Scope\n${spec.outOfScope.map((o: string) => `- ${o}`).join('\n')}\n`);
  }

  if (spec.successCriteria?.length) {
    parts.push(`## Success Criteria\n${spec.successCriteria.map((s: string) => `- ${s}`).join('\n')}\n`);
  }

  return parts.join('\n');
}

export function formatRequirements(requirements: ContextData['requirements']): string {
  const functional = requirements.filter(r => r.source !== 'audit');
  const audit = requirements.filter(r => r.source === 'audit');

  const parts: string[] = ['# Requirements\n'];

  if (functional.length) {
    parts.push(`## Functional Requirements (${functional.length})\n`);
    for (const r of functional) {
      parts.push(`### [${r.id}] ${r.title}`);
      parts.push(`**Type:** ${r.type} | **Priority:** ${r.priority} | **Tag:** ${r.tag || 'mixed'}\n`);
      parts.push(`**Description:**\n${r.description}\n`);
      if (r.acceptanceCriteria?.length) {
        parts.push(`**Acceptance Criteria:**`);
        for (const c of r.acceptanceCriteria) {
          parts.push(`- ${c}`);
        }
        parts.push('');
      }
      parts.push('---\n');
    }
  }

  if (audit.length) {
    parts.push(`## Audit Requirements — Technical Corrections (${audit.length})\n`);
    for (const r of audit) {
      parts.push(`### [${r.id}] ${r.title}`);
      parts.push(`**Type:** ${r.type} | **Priority:** ${r.priority} | **Tag:** ${r.tag || 'mixed'}\n`);
      parts.push(`**Description:**\n${r.description}\n`);
      parts.push('---\n');
    }
  }

  return parts.join('\n');
}

export function formatStack(stack: ContextData['stack']): string | null {
  if (!stack) return null;
  const parts: string[] = ['# Technology Stack\n'];
  if (stack.backend?.length) parts.push(`## Backend\n${stack.backend.map(t => `- ${t}`).join('\n')}\n`);
  if (stack.frontend?.length) parts.push(`## Frontend\n${stack.frontend.map(t => `- ${t}`).join('\n')}\n`);
  if (stack.mobile?.length) parts.push(`## Mobile\n${stack.mobile.map(t => `- ${t}`).join('\n')}\n`);
  if (stack.database?.length) parts.push(`## Database\n${stack.database.map(t => `- ${t}`).join('\n')}\n`);
  if (stack.infra?.length) parts.push(`## Infrastructure\n${stack.infra.map(t => `- ${t}`).join('\n')}\n`);
  return parts.length > 1 ? parts.join('\n') : null;
}

export function formatExistingDums(dums: ContextData['existingDums']): string {
  if (!dums?.length) return '';
  const parts: string[] = ['# Existing DUMs — DO NOT DUPLICATE\n'];
  for (const d of dums) {
    parts.push(`## ${d.dumNumber || d.id}: ${d.title}`);
    if (d.description) parts.push(`${d.description.substring(0, 300)}...\n`);
    if (d.tasks?.length) {
      parts.push(`**Tasks already created:**`);
      for (const t of d.tasks) {
        parts.push(`- ${t}`);
      }
      parts.push('');
    }
    parts.push('---\n');
  }
  return parts.join('\n');
}

function formatCodebaseAnalysis(ca: any): string | null {
  if (!ca) return null;

  // If analysis has pre-generated markdown content (from CLI auto-analysis), use it directly
  if (ca.content && typeof ca.content === 'string' && ca.content.length > 100) {
    return ca.content;
  }

  // Otherwise, format from structured data (entities, endpoints, etc.)
  const parts: string[] = ['# Codebase Analysis\n'];

  if (ca.entities?.length) {
    parts.push(`## Entities (${ca.entities.length})\n`);
    for (const e of ca.entities.slice(0, 50)) {
      parts.push(`- **${e.name}** (${e.file}): ${(e.fields || []).slice(0, 15).join(', ')}`);
    }
    parts.push('');
  }

  if (ca.endpoints?.length) {
    parts.push(`## API Endpoints (${ca.endpoints.length})\n`);
    for (const ep of ca.endpoints.slice(0, 50)) {
      parts.push(`- \`${ep.method} ${ep.path}\` → ${ep.handler || ''}`);
    }
    parts.push('');
  }

  if (ca.components?.length) {
    parts.push(`## UI Components (${ca.components.length})\n`);
    for (const c of ca.components.slice(0, 30)) {
      parts.push(`- ${c.name} (${c.file})`);
    }
    parts.push('');
  }

  if (ca.services?.length) {
    parts.push(`## Services (${ca.services.length})\n`);
    for (const s of ca.services.slice(0, 30)) {
      parts.push(`- ${s.name} (${s.file})`);
    }
    parts.push('');
  }

  return parts.length > 1 ? parts.join('\n') : null;
}
