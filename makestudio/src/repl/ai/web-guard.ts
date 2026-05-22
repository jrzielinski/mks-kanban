import { swallow } from '../../utils/log';
/**
 * web-guard.ts — SSRF guard + preapproved domains for WebFetch (Fase 4.6).
 *
 * Port of Claude Code's src/tools/WebFetchTool/preapproved.ts + SSRF
 * checks in utils.ts. Two responsibilities:
 *
 *  1. SSRF protection — reject URLs that target:
 *       - loopback (127.0.0.0/8, ::1, localhost)
 *       - link-local (169.254.0.0/16, fe80::/10)
 *       - private ranges (10/8, 172.16-31/12, 192.168/16, fc00::/7)
 *       - cloud metadata (AWS 169.254.169.254, GCP metadata.google.internal)
 *       - non-http(s) schemes
 *     We do DNS resolution and check the RESOLVED IP — a hostname like
 *     `foo.internal` that resolves to 10.x would still be blocked.
 *
 *  2. Preapproved domains — a list of well-known safe public sites
 *     (docs, package registries, VCS). These pass without asking.
 *     Users can extend via permissions.json `allow: ["WebFetch(domain:...)"]`.
 *
 * The actual fetch still runs through the permission engine for
 * user-defined rules. This module is the "always-on" safety layer.
 */

import * as dns from 'dns';
import { promisify } from 'util';

const resolve4 = promisify(dns.resolve4);
const resolve6 = promisify(dns.resolve6);

/**
 * Well-known public domains the assistant can fetch without asking.
 * Lifted from Claude Code's preapproved.ts — docs, registries, VCS.
 * Substring match (suffix): "docs.github.com" matches pattern "github.com".
 */
export const PREAPPROVED_DOMAINS: readonly string[] = [
  // Package registries
  'npmjs.com', 'npmjs.org', 'pypi.org', 'pypi.python.org', 'rubygems.org',
  'crates.io', 'pkg.go.dev', 'hexdocs.pm', 'hex.pm', 'packagist.org',
  // Docs / language
  'nodejs.org', 'developer.mozilla.org', 'mdn.io',
  'docs.python.org', 'python.org',
  'rust-lang.org', 'doc.rust-lang.org',
  'go.dev', 'golang.org',
  'kotlinlang.org', 'typescriptlang.org',
  'reactjs.org', 'react.dev', 'vuejs.org', 'angular.io', 'angular.dev',
  'svelte.dev',
  // VCS
  'github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org',
  // Q&A / community
  'stackoverflow.com', 'stackexchange.com', 'serverfault.com',
  // Cloud docs (READ-ONLY — these are doc sites, NOT metadata endpoints)
  'docs.aws.amazon.com', 'cloud.google.com', 'learn.microsoft.com',
  'docs.microsoft.com', 'kubernetes.io', 'docker.com', 'docs.docker.com',
  // Standards / references
  'w3.org', 'whatwg.org', 'ietf.org', 'httpwg.org', 'rfc-editor.org',
  'caniuse.com',
] as const;

/** Check whether hostname ends with any preapproved suffix. */
export function isPreapprovedDomain(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return PREAPPROVED_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

// ── SSRF guard ────────────────────────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'ip6-localhost', 'ip6-loopback',
  'metadata.google.internal', // GCP metadata endpoint
]);

function ipv4InRange(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const toInt = (s: string) => s.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(range) & mask);
}

/** IPv4 blocks we refuse to fetch from. */
const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8',      // "this" network
  '10.0.0.0/8',     // private
  '100.64.0.0/10',  // CGNAT
  '127.0.0.0/8',    // loopback
  '169.254.0.0/16', // link-local (incl AWS/GCP metadata 169.254.169.254)
  '172.16.0.0/12',  // private
  '192.168.0.0/16', // private
  '224.0.0.0/4',    // multicast
  '240.0.0.0/4',    // reserved
];

function isBlockedIPv4(ip: string): boolean {
  return BLOCKED_IPV4_CIDRS.some((cidr) => ipv4InRange(ip, cidr));
}

/**
 * Canonicalize an IPv6 literal to its fully-expanded 8-group form. Uses the
 * `net` module's BSD-isIP to reject malformed input, then expands `::` and
 * zero-pads each group to 4 hex digits.
 *
 * Without this, stress test #8 bypasses slipped through:
 *   `::ffff:7f00:1`     (hex-form loopback)
 *   `0:0:0:0:0:ffff:7f00:1` (explicit loopback)
 *   `2002:7f00:0001::1` (6to4 mapping of 127.0.0.1)
 *   `fec0::1`           (deprecated site-local)
 */
