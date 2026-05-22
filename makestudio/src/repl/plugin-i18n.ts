import { swallow } from '../utils/log';
/**
 * plugin-i18n.ts — auto-translate plugin descriptions via the active LLM,
 * with disk-backed cache so each (description, locale) pair is translated
 * at most once.
 *
 * Cache file: ~/.makestudio/plugin-i18n.json
 * Shape: { [locale]: { [hashOfSource]: translatedText } }
 *
 * The hash key (sha256 of the source description) means that if a plugin
 * upstream changes its description, the cache misses and we re-translate.
 * Two plugins with identical source text share a cache entry.
 *
 * Best-effort: on provider/parse failure, returns the original English
 * description for affected items so the UI never breaks.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { ReplContext } from './context';

const CACHE_FILE = path.join(os.homedir(), '.makestudio', 'plugin-i18n.json');

interface CacheData {
  [locale: string]: { [hash: string]: string };
}

export interface PluginI18nItem {
  name: string;
  description: string;
}

const LOCALE_NAME: Record<string, string> = {
  'pt-BR': 'Brazilian Portuguese',
  'pt': 'Brazilian Portuguese',
  'es': 'Spanish',
  'es-ES': 'Spanish',
  'en': 'English',
  'en-US': 'English',
};

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function readCache(): CacheData {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as CacheData;
  } catch {
    return {};
  }
}

function writeCache(cache: CacheData): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) { swallow(err); }
}

function extractText(response: any): string {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') return b.text;
  }
  return '';
}

function stripCodeFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function isEnglish(locale: string): boolean {
  return !locale || locale === 'en' || locale.startsWith('en-') || locale.startsWith('en_');
}

/**
 * Translate plugin descriptions to a target locale. Caches results so
 * subsequent calls for unchanged descriptions return instantly.
 */
export async function translatePluginDescriptions(
  ctx: ReplContext,
  items: PluginI18nItem[],
  locale: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  // Passthrough for English — no translation needed.
  if (isEnglish(locale)) {
    for (const item of items) result[item.name] = item.description;
    return result;
  }

  const cache = readCache();
  const localeCache = cache[locale] ?? {};
  const toTranslate: PluginI18nItem[] = [];

  for (const item of items) {
    if (!item.description) {
      result[item.name] = '';
      continue;
    }
    const key = hashText(item.description);
    if (localeCache[key]) {
      result[item.name] = localeCache[key];
    } else {
      toTranslate.push(item);
    }
  }

  if (toTranslate.length === 0) return result;

  // Resolve LLM provider via the same path title-gen uses.
  let provider: any;
  try {
    const { getProvider } = require('./ai/providers');
    provider = getProvider(ctx.provider);
  } catch {
    for (const item of toTranslate) result[item.name] = item.description;
    return result;
  }
  if (!provider?.sendMessage) {
    for (const item of toTranslate) result[item.name] = item.description;
    return result;
  }

  const localeName = LOCALE_NAME[locale] ?? locale;
  const sysPrompt =
    `You translate short technical UI strings to ${localeName} for a ` +
    `developer-facing desktop app.\n\n` +
    `Rules:\n` +
    `- Keep proper nouns and well-known technical terms UNtranslated ` +
    `(npm, ESLint, Jest, Prettier, JIRA, OpenAPI, Kubernetes, RAG, OTLP, ` +
    `Conventional Commits, TypeORM, Prisma, Storybook, Sentry, Slack, ` +
    `Discord, Telegram, Webhook, MakeStudio, etc.).\n` +
    `- Match the original tone — concise, imperative when applicable, ` +
    `one short sentence.\n` +
    `- Output STRICT JSON only, no markdown fences, no commentary, no ` +
    `extra fields:\n` +
    `{"translations":[{"name":"<plugin-name>","text":"<translated description>"}]}`;

  const userPrompt = JSON.stringify({
    plugins: toTranslate.map((i) => ({
      name: i.name,
      description: i.description,
    })),
  });

  let raw = '';
  try {
    const response = await provider.sendMessage({
      system: sysPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [],
      effort: 'low',
      maxTokens: 4096,
    });
    raw = extractText(response);
  } catch (err) { swallow(err); }

  if (!raw) {
    for (const item of toTranslate) result[item.name] = item.description;
    return result;
  }

  let parsed: { translations?: Array<{ name?: string; text?: string }> } = {};
  try {
    parsed = JSON.parse(stripCodeFences(raw));
  } catch {
    for (const item of toTranslate) result[item.name] = item.description;
    return result;
  }

  const translations = Array.isArray(parsed.translations) ? parsed.translations : [];
  const byName = new Map<string, string>();
  for (const t of translations) {
    if (
      typeof t?.name === 'string' &&
      typeof t?.text === 'string' &&
      t.text.trim()
    ) {
      byName.set(t.name, t.text.trim());
    }
  }

  for (const item of toTranslate) {
    const translated = byName.get(item.name);
    if (translated) {
      const key = hashText(item.description);
      localeCache[key] = translated;
      result[item.name] = translated;
    } else {
      // LLM skipped this one — fall back to original.
      result[item.name] = item.description;
    }
  }

  cache[locale] = localeCache;
  writeCache(cache);

  return result;
}
