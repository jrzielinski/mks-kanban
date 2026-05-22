import { swallow } from '../../../utils/log';
/**
 * WEB tool handlers — extracted from the giant switch in
 * tools.ts:runUnderlyingTool.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { ReplContext } from '../../context';
import { getApiClient } from '../../../network/api-client';
import { asArray, findProjectMatch, safePath, truncate, fallbackGrepDefinition, fallbackGrepReferences, fallbackGrepSymbols } from '../helpers';



export async function toolWebSearch(input: any, ctx: ReplContext): Promise<string> {
  const headers = { 'x-tenant-id': ctx.user?.tenantId || 'staff' };
  if (!input.query) return JSON.stringify({ error: 'query is required' });
  // Use DuckDuckGo HTML endpoint (no API key needed)
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
  const axios = require('axios');
  try {
    const res = await axios.get(url, {
      timeout: 15_000,
      headers: { 'User-Agent': 'Mozilla/5.0 MakeStudio/1.0' },
    });
    const html = res.data || '';
    // Extract result blocks: title + snippet + url
    let results: any[] = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && results.length < 10) {
      results.push({
        title: m[2].replace(/&amp;/g, '&').replace(/&#x27;/g, "'").trim(),
        url: decodeURIComponent(m[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, '').replace(/&rut=.*$/, '')),
        snippet: m[3].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim().substring(0, 300),
      });
    }
    // Domain filtering — port of Claude Code WebSearchTool allowed/blocked_domains
    const allowedDomains: string[] = Array.isArray(input.allowed_domains) ? input.allowed_domains : [];
    const blockedDomains: string[] = Array.isArray(input.blocked_domains) ? input.blocked_domains : [];
    if (allowedDomains.length > 0 || blockedDomains.length > 0) {
      results = results.filter((r: any) => {
        let host = '';
        try { host = new URL(r.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return false; }
        if (allowedDomains.length > 0 && !allowedDomains.some((d) => host === d || host.endsWith('.' + d))) return false;
        if (blockedDomains.some((d) => host === d || host.endsWith('.' + d))) return false;
        return true;
      });
    }
    return truncate(JSON.stringify({ query: input.query, count: results.length, results }, null, 2));
  } catch (err: any) {
    return JSON.stringify({ error: `Web search failed: ${err.message}` });
  }
}

export async function toolWebFetch(input: any, ctx: ReplContext): Promise<string> {
  const headers = { 'x-tenant-id': ctx.user?.tenantId || 'staff' };
  if (!input.url) return JSON.stringify({ error: 'url is required' });
  if (!/^https?:\/\//.test(input.url)) return JSON.stringify({ error: 'url must start with http:// or https://' });

  // SSRF guard + preapproved-domain check. Blocks loopback, private
  // ranges, link-local (incl. cloud metadata endpoints) before the
  // HTTP client ever dials. If the caller has a user rule
  // `WebFetch(domain:foo.com)` in permissions.json, that path hits
  // the main permission engine upstream — this module is the
  // always-on network safety layer regardless of user policy.
  try {
    const { guardFetchUrl } = require('../web-guard');
    const guard = await guardFetchUrl(input.url);
    if (!guard.ok) {
      try { require('../../utils/events').recordEvent('web_guard_block', { url: input.url, reason: guard.reason }); } catch (err) { swallow(err); }
      return JSON.stringify({ error: `WebFetch blocked by SSRF guard: ${guard.reason}` });
    }
  } catch (err) { swallow(err); }

  const axios = require('axios');
  try {
    const res = await axios.get(input.url, {
      timeout: 20_000,
      headers: { 'User-Agent': 'Mozilla/5.0 MakeStudio/1.0' },
      maxContentLength: 5 * 1024 * 1024,
      maxRedirects: 3,
    });
    let content = res.data || '';
    if (typeof content !== 'string') content = JSON.stringify(content);

    // Strip HTML tags if HTML
    const ct = res.headers?.['content-type'] || '';
    if (ct.includes('html') || content.startsWith('<!DOCTYPE') || content.startsWith('<html')) {
      content = content
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n/g, '\n\n')
        .trim();
    }
    // Prompt-based extraction: when the caller provides a `prompt`, use
    // the fast model to extract only relevant content instead of returning
    // the full stripped page. Saves tokens and improves accuracy.
    if (input.prompt && content.length > 0) {
      try {
        const { getProvider } = require('../providers');
        const provider = getProvider(ctx.provider);
        const extractSystem = 'You are a precise content extractor. Extract ONLY the information relevant to the user\'s question from the provided web page. Be concise and direct. If the information is not present in the page, say so explicitly. Always respond in the language the user is currently using (pt-BR, en, or es).';
        const extractUserMsg = `Web page content (from ${input.url}):\n\n${content.slice(0, 8000)}\n\n---\n\nExtract: ${input.prompt}`;
        const extraction = (provider.sendSmall ? await provider.sendSmall({
          system: extractSystem,
          messages: [{ role: 'user', content: extractUserMsg }],
          tools: [],
        }) : null) ?? await provider.sendMessage({
          system: extractSystem,
          messages: [{ role: 'user', content: extractUserMsg }],
          tools: [],
        });
        const extractedText = (extraction?.content || []).find((b: any) => b.type === 'text')?.text?.trim() || '';
        if (extractedText) return extractedText;
      } catch (err) { swallow(err); }
    }
    return truncate(content, 5000);
  } catch (err: any) {
    return JSON.stringify({ error: `Fetch failed: ${err.message?.substring(0, 200)}` });
  }
}


export const WEB_TOOL_HANDLERS = [
  { name: 'web_search', handler: toolWebSearch },
  { name: 'web_fetch', handler: toolWebFetch },
];