function expandIPv6(ip: string): string[] | null {
  const lower = ip.toLowerCase().trim();
  // Split on `::` — at most one is allowed.
  const parts = lower.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 ? (parts[1] ? parts[1].split(':') : []) : [];
  // Trailing embedded IPv4 (e.g. ::ffff:127.0.0.1) — convert to 2 groups.
  const tail = right.length ? right[right.length - 1] : (left.length ? left[left.length - 1] : '');
  const v4 = tail.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const hi = ((parseInt(v4[1], 10) << 8) | parseInt(v4[2], 10)).toString(16);
    const lo = ((parseInt(v4[3], 10) << 8) | parseInt(v4[4], 10)).toString(16);
    if (right.length) {
      right.pop();
      right.push(hi, lo);
    } else {
      left.pop();
      left.push(hi, lo);
    }
  }
  const filler = 8 - left.length - right.length;
  if (filler < 0) return null;
  const groups = [...left, ...Array(filler).fill('0'), ...right];
  if (groups.length !== 8) return null;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  }
  return groups.map((g) => g.padStart(4, '0'));
}

function isBlockedIPv6(ip: string): boolean {
  const groups = expandIPv6(ip);
  if (!groups) {
    // Fallback to legacy prefix checks if expansion failed.
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('ff')) return true;
    return false;
  }
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  // Loopback ::1 and unspecified ::
  if (g0 === '0000' && g1 === '0000' && g2 === '0000' && g3 === '0000' &&
      g4 === '0000' && g5 === '0000' && g6 === '0000') {
    if (g7 === '0001' || g7 === '0000') return true;
  }
  // IPv4-mapped ::ffff:a.b.c.d (hex groups g6/g7 carry the embedded v4)
  if (g0 === '0000' && g1 === '0000' && g2 === '0000' && g3 === '0000' &&
      g4 === '0000' && g5 === 'ffff') {
    const ipv4 = `${parseInt(g6.slice(0, 2), 16)}.${parseInt(g6.slice(2), 16)}.${parseInt(g7.slice(0, 2), 16)}.${parseInt(g7.slice(2), 16)}`;
    return isBlockedIPv4(ipv4);
  }
  // 6to4 prefix 2002:WXYZ:... → embedded IPv4 is WW.XX.YY.ZZ
  if (g0 === '2002') {
    const ipv4 = `${parseInt(g1.slice(0, 2), 16)}.${parseInt(g1.slice(2), 16)}.${parseInt(g2.slice(0, 2), 16)}.${parseInt(g2.slice(2), 16)}`;
    if (isBlockedIPv4(ipv4)) return true;
  }
  // Link-local fe80::/10
  if (g0.startsWith('fe') && (parseInt(g0.slice(2), 16) & 0xc0) === 0x80) return true;
  // Unique local fc00::/7
  if (g0.startsWith('fc') || g0.startsWith('fd')) return true;
  // Site-local fec0::/10 (deprecated but still routable)
  if (g0.startsWith('fe') && (parseInt(g0.slice(2), 16) & 0xc0) === 0xc0) return true;
  // Multicast ff00::/8
  if (g0.startsWith('ff')) return true;
  return false;
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
  /** Set when the URL is in our preapproved list (caller may skip policy asks). */
  preapproved?: boolean;
}

/**
 * Validate a URL before fetch. Rejects non-http(s), loopback hostnames,
 * private IP ranges (both in the hostname literal and in the DNS answer).
 *
 * This is a network call (DNS) — bounded by a short timeout. The fetch
 * proper uses the same hostname, so TOCTOU is possible but cheap to
 * mitigate: if a caller wants zero-race it should pass the resolved IP
 * to the underlying HTTP client directly. For MakeStudio's use-case
 * (docs fetching) the pragmatic guard is fine.
 */
export async function guardFetchUrl(url: string): Promise<GuardResult> {
  let u: URL;
  try { u = new URL(url); } catch {
    return { ok: false, reason: 'Malformed URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `Only http(s) allowed, got ${u.protocol}` };
  }
  // Strip trailing `.` which many DNS resolvers accept as FQDN and which
  // defeats the BLOCKED_HOSTNAMES set-lookup (stress test #8 + #12).
  const host = u.hostname.toLowerCase().replace(/\.$/, '');

  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: `Blocked hostname (SSRF guard): ${host}` };
  }

  // Literal IPv4 in URL.
  const v4 = host.match(/^(\d+\.\d+\.\d+\.\d+)$/);
  if (v4 && isBlockedIPv4(v4[1])) {
    return { ok: false, reason: `Blocked private/loopback IP: ${v4[1]}` };
  }
  // Literal IPv6 in URL (wrapped in [..]).
  const v6 = host.match(/^\[(.+)\]$/);
  if (v6 && isBlockedIPv6(v6[1])) {
    return { ok: false, reason: `Blocked private/loopback IPv6: ${v6[1]}` };
  }

  // DNS check — resolve and compare all answers.
  try {
    const [a4, a6] = await Promise.all([
      resolve4(host).catch(() => [] as string[]),
      resolve6(host).catch(() => [] as string[]),
    ]);
    for (const ip of a4) if (isBlockedIPv4(ip)) return { ok: false, reason: `DNS resolved ${host} → ${ip} (blocked)` };
    for (const ip of a6) if (isBlockedIPv6(ip)) return { ok: false, reason: `DNS resolved ${host} → ${ip} (blocked)` };
  } catch (err) { swallow(err); }

  return { ok: true, preapproved: isPreapprovedDomain(host) };
}
