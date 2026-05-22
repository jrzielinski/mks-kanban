/**
 * boilerplate-registry.ts
 *
 * Matches a project stack + difficulty level to a registered boilerplate.
 * Boilerplates are stored in ~/.makestudio/config.json under the "boilerplates" key.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig, saveConfig } from '../config/config';
import { BoilerplateEntry } from '../types';

// ── Default boilerplate definitions ──────────────────────────────────────────
// These are auto-registered when the user runs `makestudio boilerplate --setup`
// and has the boilerplates dir at ~/develop/boilerplates.

export const DEFAULT_BOILERPLATES: Omit<BoilerplateEntry, 'localPath'>[] = [
  {
    slug: 'api-minimal',
    name: 'API Minimal',
    stacks: ['express', 'node', 'api', 'rest', 'sqlite'],
    difficultyMin: 1,
    difficultyMax: 4,
    description: 'Minimal Express REST API with SQLite, Swagger and Zod validation',
  },
  {
    slug: 'bot-service',
    name: 'Bot Service',
    stacks: ['discord', 'telegram', 'bot', 'node'],
    difficultyMin: 2,
    difficultyMax: 5,
    description: 'Discord/Telegram bot service with TypeScript',
  },
  {
    slug: 'cli-tool',
    name: 'CLI Tool',
    stacks: ['cli', 'node', 'commander', 'terminal'],
    difficultyMin: 1,
    difficultyMax: 3,
    description: 'Node.js CLI tool with Commander, Chalk and Ora',
  },
  {
    slug: 'landing-page',
    name: 'Landing Page',
    stacks: ['html', 'css', 'javascript', 'landing', 'static'],
    difficultyMin: 1,
    difficultyMax: 2,
    description: 'Static HTML/CSS/JS landing page',
  },
  {
    slug: 'spa-frontend',
    name: 'SPA Frontend',
    stacks: ['react', 'vite', 'zustand', 'spa', 'frontend'],
    difficultyMin: 3,
    difficultyMax: 6,
    description: 'React SPA with Vite, Zustand, React Router and Tailwind',
  },
  {
    slug: 'saas-enterprise-frontend',
    name: 'SaaS Enterprise Frontend',
    stacks: ['react', 'vite', 'tanstack', 'i18n', 'enterprise', 'frontend'],
    difficultyMin: 6,
    difficultyMax: 10,
    description: 'React enterprise frontend with TanStack Query, i18n, Hookform',
  },
  {
    slug: 'fullstack-simple',
    name: 'Fullstack Simple',
    stacks: ['nestjs', 'react', 'postgresql', 'jwt', 'fullstack'],
    difficultyMin: 5,
    difficultyMax: 8,
    description: 'NestJS + React with JWT auth and PostgreSQL',
  },
  {
    slug: 'saas-starter',
    name: 'SaaS Starter',
    stacks: ['nestjs', 'react', 'postgresql', 'jwt', 'saas', 'rbac'],
    difficultyMin: 7,
    difficultyMax: 10,
    description: 'NestJS + React SaaS starter with RBAC and refresh tokens',
  },
  {
    slug: 'e-commerce',
    name: 'E-commerce',
    stacks: ['nestjs', 'react', 'postgresql', 'ecommerce', 'shop', 'store', 'loja'],
    difficultyMin: 7,
    difficultyMax: 11,
    description: 'NestJS + React e-commerce with cart, orders and payments',
  },
  {
    slug: 'marketplace',
    name: 'Marketplace',
    stacks: ['nestjs', 'react', 'postgresql', 'marketplace', 'multivendor'],
    difficultyMin: 9,
    difficultyMax: 13,
    description: 'NestJS + React marketplace with multi-vendor support',
  },
  {
    slug: 'mobile-app',
    name: 'Mobile App',
    stacks: ['nestjs', 'flutter', 'postgresql', 'mobile', 'dart'],
    difficultyMin: 6,
    difficultyMax: 10,
    description: 'NestJS API + Flutter mobile with JWT auth',
  },
  {
    slug: 'saas-multitenant',
    name: 'SaaS Multi-Tenant',
    stacks: ['nestjs', 'react', 'postgresql', 'multitenant', 'saas', 'rbac', 'tenant'],
    difficultyMin: 10,
    difficultyMax: 14,
    description: 'NestJS + React multi-tenant SaaS with row-level isolation',
  },
  {
    slug: 'saas-enterprise-backend',
    name: 'SaaS Enterprise Backend',
    stacks: ['nestjs', 'postgresql', 'redis', 'bull', 'queue', 'websocket', 'socket.io', 's3', '2fa', 'enterprise'],
    difficultyMin: 10,
    difficultyMax: 16,
    description: 'NestJS enterprise: auth, RBAC, 2FA, Redis, Bull queues, WebSocket, S3, i18n',
  },
  {
    slug: 'fullstack-mobile',
    name: 'Fullstack Mobile',
    stacks: ['nestjs', 'react', 'flutter', 'postgresql', 'mobile', 'fullstack', 'dart'],
    difficultyMin: 11,
    difficultyMax: 16,
    description: 'NestJS API + React Web + Flutter Mobile — full three-layer stack',
  },
  {
    slug: 'saas-multitenant-mobile',
    name: 'SaaS Multi-Tenant + Mobile',
    stacks: [
      'nestjs', 'react', 'flutter', 'postgresql', 'redis',
      'multitenant', 'tenant', 'saas', 'rbac', 'membership', 'workspace', 'slack',
      'mobile', 'fullstack', 'dart',
    ],
    difficultyMin: 12,
    difficultyMax: 18,
    description:
      'Slack-style multi-tenant SaaS: NestJS API + React web + Flutter mobile, with workspaces, memberships, workspace switcher, and per-tenant RBAC',
  },
  {
    slug: 'java-api',
    name: 'Java API (Spring Boot)',
    stacks: ['java', 'spring', 'spring boot', 'springboot', 'maven', 'postgresql', 'jwt', 'mapstruct'],
    difficultyMin: 5,
    difficultyMax: 8,
    description: 'Spring Boot 3.4 REST API with JWT, Spring Security, PostgreSQL, MapStruct, Swagger and Docker',
  },
  {
    slug: 'go-api',
    name: 'Go API (Multi-Tenant)',
    stacks: ['go', 'golang', 'gin', 'gorm', 'postgresql', 'redis', 'rbac', 'multitenant', 'jwt'],
    difficultyMin: 9,
    difficultyMax: 13,
    description: 'Go + Gin multi-tenant REST API with JWT, RBAC, Redis, PostgreSQL and row-level isolation',
  },
];

// ── Registry API ──────────────────────────────────────────────────────────────

export function getBoilerplates(): BoilerplateEntry[] {
  const config = loadConfig();
  return config?.boilerplates || [];
}

export function addBoilerplate(entry: BoilerplateEntry): void {
  const config = loadConfig();
  if (!config) throw new Error('Config not found. Run makestudio start first.');
  const existing = (config.boilerplates || []).filter(b => b.slug !== entry.slug);
  saveConfig({ ...config, boilerplates: [...existing, entry] });
}

export function removeBoilerplate(slug: string): boolean {
  const config = loadConfig();
  if (!config) return false;
  const before = (config.boilerplates || []).length;
  const updated = (config.boilerplates || []).filter(b => b.slug !== slug);
  saveConfig({ ...config, boilerplates: updated });
  return updated.length < before;
}

/**
 * Auto-register ALL boilerplates found in the given base directory.
 * Uses DEFAULT_BOILERPLATES only to enrich metadata — unknown folders are still registered.
 * Stack info is auto-detected from package.json / pom.xml / go.mod / pubspec.yaml when no
 * predefined entry exists.
 */
