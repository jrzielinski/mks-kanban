import { swallow } from '../utils/log';
/**
 * Memory system — persistent knowledge with LRU eviction and auto-truncation.
 *
 * Structure:
 *   ~/.makestudio/memory/MEMORY.md         ← index (max 200 lines, regenerated)
 *   ~/.makestudio/memory/topic_<slug>.md   ← topic files with frontmatter
 *
 * Policies:
 *   - MAX_TOPICS: 500. When exceeded, evict LRU (least recently + least frequent).
 *   - TOPIC_MAX_CHARS: 4000. Larger topics get their body stored in a separate
 *     file (topic_<slug>.body.md) and referenced from the frontmatter.
 *   - STALE_DAYS: 180. Topics unread for 180+ days become candidates for eviction.
 *   - INDEX_MAX_LINES: 200. Index auto-truncates oldest topics below this threshold.
 *   - SIMILARITY_MERGE: if two topics have >0.7 token overlap, mark for merge review.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  VClock,
  bump as bumpVClock,
  parseVClockString,
  formatVClock,
} from './cluster/crdt';

const MEMORY_DIR = path.join(os.homedir(), '.makestudio', 'memory');
const INDEX_FILE = path.join(MEMORY_DIR, 'MEMORY.md');

const MAX_TOPICS = 500;
const INDEX_MAX_LINES = 200;
const INDEX_MAX_BYTES = 25_000; // dual cap: lines AND bytes (port of Claude Code memdir truncation)
const TOPIC_MAX_CHARS = 4000;
const STALE_DAYS = 180;

export type MemoryTopicType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryTopic {
  name: string;
  tags: string[];
  lastAccessedAt: string;
  accessCount: number;
  body: string;
  path: string;
  type?: MemoryTopicType;
  description?: string;
  bodyRef?: string;           // path to externalized body if too large
  /** CRDT metadata — present on any topic written after Phase 3. Topics
   *  persisted before that show up with empty vclock + origin equal to
   *  the local peerId on first load; the next save will populate. */
  vclock: VClock;
  origin: string;
  updatedAt: number;
  /** Tombstone marker. When set, the topic is considered deleted. We keep
   *  the file (with empty body) so deletes can propagate to peers via the
   *  sync protocol; cf. CRDT set-with-tombstones. `loadAllTopics` skips
   *  tombstones; `loadAllTopicsIncludingTombstones` exposes them for sync. */
  deletedAt?: number;
}

function ensureDir() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function parseFrontmatter(content: string): { meta: any; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: content };
  const meta: any = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.+)$/);
    if (!kv) continue;
    let value: any = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    if (typeof value === 'string' && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    meta[kv[1]] = value;
  }
  return { meta, body: m[2] };
}

function serializeFrontmatter(meta: any): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').substring(0, 80);
}

function selfPeerId(): string {
  try {
    // Lazy require keeps memory.ts loadable before identity is set up
    // (e.g., in tests that don't spin up the cluster).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getIdentity } = require('./cluster/identity');
    return getIdentity().peerId;
  } catch {
    return 'local';
  }
}

function parseTopicFromDisk(file: string, full: string): MemoryTopic | null {
  try {
    const content = fs.readFileSync(full, 'utf8');
    const { meta, body } = parseFrontmatter(content);
    let finalBody = body.trim();
    if (meta.bodyRef) {
      const refPath = path.join(MEMORY_DIR, meta.bodyRef);
      if (fs.existsSync(refPath)) finalBody = fs.readFileSync(refPath, 'utf8');
    }
    const topicType =
      meta.type === 'user' || meta.type === 'feedback' ||
      meta.type === 'project' || meta.type === 'reference'
        ? (meta.type as MemoryTopicType)
        : undefined;
    return {
      name: meta.name || file.replace(/^topic_/, '').replace(/\.md$/, ''),
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      lastAccessedAt: meta.lastAccessedAt || new Date(0).toISOString(),
      accessCount: parseInt(meta.accessCount || '0', 10),
      body: finalBody,
      path: full,
      type: topicType,
      description: typeof meta.description === 'string' ? meta.description : undefined,
      bodyRef: meta.bodyRef,
      vclock: parseVClockString(meta.vclock),
      origin: meta.origin || selfPeerId(),
      updatedAt: parseInt(meta.updatedAt || '0', 10) || Date.parse(meta.lastAccessedAt || '') || 0,
      deletedAt: meta.deletedAt ? parseInt(meta.deletedAt, 10) : undefined,
    };
  } catch {
    return null;
  }
}

