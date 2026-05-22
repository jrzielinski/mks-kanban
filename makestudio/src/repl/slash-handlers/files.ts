/**
 * Slash command handler — /files
 *
 * Lists files in the current context (read via Read tool) with a tree view.
 * Inspired by Claude Code's /files command, ported to MakeStudio.
 *
 * Usage:
 *   /files           — show files in context (tree view)
 *   /files --all     — show all project files via git ls-files
 *   /files --count   — just show file count
 *   /files --size    — include file sizes
 *   /files top       — show only top-level files (cwd)
 *   /files <filter>  — filter by path/name (case-insensitive substring)
 */
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import {
  dim, green, cyan, yellow, bold,
} from '../slash-utils';
import type { SlashCommand, SlashContext } from '../slash-registry';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

type TreeNode = { name: string; isDir: boolean; children: TreeNode[] };

function addToTree(root: TreeNode[], parts: string[], index: number): void {
  if (index >= parts.length) return;
  const name = parts[index];
  const isDir = index < parts.length - 1;
  let child = root.find(n => n.name === name && n.isDir === isDir);
  if (!child) {
    child = { name, isDir, children: [] };
    root.push(child);
  }
  if (isDir) addToTree(child.children, parts, index + 1);
}

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.isDir && !b.isDir) return -1;
  if (!a.isDir && b.isDir) return 1;
  return a.name.localeCompare(b.name);
}

function renderTree(
  nodes: TreeNode[],
  prefix: string,
  showSize: boolean,
  cache: Map<string, { mtime: number; size: number }>,
  parentPath: string,
  lines: string[],
): void {
  const sorted = [...nodes].sort(compareNodes);
  for (let i = 0; i < sorted.length; i++) {
    const node = sorted[i];
    const isLast = i === sorted.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const fullPath = path.join(parentPath, node.name);

    if (node.isDir) {
      lines.push(`${prefix}${connector}${bold(node.name + '/')}`);
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      renderTree(node.children, childPrefix, showSize, cache, fullPath, lines);
    } else {
      const meta = cache.get(fullPath);
      const sizeSuffix = showSize && meta ? ` ${dim(formatSize(meta.size))}` : '';
      lines.push(`${prefix}${connector}${cyan(node.name)}${sizeSuffix}`);
    }
  }
}

function buildTree(paths: string[], cwd: string, showSize: boolean, cache: Map<string, { mtime: number; size: number }>): string[] {
  const root: TreeNode[] = [];

  for (const p of paths) {
    const rel = path.relative(cwd, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const parts = rel.split(path.sep).filter(Boolean);
    addToTree(root, parts, 0);
  }

  const lines: string[] = [];
  renderTree(root, '  ', showSize, cache, cwd, lines);
  return lines;
}

async function listAllFiles(cwd: string): Promise<string[]> {
  try {
    const stdout = execFileSync('git', ['ls-files', '--recurse-submodules'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return stdout.trim().split('\n').filter(Boolean).map(f => path.resolve(cwd, f));
  } catch {
    return [];
  }
}

async function handleSlashFiles(sc: SlashContext): Promise<void> {
  const { ctx, rest } = sc;
  const args = rest.map(a => a.toLowerCase());

  const showAll = args.includes('--all');
  const showCount = args.includes('--count');
  const showSize = args.includes('--size');
  const topOnly = args.includes('top');
  const filter = args.find(a => !a.startsWith('--') && a !== 'top');

  // Get read files from the readPaths tracking (file-tools Read tool)
  const { getReadPaths } = await import('../ai/file-tools/path-utils');
  let readPaths = getReadPaths(ctx);

  if (showAll) {
    // Use git ls-files to list all project files
    const projectFiles = await listAllFiles(ctx.cwd);
    if (projectFiles.length === 0) {
      console.log(`  ${yellow('!')} Not a git repo or git unavailable. Showing read files instead.`);
    } else {
      readPaths = projectFiles;
    }
  }

  if (filter) {
    readPaths = readPaths.filter(p => p.toLowerCase().includes(filter));
  }

  if (topOnly) {
    // Only show files directly in cwd (1 level deep)
    readPaths = readPaths.filter(p => {
      const rel = path.relative(ctx.cwd, p);
      return !rel.startsWith('..') && !rel.includes(path.sep);
    });
  }

  if (showCount) {
    console.log(`  ${dim('Files in context:')} ${cyan(String(readPaths.length))}`);
    return;
  }

  if (readPaths.length === 0) {
    console.log(`  ${dim('No files in context. Use the Read tool to load files first.')}`);
    return;
  }

  // Build ONE string; each console.log is a separate TUI message with margin,
  // so multi-log adds blank lines between tree items.
  const lines = buildTree(readPaths, ctx.cwd, showSize, ctx.readCache);
  const output = [
    `  ${bold('Files in context')} ${dim(`(${readPaths.length})`)}`,
    ...lines,
    `  ${dim('Use /files --all to see project files, /files --count for count,')}`,
    `  ${dim('/files <filter> to search, /files top for cwd-only.')}`,
  ].join('\n');
  console.log(output);
}

export const FILES_SLASH_COMMANDS: SlashCommand[] = [
  { names: ['/files'], handler: handleSlashFiles },
];