export function setupBoilerplates(baseDir: string): { registered: string[]; skipped: string[] } {
  const registered: string[] = [];
  const skipped: string[] = [];

  if (!fs.existsSync(baseDir)) {
    return { registered, skipped };
  }

  // Skip dotdirs (.git, .github, .vscode, …) and obviously-not-a-boilerplate
  // helper dirs that live alongside the real ones.
  const SKIP_DIRS = new Set(['docs', 'tools', 'scripts']);
  const entries = fs.readdirSync(baseDir).filter((e) => {
    if (e.startsWith('.')) return false;
    if (SKIP_DIRS.has(e)) return false;
    try {
      return fs.statSync(path.join(baseDir, e)).isDirectory();
    } catch {
      return false;
    }
  });

  for (const dirName of entries) {
    const localPath = path.join(baseDir, dirName);

    // Use predefined metadata if available, otherwise auto-detect
    const def = DEFAULT_BOILERPLATES.find(b => b.slug === dirName || b.slug === dirName.replace(/-boilerplate$/, ''));

    const entry: BoilerplateEntry = def
      ? { ...def, localPath }
      : {
          slug: dirName,
          name: dirName,
          localPath,
          stacks: detectStacks(localPath),
          description: `Boilerplate: ${dirName}`,
        };

    addBoilerplate(entry);
    registered.push(dirName);
  }

  return { registered, skipped };
}

/**
 * Auto-detect technology stacks by inspecting files in the boilerplate directory.
 */
