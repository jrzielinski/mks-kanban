import * as crypto from 'crypto';
import { ReplContext } from '../context';

import { swallow } from '../../utils/log';
// ── Vision auxiliary helpers ────────────────────────────────────────
//
// The primary model (e.g. deepseek-v4-flash) has no vision; we route
// images to a smaller auxiliary model (Groq/OpenAI/Gemini Vision). Two
// optimisations adapted from claude-code's FileReadTool:
//
//   1. Resize before sending — a 4K screenshot at 3MB consumes ~12K
//      tokens of input on the auxiliary call. After downscaling to
//      1280px-longest-edge JPEG q=85 it's ~1.5K. The description is
//      identical for the same target use cases (UI, code, error
//      messages, diagrams). Cuts auxiliary tokens 80–90%.
//
//   2. Content-hash cache — the same screenshot pasted in turn 1 and
//      referenced again in turn 5 is described from scratch every time
//      (vision provider doesn't have prompt cache). Hashing the raw
//      bytes (sha256) and caching the description means repeats pay
//      zero. Bounded LRU + TTL so memory doesn't grow unboundedly.
const VISION_RESIZE_MAX_DIM = 1280;
const VISION_RESIZE_JPEG_Q = 85;
const VISION_RESIZE_MIN_BYTES = 100_000; // skip resize for already-small images

const VISION_CACHE_MAX = 50;
const VISION_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const visionCache = new Map<string, { desc: string; at: number }>();

function evictExpiredVision(now: number): void {
  for (const [k, v] of visionCache) {
    if (now - v.at > VISION_CACHE_TTL_MS) visionCache.delete(k);
  }
  // Hard size cap — drop oldest insertion-order entries when over.
  while (visionCache.size > VISION_CACHE_MAX) {
    const first = visionCache.keys().next().value;
    if (first === undefined) break;
    visionCache.delete(first);
  }
}