/** Public: all live topics (excludes tombstones). */
export function loadAllTopics(): MemoryTopic[] {
  return loadAllTopicsIncludingTombstones().filter((t) => !t.deletedAt);
}

/** Internal (exported for the cluster sync layer): includes tombstones so
 *  deletes can propagate to remote peers. */
export function loadAllTopicsIncludingTombstones(): MemoryTopic[] {
  ensureDir();
  const topics: MemoryTopic[] = [];
  try {
    for (const file of fs.readdirSync(MEMORY_DIR)) {
      if (!file.startsWith('topic_') || !file.endsWith('.md') || file.endsWith('.body.md')) continue;
      const full = path.join(MEMORY_DIR, file);
      const t = parseTopicFromDisk(file, full);
      if (t) topics.push(t);
    }
  } catch (err) { swallow(err); }
  return topics;
}

export function saveTopic(topic: Partial<MemoryTopic> & { name: string; body: string }): void {
  ensureDir();
  const slug = slugify(topic.name);
  const filePath = path.join(MEMORY_DIR, `topic_${slug}.md`);

  // Externalize large bodies
  let bodyRef: string | undefined;
  let bodyInline = topic.body;
  if (topic.body.length > TOPIC_MAX_CHARS) {
    bodyRef = `topic_${slug}.body.md`;
    fs.writeFileSync(path.join(MEMORY_DIR, bodyRef), topic.body, 'utf8');
    bodyInline = topic.body.substring(0, 500) + '\n\n[... truncated — full body in ' + bodyRef + ']';
  } else {
    // If there was an externalized body but new is small, clean up
    const oldRef = path.join(MEMORY_DIR, `topic_${slug}.body.md`);
    if (fs.existsSync(oldRef)) { try { fs.unlinkSync(oldRef); } catch (err) { swallow(err); } }
  }

  // CRDT: bump this peer's slot in the existing vclock (or start fresh).
  // Writing from scratch without a supplied vclock means this is a local
  // mutation — author is us. Passing `topic.vclock` + `topic.origin` is
  // reserved for applyIncomingTopic (sync path), which bypasses this.
  const existing = parseTopicFromDisk(`topic_${slug}.md`, filePath);
  const nextVClock = bumpVClock(existing?.vclock ?? {}, selfPeerId());
  const now = Date.now();

  const content = serializeFrontmatter({
    name: topic.name,
    description: topic.description ?? existing?.description,
    type: topic.type ?? existing?.type,
    tags: topic.tags || [],
    lastAccessedAt: new Date(now).toISOString(),
    accessCount: topic.accessCount || 0,
    bodyRef,
    vclock: formatVClock(nextVClock),
    origin: selfPeerId(),
    updatedAt: now,
  }) + '\n\n' + bodyInline + '\n';
  fs.writeFileSync(filePath, content, 'utf8');

  regenerateIndex();
  applyLRUEviction();
}

export function deleteTopic(name: string): boolean {
  const topics = loadAllTopics();
  const t = topics.find((x) => x.name === name);
  if (!t) return false;
  try {
    // Tombstone pattern: keep the file with deletedAt set + empty body so
    // the deletion can propagate to other peers via sync. Cluster-less
    // users still see the topic as gone (loadAllTopics filters tombstones).
    // Body reference file IS unlinked because tombstones never carry
    // payload.
    if (t.bodyRef) {
      const refPath = path.join(MEMORY_DIR, t.bodyRef);
      if (fs.existsSync(refPath)) fs.unlinkSync(refPath);
    }
    const now = Date.now();
    const nextVClock = bumpVClock(t.vclock, selfPeerId());
    const content = serializeFrontmatter({
      name: t.name,
      tags: [],
      lastAccessedAt: new Date(now).toISOString(),
      accessCount: t.accessCount,
      deletedAt: now,
      vclock: formatVClock(nextVClock),
      origin: selfPeerId(),
      updatedAt: now,
    }) + '\n\n' + '\n';
    fs.writeFileSync(t.path, content, 'utf8');
    regenerateIndex();
    return true;
  } catch { return false; }
}

