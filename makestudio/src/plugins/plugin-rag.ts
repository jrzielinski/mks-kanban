import { swallow } from '../utils/log';
/**
 * plugin-rag — Local RAG (Retrieval Augmented Generation) context provider.
 * Indexes project markdown docs and retrieves most relevant chunks for the current task.
 *
 * Uses a lightweight TF-IDF approach (no external deps) for local retrieval.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';
import { TaskDispatch } from '../types';

interface DocChunk {
  file: string;
  section: string;
  content: string;
  score?: number;
}

let indexedChunks: DocChunk[] = [];
let lastTaskPrompt: string = '';

// ── Lightweight TF-IDF ──────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

function computeTFIDF(query: string, chunks: DocChunk[]): DocChunk[] {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  // Document frequency
  const df: Record<string, number> = {};
  for (const chunk of chunks) {
    const tokens = new Set(tokenize(chunk.content));
    for (const t of tokens) {
      df[t] = (df[t] || 0) + 1;
    }
  }

  const N = chunks.length;

  // Score each chunk
  const scored = chunks.map(chunk => {
    const tokens = tokenize(chunk.content);
    const tf: Record<string, number> = {};
    for (const t of tokens) { tf[t] = (tf[t] || 0) + 1; }

    let score = 0;
    for (const qt of queryTokens) {
      if (tf[qt]) {
        const termFreq = tf[qt] / tokens.length;
        const invDocFreq = Math.log(N / (df[qt] || 1));
        score += termFreq * invDocFreq;
      }
    }

    return { ...chunk, score };
  });

  return scored
    .filter(c => (c.score || 0) > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 10); // Top 10 chunks
}

// ── Document Indexer ────────────────────────────────────────────

function indexDocs(repoPath: string): DocChunk[] {
  const chunks: DocChunk[] = [];
  const docDirs = ['docs', 'doc', 'wiki', '.makestudio/context', 'README.md'];

  const processFile = (filePath: string) => {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (content.length < 50) return; // Skip tiny files

      const relPath = path.relative(repoPath, filePath);

      // Split by headers for granular chunks
      const sections = content.split(/^#{1,3}\s+/m);
      let currentSection = path.basename(filePath, path.extname(filePath));

      for (const section of sections) {
        const lines = section.split('\n');
        const title = lines[0]?.trim() || currentSection;
        const body = lines.slice(1).join('\n').trim();

        if (body.length > 30) {
          chunks.push({
            file: relPath,
            section: title,
            content: body.substring(0, 2000), // Cap per chunk
          });
        }
        currentSection = title;
      }
    } catch (err) { swallow(err); }
  };

  const walkDir = (dir: string, depth: number = 0) => {
    if (depth > 3) return; // Max depth
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath, depth + 1);
        } else if (/\.(md|txt|rst)$/i.test(entry.name)) {
          processFile(fullPath);
        }
      }
    } catch (err) { swallow(err); }
  };

  for (const docDir of docDirs) {
    const fullPath = path.join(repoPath, docDir);
    if (fs.existsSync(fullPath)) {
      if (fs.statSync(fullPath).isDirectory()) {
        walkDir(fullPath);
      } else {
        processFile(fullPath);
      }
    }
  }

  // Also index CLAUDE.md, MAKESTUDIO.md, CONTRIBUTING.md
  for (const rootDoc of ['CLAUDE.md', 'MAKESTUDIO.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md']) {
    const fullPath = path.join(repoPath, rootDoc);
    if (fs.existsSync(fullPath)) processFile(fullPath);
  }

  return chunks;
}

const plugin: MakeStudioPlugin = {
  name: 'rag',
  version: '1.0.0',
  description: 'Local RAG — retrieve relevant documentation chunks as AI context',

  hooks: {
    async beforeTaskExec(task: TaskDispatch): Promise<TaskDispatch> {
      // Capture prompt for RAG retrieval in context provider
      lastTaskPrompt = task.prompt || task.taskTitle || '';
      return task;
    },
  },

  contextProviders: [
    {
      name: 'rag-docs',
      fileName: 'relevant-docs.md',

      async generate(_projectId?: string, repoPath?: string): Promise<string | null> {
        const basePath = repoPath || process.cwd();

        // Index docs if not done yet
        if (indexedChunks.length === 0) {
          indexedChunks = indexDocs(basePath);
        }

        if (indexedChunks.length === 0) return null;
        if (!lastTaskPrompt) return null;

        // Retrieve relevant chunks
        const relevant = computeTFIDF(lastTaskPrompt, indexedChunks);
        if (relevant.length === 0) return null;

        const lines: string[] = [
          '# Relevant Documentation (RAG)',
          '',
          `> ${relevant.length} relevant section(s) from ${indexedChunks.length} indexed chunks`,
          '',
        ];

        for (const chunk of relevant) {
          lines.push(`## ${chunk.section}`);
          lines.push(`*Source: ${chunk.file}*`);
          lines.push('');
          lines.push(chunk.content);
          lines.push('');
          lines.push('---');
          lines.push('');
        }

        return lines.join('\n');
      },
    },
  ],
};

export default plugin;