function hashBytes(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

interface ResizedImage { data: string; mediaType: string }

async function resizeForVision(base64Data: string, mediaType: string): Promise<ResizedImage> {
  try {
    const buf = Buffer.from(base64Data, 'base64');
    if (buf.length < VISION_RESIZE_MIN_BYTES) {
      return { data: base64Data, mediaType };
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sharp = eval('require')('sharp');
    const out: Buffer = await sharp(buf)
      .rotate() // honour EXIF orientation (so resize doesn't lose it)
      .resize({
        width: VISION_RESIZE_MAX_DIM,
        height: VISION_RESIZE_MAX_DIM,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: VISION_RESIZE_JPEG_Q })
      .toBuffer();
    return { data: out.toString('base64'), mediaType: 'image/jpeg' };
  } catch {
    // sharp failure (missing native binary, bad image, etc.) — fall back
    // to the original buffer. The vision model will see the full-size
    // image; we just lose the token-saving optimisation for this call.
    return { data: base64Data, mediaType };
  }
}

/**
 * Call the vision model on a single image block, returning a short
 * objective description. Used when the primary model lacks vision and
 * the operator configured a separate vision provider/model.
 */
export async function describeImageWithVisionModel(
  imgBlock: any,
  apiKey: string,
  baseUrl: string | null,
  model: string,
  provider: string,
): Promise<string> {
  if (!baseUrl) throw new Error('visionBaseUrl not configured');
  // Strip trailing /v1 before appending — Groq baseUrl already ends with /v1
  // so naively concatenating would produce /v1/v1/chat/completions → 404.
  const base = baseUrl.replace(/\/$/, '').replace(/\/v1$/, '');
  const url = `${base}/v1/chat/completions`;

  // Build the imageContent + (when applicable) check the cache.
  // Cache is keyed by sha256 of the ORIGINAL bytes — we want the same
  // image to hit even if a future resize tweak changes the resized
  // bytes. Only base64-source images are cacheable; URL-sourced images
  // could change behind the same URL, so we always re-fetch them.
  let imageContent: string;
  let cacheKey: string | null = null;

  if (imgBlock.source?.type === 'base64') {
    const origData: string = imgBlock.source.data;
    const origMedia: string = imgBlock.source.media_type ?? 'image/png';
    try {
      cacheKey = hashBytes(Buffer.from(origData, 'base64'));
      const now = Date.now();
      evictExpiredVision(now);
      const hit = visionCache.get(cacheKey);
      if (hit && now - hit.at <= VISION_CACHE_TTL_MS) {
        return hit.desc;
      }
    } catch (err) { swallow(err); }

    // Downscale before shipping. resizeForVision falls back to the
    // original on any sharp failure, so this never blocks.
    const resized = await resizeForVision(origData, origMedia);
    imageContent = `data:${resized.mediaType};base64,${resized.data}`;
  } else if (imgBlock.source?.url) {
    imageContent = imgBlock.source.url;
  } else if (imgBlock.image_url?.url) {
    imageContent = imgBlock.image_url.url;
  } else {
    throw new Error('Unsupported image block format');
  }

  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image concisely and objectively. Focus on technical content relevant to software development: UI elements, code, error messages, diagrams, data. Be specific. 2-4 sentences max.' },
        { type: 'image_url', image_url: { url: imageContent } },
      ],
    }],
    max_tokens: 600,
    temperature: 0.2,
  };

  const controller = new AbortController();
  const rawTimeout = process.env.MAKESTUDIO_VISION_TIMEOUT_MS;
  const timeoutMs = (rawTimeout && /^\d+$/.test(rawTimeout) && parseInt(rawTimeout, 10) > 0)
    ? parseInt(rawTimeout, 10)
    : 30_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Vision API ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = await resp.json() as any;
    // Track vision API usage so /cost and /usage account for it.
    // recordUsage requires `provider` — without it, samples land with
    // provider:undefined and pollute the per-provider rollup.
    try {
      const u = data.usage;
      if (u && u.prompt_tokens != null) {
        require('./usage-tracker').recordUsage({
          provider,
          model,
          tier: 'image',
          usage: {
            promptTokens: u.prompt_tokens ?? 0,
            completionTokens: u.completion_tokens ?? 0,
          },
        });
      }
    } catch (err) { swallow(err); }
    const desc = (data.choices?.[0]?.message?.content as string) || '(empty description)';
    // Cache by content hash so repeats in later turns skip the call.
    if (cacheKey && desc && !desc.startsWith('(empty')) {
      visionCache.set(cacheKey, { desc, at: Date.now() });
    }
    return desc;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`Vision API timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
}

/**
 * Route pending image blocks through vision model or strip them.
 * Shared between streaming and non-streaming paths.
 *
 * @param pendingImageBlocks - blocks captured earlier
 * @param input - original user input (needed for [Image #N] stripping fallback)
 * @param effectiveInput - current text input (may have been modified by audit classifier etc.)
 * @param ctx - repl context (reads providerInfo for vision config)
 */
export async function routeImageBlocks(
  pendingImageBlocks: any[],
  input: string,
  effectiveInput: string,
  ctx: ReplContext,
): Promise<{ effectiveInput: string; effectiveImageBlocks: any[]; visionStripped: boolean }> {
  let effectiveImageBlocks = pendingImageBlocks;
  let outInput = effectiveInput;

  if (pendingImageBlocks.length > 0 && ctx.providerInfo && !ctx.providerInfo.supportsVision) {
    const { visionProvider, visionModel, visionApiKey, visionBaseUrl } = ctx.providerInfo;

    if (visionModel && visionApiKey) {
      const logMsg = `(routing ${pendingImageBlocks.length} image(s) through vision model: ${visionModel})`;
      try {
        const { tuiLog } = require('../tui/bridge');
        tuiLog(logMsg, 'info');
      } catch { console.log(`  ${logMsg}`); }

      const descriptions = await Promise.all(
        pendingImageBlocks.map(async (imgBlock) => {
          try {
            return await describeImageWithVisionModel(
              imgBlock,
              visionApiKey,
              visionBaseUrl ?? null,
              visionModel,
              visionProvider || 'vision',
            );
          } catch (err: any) {
            return `(vision model error: ${err?.message ?? 'unknown'})`;
          }
        }),
      );
      const descText = descriptions
        .map((d, i) => `[Image ${i + 1} — described by vision model (${visionModel})]:\n${d}`)
        .join('\n\n');
      outInput = descText + (outInput ? `\n\n${outInput}` : '');
      effectiveImageBlocks = [];
    } else {
      const warnMsg = '(primary model does not support vision and no vision config found — images stripped)';
      try {
        const { tuiLog } = require('../tui/bridge');
        tuiLog(warnMsg, 'warn');
      } catch { console.log(`  ${warnMsg}`); }

      effectiveImageBlocks = [];
      outInput = input.replace(/\s*\[Image #\d+\]/g, '').trim();
      const strippedNote = '[System note: the user attached image(s) to this message but this model does not support vision — the images were stripped and you cannot see them. Do not attempt to describe or reference any image content. Tell the user you cannot process images with the current model configuration.]';
      outInput = outInput ? `${outInput}\n\n${strippedNote}` : strippedNote;
    }
  }

  return {
    effectiveInput: outInput,
    effectiveImageBlocks,
    visionStripped: pendingImageBlocks.length > 0 && effectiveImageBlocks.length === 0,
  };
}

/**
 * Shared helper: capture attached/queued images and route them.
 * Calls routeImageBlocks internally. Used by handleAIChat (non-streaming).
 * handleAIChatStream calls capture inline + routeImageBlocks separately.
 */
export async function prepareImagesForTurn(
  input: string,
  ctx: ReplContext,
): Promise<{ effectiveInput: string; effectiveImageBlocks: any[]; visionStripped: boolean }> {
  let pendingImageBlocks: any[] = [];
  try {
    const { detectImagePathsInText, listAttachedImages, imagesToContentBlocks, clearAttachedImages } = require('../image-paste');
    const detected = detectImagePathsInText(input);
    const queued = listAttachedImages();
    const all = [...queued, ...detected.attached];
    if (all.length > 0) {
      pendingImageBlocks = imagesToContentBlocks(all);
      const infoMsg = `(${all.length} image(s) attached)`;
      try {
        const bridge = require('../tui/bridge');
        if (bridge.addMessage) bridge.addMessage({ role: 'info', text: infoMsg });
      } catch { console.log(`  ${infoMsg}`); }
      clearAttachedImages();
      input = detected.text;
    }
  } catch (err) { swallow(err); }

  return routeImageBlocks(pendingImageBlocks, input, input, ctx);
}