export function touchTopic(name: string): void {
  const topics = loadAllTopics();
  const t = topics.find((x) => x.name === name);
  if (!t) return;
  t.lastAccessedAt = new Date().toISOString();
  t.accessCount++;
  saveTopic(t);
}

/**
 * CRDT merge entry point for the cluster sync layer. Takes a topic as
 * received from a remote peer (with their vclock/origin/updatedAt intact)
 * and decides what to persist locally.
 *
 * Returns the merge outcome so the sync caller can log it and — in the
 * `conflict` case — store a second "loser" copy under a conflict-tagged
 * slug so the user can see both versions via /memory conflicts.
 */
export interface ApplyResult {
  outcome: 'kept-local' | 'kept-remote' | 'equal' | 'conflict';
  conflictPath?: string;
}

export function applyIncomingTopic(remote: MemoryTopic): ApplyResult {
  ensureDir();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { merge: crdtMerge } = require('./cluster/crdt');

  const slug = slugify(remote.name);
  const filePath = path.join(MEMORY_DIR, `topic_${slug}.md`);
  const existing = parseTopicFromDisk(`topic_${slug}.md`, filePath);

  const toLww = (t: MemoryTopic) => ({
    value: { body: t.body, tags: t.tags, deletedAt: t.deletedAt },
    vclock: t.vclock,
    origin: t.origin,
    updatedAt: t.updatedAt,
  });

  // First sight: accept the remote as-is.
  if (!existing) {
    writeTopicFromRemote(filePath, slug, remote);
    return { outcome: 'kept-remote' };
  }

  const result = crdtMerge(toLww(existing), toLww(remote));
  switch (result.outcome) {
    case 'equal':
    case 'kept-local':
      return { outcome: result.outcome };
    case 'kept-remote':
      writeTopicFromRemote(filePath, slug, remote);
      return { outcome: 'kept-remote' };
    case 'conflict': {
      // Winner replaces the main file; loser is preserved under a
      // conflict-tagged slug so /memory conflicts can surface it.
      // Concurrent writes come from DIFFERENT peers (each peer bumps its
      // own vclock slot), so origin is a safe discriminator between the
      // two inputs.
      const winnerTopic: MemoryTopic = result.winner.origin === existing.origin ? existing : remote;
      const loserTopic: MemoryTopic  = result.loser.origin  === existing.origin ? existing : remote;
      writeTopicFromRemote(filePath, slug, winnerTopic);
      const conflictSlug = `${slug}-conflict-${loserTopic.origin.replace(/^m-/, '')}`;
      const conflictPath = path.join(MEMORY_DIR, `topic_${conflictSlug}.md`);
      writeTopicFromRemote(conflictPath, conflictSlug, {
        ...loserTopic,
        name: `${loserTopic.name} (conflict from ${loserTopic.origin})`,
      });
      return { outcome: 'conflict', conflictPath };
    }
  }
  // Unreachable — the switch covers all outcomes. TS can't prove
  // exhaustiveness because `result` comes through require(); the fallback
  // preserves a correct default so the function signature stays clean.
  return { outcome: 'equal' };
}

/**
 * Write a topic to disk preserving the author's CRDT metadata. Used by
 * the sync path — unlike saveTopic, does NOT bump the vclock (that would
 * rewrite the remote's history into ours).
 */