function detectStacks(dir: string): string[] {
  const stacks: string[] = [];

  const has = (filename: string) => fs.existsSync(path.join(dir, filename));
  const hasIn = (subdir: string, filename: string) => fs.existsSync(path.join(dir, subdir, filename));
  const readJson = (filepath: string): any => {
    try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); } catch { return {}; }
  };

  // Go
  if (has('go.mod')) stacks.push('go', 'golang');

  // Java / Spring Boot
  if (has('pom.xml')) {
    stacks.push('java', 'maven');
    const pom = fs.readFileSync(path.join(dir, 'pom.xml'), 'utf8');
    if (pom.includes('spring-boot')) stacks.push('spring', 'spring boot');
  }
  if (has('build.gradle') || has('build.gradle.kts')) stacks.push('java', 'gradle');

  // Node.js / detect frameworks from package.json
  const pkgPaths = [
    path.join(dir, 'package.json'),
    path.join(dir, 'backend', 'package.json'),
    path.join(dir, 'api', 'package.json'),
  ];
  for (const pkgPath of pkgPaths) {
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = readJson(pkgPath);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['@nestjs/core']) stacks.push('nestjs');
    if (deps['express']) stacks.push('express');
    if (deps['fastify']) stacks.push('fastify');
    if (deps['react']) stacks.push('react');
    if (deps['next']) stacks.push('nextjs', 'next');
    if (deps['vue']) stacks.push('vue');
    if (deps['discord.js'] || deps['telegraf']) stacks.push('bot');
    if (deps['commander']) stacks.push('cli');
    if (stacks.length > 0) stacks.push('node');
  }

  // Flutter
  const pubspecPaths = [
    path.join(dir, 'pubspec.yaml'),
    path.join(dir, 'app', 'pubspec.yaml'),
    path.join(dir, 'mobile', 'pubspec.yaml'),
  ];
  if (pubspecPaths.some(p => fs.existsSync(p))) stacks.push('flutter', 'dart', 'mobile');

  // Frontend only (no backend)
  if (has('index.html') && !has('package.json')) stacks.push('html', 'static');

  return [...new Set(stacks)]; // deduplicate
}

// ── Stack matching ─────────────────────────────────────────────────────────────

/**
 * Given a project stack string and optional difficulty level,
 * find the best matching boilerplate.
 *
 * Scoring:
 * - +10 per matching stack keyword
 * - +20 bonus if difficulty falls within difficultyMin/difficultyMax
 * - -5 penalty if difficulty is outside range
 */
/** Pure: tokenize a free-form stack string into lowercase keywords. */
export function tokenizeStack(stack: string): string[] {
  return stack
    .toLowerCase()
    .replace(/[,+|;/\\]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Pure: score a single boilerplate against tokens and optional difficulty. */
export function scoreBoilerplate(
  boilerplate: BoilerplateEntry,
  stackTokens: string[],
  difficulty?: number,
): number {
  let score = 0;
  for (const token of stackTokens) {
    if (boilerplate.stacks.some((s) => s.includes(token) || token.includes(s))) {
      score += 10;
    }
  }
  if (difficulty !== undefined) {
    const min = boilerplate.difficultyMin ?? 0;
    const max = boilerplate.difficultyMax ?? 99;
    if (difficulty >= min && difficulty <= max) score += 20;
    else score -= 5;
  }
  return score;
}

/**
 * Pure: given a list of candidate boilerplates (already filtered to those
 * that exist on disk), stack tokens and difficulty, return the highest
 * scoring entry or null when no candidate reaches a positive score.
 */
export function pickBestBoilerplate(
  candidates: BoilerplateEntry[],
  stackTokens: string[],
  difficulty?: number,
): BoilerplateEntry | null {
  if (candidates.length === 0) return null;
  const scored = candidates.map((b) => ({
    boilerplate: b,
    score: scoreBoilerplate(b, stackTokens, difficulty),
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score <= 0) return null;
  return best.boilerplate;
}

export function findBestBoilerplate(
  projectStack: string,
  difficulty?: number,
): BoilerplateEntry | null {
  const boilerplates = getBoilerplates().filter((b) => fs.existsSync(b.localPath));
  return pickBestBoilerplate(boilerplates, tokenizeStack(projectStack), difficulty);
}

/**
 * Copy a boilerplate to a target directory (excludes node_modules, dist, .git).
 */
export function copyBoilerplate(boilerplate: BoilerplateEntry, targetDir: string): void {
  if (!fs.existsSync(boilerplate.localPath)) {
    throw new Error(`Boilerplate path not found: ${boilerplate.localPath}`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  copyDirRecursive(boilerplate.localPath, targetDir);
}

function copyDirRecursive(src: string, dest: string): void {
  const EXCLUDE = new Set(['.git', 'node_modules', 'dist', 'build', '.dart_tool', '.flutter-plugins', '.flutter-plugins-dependencies']);

  const entries = fs.readdirSync(src);
  for (const entry of entries) {
    if (EXCLUDE.has(entry)) continue;
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Returns the default boilerplates base directory based on known locations.
 */
export function detectBoilerplatesBaseDir(): string | null {
  const candidates = [
    path.join(os.homedir(), 'develop', 'boilerplates'),
    path.join(os.homedir(), 'boilerplates'),
    path.join(os.homedir(), 'projects', 'boilerplates'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}