function writeTopicFromRemote(filePath: string, slug: string, t: MemoryTopic): void {
  let bodyRef: string | undefined;
  let bodyInline = t.body;
  if (!t.deletedAt && t.body.length > TOPIC_MAX_CHARS) {
    bodyRef = path.basename(filePath).replace(/\.md$/, '.body.md');
    fs.writeFileSync(path.join(path.dirname(filePath), bodyRef), t.body, 'utf8');
    bodyInline = t.body.substring(0, 500) + '\n\n[... truncated — full body in ' + bodyRef + ']';
  }
  const content = serializeFrontmatter({
    name: t.name,
    tags: t.tags || [],
    lastAccessedAt: t.lastAccessedAt || new Date().toISOString(),
    accessCount: t.accessCount || 0,
    bodyRef,
    deletedAt: t.deletedAt,
    vclock: formatVClock(t.vclock),
    origin: t.origin,
    updatedAt: t.updatedAt,
  }) + '\n\n' + (t.deletedAt ? '' : bodyInline) + '\n';
  fs.writeFileSync(filePath, content, 'utf8');
  regenerateIndex();
}

/**
 * LRU eviction: keep only the most recently accessed + most frequently used topics.
 * Score = accessCount + recency_boost. Evict below MAX_TOPICS.
 */
function applyLRUEviction(): void {
  const topics = loadAllTopics();
  if (topics.length <= MAX_TOPICS) return;

  const scored = topics.map((t) => {
    const ageDays = (Date.now() - new Date(t.lastAccessedAt).getTime()) / (86_400 * 1000);
    const recency = Math.max(0, 1 - ageDays / STALE_DAYS); // 1 at current, 0 after STALE_DAYS
    const score = t.accessCount + recency * 10;
    return { topic: t, score, ageDays };
  });

  // Sort desc by score, keep top MAX_TOPICS
  scored.sort((a, b) => b.score - a.score);
  const toEvict = scored.slice(MAX_TOPICS);
  for (const e of toEvict) {
    try {
      fs.unlinkSync(e.topic.path);
      if (e.topic.bodyRef) {
        const refPath = path.join(MEMORY_DIR, e.topic.bodyRef);
        if (fs.existsSync(refPath)) fs.unlinkSync(refPath);
      }
    } catch (err) { swallow(err); }
  }
}

export function regenerateIndex(): void {
  ensureDir();
  const topics = loadAllTopics().sort((a, b) => {
    const sa = a.accessCount + (Date.now() - new Date(a.lastAccessedAt).getTime() < 30 * 86_400_000 ? 5 : 0);
    const sb = b.accessCount + (Date.now() - new Date(b.lastAccessedAt).getTime() < 30 * 86_400_000 ? 5 : 0);
    return sb - sa;
  });

  const lines = ['# Memory Index', '', `Last updated: ${new Date().toISOString()}`, `Total topics: ${topics.length}`, ''];
  for (const t of topics) {
    const ageDays = Math.round((Date.now() - new Date(t.lastAccessedAt).getTime()) / 86_400_000);
    const stale = ageDays > STALE_DAYS ? ' _[stale]_' : '';
    const tags = t.tags.length > 0 ? ` _[${t.tags.slice(0, 3).join(', ')}]_` : '';
    const preview = t.body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
    lines.push(`- **${t.name}**${tags}${stale} — ${preview.substring(0, 80)}`);
    if (lines.length >= INDEX_MAX_LINES) {
      lines.push(`- _... ${topics.length - lines.length + 6} more topics (run /memory list to see all)_`);
      break;
    }
  }
  // Byte cap: trim from the end until under 25KB. A single very long line can
  // bypass the line-count gate, so we need both checks (port of Claude Code
  // memdir dual-truncation). The trailing notice replaces the trimmed lines.
  let indexContent = lines.join('\n') + '\n';
  if (indexContent.length > INDEX_MAX_BYTES) {
    while (lines.length > 5 && Buffer.byteLength(lines.join('\n') + '\n', 'utf8') > INDEX_MAX_BYTES) {
      lines.pop();
    }
    lines.push(`- _... truncated (byte limit) — run /memory list to see all topics_`);
    indexContent = lines.join('\n') + '\n';
  }
  fs.writeFileSync(INDEX_FILE, indexContent, 'utf8');
}

/**
 * Pure: tokenize for similarity scoring. Lowercase, alphanumeric with
 * Latin accents, drops tokens of length <= 2. Exported so the similarity
 * helpers can be unit-tested without touching the memory store on disk.
 */
export function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[^a-z0-9áéíóúâêîôûãõç]+/)
      .filter((t) => t.length > 2),
  );
}

/** Pure: Jaccard similarity over two token sets. Returns 0 when either is empty. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return intersection / union;
}

/**
 * Find topics similar to the given content. Returns pairs with similarity > threshold.
 */
export function findSimilarTopics(threshold: number = 0.6): Array<{ a: MemoryTopic; b: MemoryTopic; similarity: number }> {
  const topics = loadAllTopics();
  const pairs: Array<{ a: MemoryTopic; b: MemoryTopic; similarity: number }> = [];
  for (let i = 0; i < topics.length; i++) {
    const tokensA = tokenize(topics[i].name + ' ' + topics[i].tags.join(' ') + ' ' + topics[i].body);
    for (let j = i + 1; j < topics.length; j++) {
      const tokensB = tokenize(topics[j].name + ' ' + topics[j].tags.join(' ') + ' ' + topics[j].body);
      const sim = jaccardSimilarity(tokensA, tokensB);
      if (sim >= threshold) pairs.push({ a: topics[i], b: topics[j], similarity: sim });
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity);
}

/**
 * Relevance scoring: token overlap + recency + frequency bonus.
 * Cached tokenization for efficiency.
 */
export function findRelevant(query: string, limit: number = 3): MemoryTopic[] {
  const topics = loadAllTopics();
  if (topics.length === 0) return [];
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return [];

  const scored = topics.map((t) => {
    const haystackTokens = tokenize(t.name + ' ' + t.tags.join(' ') + ' ' + t.body.substring(0, 600));
    let overlap = 0;
    for (const tok of queryTokens) if (haystackTokens.has(tok)) overlap++;
    const tagBoost = t.tags.some((tag) => queryTokens.has(tag.toLowerCase())) ? 3 : 0;
    const nameBoost = Array.from(queryTokens).some((q) => t.name.toLowerCase().includes(q)) ? 5 : 0;
    const ageDays = (Date.now() - new Date(t.lastAccessedAt).getTime()) / 86_400_000;
    const freshness = Math.max(0, 1 - ageDays / STALE_DAYS);
    const freqBoost = Math.log(1 + t.accessCount) * 0.5;
    const score = overlap + tagBoost + nameBoost + freshness + freqBoost;
    return { topic: t, score };
  });

  return scored
    .filter((s) => s.score >= 1.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.topic);
}

/**
 * LLM-based relevance scoring. Asks the fast provider (role=fast, cheap)
 * to pick which topics are relevant to the query. Falls back to the
 * keyword-based `findRelevant` when the fast provider isn't configured
 * or the LLM call fails.
 *
 * Port of Claude Code's findRelevantMemories (memdir/findRelevantMemories.ts).
 * The goal is to surface topics whose TEXT relates to the query
 * semantically — not just by token overlap. Example: user asks about
 * "authentication flow" and a topic named "OAuth refresh pattern" should
 * match even though zero keywords overlap.
 *
 * We cap the input: the prompt sends ONLY names + descriptions (first
 * 200 chars of body), not full bodies. The model returns a JSON array
 * of topic names it wants surfaced. Cached for 30s so repeated calls in
 * one turn don't spam the fast provider.
 */
const relevanceCache = new Map<string, { at: number; names: string[] }>();
const RELEVANCE_CACHE_TTL_MS = 30_000;

export async function findRelevantLLM(
  query: string,
  limit: number = 3,
  opts: { provider?: any; signal?: AbortSignal } = {},
): Promise<MemoryTopic[]> {
  const topics = loadAllTopics();
  if (topics.length === 0) return [];
  // Small corpus: don't pay the LLM call, keyword match is already good.
  if (topics.length <= limit + 1) return findRelevant(query, limit);

  const cacheKey = `${query.slice(0, 200)}|${limit}|${topics.length}`;
  const hit = relevanceCache.get(cacheKey);
  if (hit && Date.now() - hit.at < RELEVANCE_CACHE_TTL_MS) {
    return topics.filter((t) => hit.names.includes(t.name)).slice(0, limit);
  }

  const provider = opts.provider ?? (() => {
    try { return require('./ai/providers').getProvider(); } catch { return null; }
  })();
  // No provider / no sendSmall → keyword fallback. We do not try the main
  // provider for memory ranking — too expensive per turn.
  if (!provider || !provider.sendSmall) {
    return findRelevant(query, limit);
  }

  // Build the candidate list — keep it terse so the classifier runs fast.
  const candidates = topics.map((t) => ({
    name: t.name,
    desc: (t.body || '').slice(0, 200).replace(/\s+/g, ' '),
  }));

  const system =
    'You are a relevance classifier for a developer memory system. Given a user query and a list ' +
    'of memory topics (name + short description), return a JSON array with the names of the topics ' +
    'most relevant to the query. Return AT MOST the limit. Prefer semantic relevance over literal ' +
    'keyword overlap. When nothing is relevant, return an empty array. Output ONLY the JSON array ' +
    '— no prose, no code fences.';

  const user =
    `Query: ${query.slice(0, 500)}\n\n` +
    `Limit: ${limit}\n\n` +
    `Topics:\n` +
    candidates.map((c, i) => `${i + 1}. ${c.name} — ${c.desc}`).join('\n');

  try {
    const response = await provider.sendSmall({
      system,
      messages: [{ role: 'user', content: user }],
      tools: [],
      effort: 'low',
    });
    const raw: string = ((response?.content || [])
      .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('')).trim();
    // Parse — accept bare JSON array OR fenced block. Tolerant of minor spew.
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return findRelevant(query, limit);
    const names: unknown = JSON.parse(match[0]);
    if (!Array.isArray(names)) return findRelevant(query, limit);
    const cleaned = names.filter((n) => typeof n === 'string').map((n: string) => n.trim()).filter(Boolean);
    relevanceCache.set(cacheKey, { at: Date.now(), names: cleaned });
    // Retain the LLM's ordering; cap at limit.
    const byName = new Map(topics.map((t) => [t.name, t]));
    const out: MemoryTopic[] = [];
    for (const n of cleaned) {
      const t = byName.get(n);
      if (t) out.push(t);
      if (out.length >= limit) break;
    }
    if (out.length === 0) return findRelevant(query, limit);
    return out;
  } catch {
    return findRelevant(query, limit);
  }
}

/** Test-only reset of the LLM relevance cache. */
export function __clearRelevanceCacheForTests(): void {
  relevanceCache.clear();
}

/**
 * Count topics that haven't been accessed in STALE_DAYS.
 */
export function getStaleCount(): number {
  const topics = loadAllTopics();
  const cutoff = Date.now() - STALE_DAYS * 86_400_000;
  return topics.filter((t) => new Date(t.lastAccessedAt).getTime() < cutoff).length;
}

/**
 * Prune stale topics explicitly (usually via /memory prune).
 */
export function pruneStale(): number {
  const topics = loadAllTopics();
  const cutoff = Date.now() - STALE_DAYS * 86_400_000;
  let removed = 0;
  for (const t of topics) {
    if (new Date(t.lastAccessedAt).getTime() < cutoff && t.accessCount < 3) {
      try {
        fs.unlinkSync(t.path);
        if (t.bodyRef) {
          const refPath = path.join(MEMORY_DIR, t.bodyRef);
          if (fs.existsSync(refPath)) fs.unlinkSync(refPath);
        }
        removed++;
      } catch (err) { swallow(err); }
    }
  }
  if (removed > 0) regenerateIndex();
  return removed;
}
