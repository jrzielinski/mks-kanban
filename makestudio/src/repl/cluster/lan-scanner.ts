import { swallow } from '../../utils/log';
/**
 * cluster/lan-scanner.ts — TCP-based peer discovery.
 *
 * Replaces (and for now runs alongside) the UDP multicast beacon. Multicast
 * is fragile in the real world: AP isolation on most Wi-Fi APs, IGMP-snooping
 * switches, cloud VPCs, Docker/Colima bridges, multiple host NICs — any of
 * these kills a multicast beacon silently. Unicast TCP works wherever the
 * peers can reach each other at all.
 *
 * Strategy, fast-to-slow:
 *   1. Read the host ARP table — OS already knows who it's been talking to.
 *      That's 10-30 IPs on a typical home LAN (vs. 254 for a /24 sweep).
 *   2. TCP-connect each candidate on the cluster port, 20 in parallel,
 *      200ms timeout. Anyone who accepts gets handed to `onCandidate` — the
 *      WS handshake+signature check is the authoritative "is this a peer?"
 *      verdict.
 *   3. If ARP returned nothing useful (fresh boot, cleared cache), fall back
 *      to a full /24 sweep of each local non-loopback interface.
 *
 * The scanner runs periodically (default 30s) so peers that come up after
 * the initial scan still get discovered. The cost is one `arp -a` exec plus
 * N cheap TCP SYN packets per sweep, which is negligible.
 */

import { exec } from 'child_process';
import * as net from 'net';
import * as os from 'os';
import * as fs from 'fs';

/**
 * Parse the output of `arp -a` (macOS/Linux) or read /proc/net/arp (Linux).
 * Returns the unique set of IPv4 addresses the host has seen recently.
 * Never rejects — on any error the return is an empty array and the caller
 * falls through to the /24 sweep.
 */
export async function getArpHosts(): Promise<string[]> {
  // Linux has /proc/net/arp which is fast, stable, and doesn't fork.
  if (process.platform === 'linux') {
    try {
      const raw = fs.readFileSync('/proc/net/arp', 'utf8');
      const ips: string[] = [];
      // Skip the header row; columns: IP address | HW type | Flags | HW address | Mask | Device
      for (const line of raw.split('\n').slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;
        const ip = parts[0];
        // Flags column 2 == "0x0" means incomplete/unreachable; skip those.
        if (parts[2] === '0x0') continue;
        if (isIpv4(ip)) ips.push(ip);
      }
      return dedupe(ips);
    } catch (err) { swallow(err); }
  }
  // macOS and any Linux where /proc wasn't usable.
  return new Promise((resolve) => {
    exec('arp -a -n 2>/dev/null || arp -a 2>/dev/null', { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) { resolve([]); return; }
      const ips = new Set<string>();
      // Typical line (macOS): `host.lan (10.0.0.164) at aa:bb:.. on en0 ifscope [ethernet]`
      // Typical line (Linux): `? (10.0.0.164) at aa:bb:.. [ether] on eth0`
      const rx = /\(([\d.]+)\)/g;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(stdout)) !== null) {
        if (isIpv4(m[1])) ips.add(m[1]);
      }
      resolve(Array.from(ips));
    });
  });
}

/**
 * Return every IPv4 address the /24 containing each local interface covers,
 * excluding the host's own addresses. Used as a fallback when ARP is empty
 * on first boot.
 *
 * We deliberately IGNORE the reported netmask and always sweep as /24
 * centered on the interface's IP. Reason: macOS Wi-Fi interfaces frequently
 * report /23 or /16 (kernel-supplied default for DHCP leases), which would
 * either explode the sweep to 65k probes or make us skip the subnet entirely.
 * 99% of real LANs a MakeStudio user is on are /24 or /23 — a /24 sweep
 * from each interface covers that case reliably without an absurd probe
 * volume.
 */
export function sweepLocalSubnets(): string[] {
  const out = new Set<string>();
  const selfAddrs = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      selfAddrs.add(a.address);
      // APIPA / link-local 169.254.x.x isn't useful — those addresses only
      // appear when DHCP failed. Skip so we don't burn time on 254 hosts
      // that can't talk to anyone.
      if (a.address.startsWith('169.254.')) continue;
      const prefix = a.address.split('.').slice(0, 3).join('.');
      for (let host = 1; host <= 254; host++) {
        out.add(`${prefix}.${host}`);
      }
    }
  }
  // Never probe ourselves.
  for (const self of selfAddrs) out.delete(self);
  return Array.from(out);
}

function isIpv4(s: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(s);
}

function dedupe<T>(xs: T[]): T[] { return Array.from(new Set(xs)); }

/**
 * TCP-connect to `host:port` with a tight timeout. Resolves true if the
 * three-way handshake completed (port open), false on anything else —
 * refused, unreachable, timeout. Never throws.
 */
export function probeTcp(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (err) { swallow(err); }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try {
      sock.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

/**
 * Run probes in parallel with a concurrency cap. Emits `onHit` the moment a
 * host answers, not at the end — so a peer dialog can start right away.
 */
async function parallelProbe(
  hosts: string[],
  port: number,
  onHit: (ip: string) => void,
  timeoutMs: number,
  concurrency: number,
): Promise<string[]> {
  const hits: string[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, hosts.length) }, async () => {
    while (cursor < hosts.length) {
      const i = cursor++;
      const ip = hosts[i];
      if (await probeTcp(ip, port, timeoutMs)) {
        hits.push(ip);
        try { onHit(ip); } catch (err) { swallow(err); }
      }
    }
  });
  await Promise.all(workers);
  return hits;
}

export interface ScanOptions {
  port: number;
  /** Invoked the moment a host accepts a TCP connection. Fires per-hit, not batched. */
  onCandidate?: (ip: string) => void;
  /** Per-probe TCP timeout. 300ms is generous for LAN; raise to 500-700 for Wi-Fi. */
  timeoutMs?: number;
  /** Max concurrent probes. 20 is gentle enough for home routers. */
  concurrency?: number;
  /** Skip ARP, go straight to /24 sweep. Useful for "force full scan". */
  forceFullScan?: boolean;
}

export interface ScanResult {
  source: 'arp' | 'sweep' | 'both';
  probed: number;
  accepted: string[];
  durationMs: number;
}

/**
 * Run one discovery pass: ARP-first, /24-sweep-fallback. Fires `onCandidate`
 * per TCP hit so the caller can kick off the WS handshake without waiting
 * for the whole pass to finish.
 */
export async function scanForPeers(opts: ScanOptions): Promise<ScanResult> {
  const timeoutMs = opts.timeoutMs ?? 300;
  const concurrency = opts.concurrency ?? 20;
  const started = Date.now();

  let hosts: string[] = [];
  let source: ScanResult['source'] = 'arp';
  if (!opts.forceFullScan) {
    hosts = await getArpHosts();
  }

  // ARP empty (fresh boot, docker-only, etc.) or explicit full scan requested.
  if (hosts.length === 0 || opts.forceFullScan) {
    hosts = sweepLocalSubnets();
    source = 'sweep';
  } else {
    // ARP has hits — still merge with /24 sweep hosts we haven't seen, so
    // freshly-booted peers that haven't talked to us yet still get probed.
    const merged = new Set(hosts);
    for (const ip of sweepLocalSubnets()) merged.add(ip);
    hosts = Array.from(merged);
    source = 'both';
  }

  // ARP tables on some OSs list self-addresses (virtual interfaces record
  // their own IP in the ARP cache). Strip them — probing ourselves only
  // wastes time and produces confusing "hits" that never authenticate.
  const selfAddrs = new Set<string>();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) selfAddrs.add(a.address);
    }
  }
  hosts = hosts.filter((ip) => !selfAddrs.has(ip));

  const accepted = await parallelProbe(
    hosts,
    opts.port,
    (ip) => opts.onCandidate?.(ip),
    timeoutMs,
    concurrency,
  );

  return {
    source,
    probed: hosts.length,
    accepted,
    durationMs: Date.now() - started,
  };
}

// ── Periodic scanner driver ──────────────────────────────────────────────
// Wraps scanForPeers with a setInterval + last-scan telemetry so /cluster
// debug can show "last scanned 7s ago — 3 hits / 214 probed".

interface ScannerState {
  timer: NodeJS.Timeout;
  lastScan: ScanResult | null;
  running: boolean;
}

let scannerState: ScannerState | null = null;

export function getScannerStats(): { lastScan: ScanResult | null; running: boolean } {
  return {
    lastScan: scannerState?.lastScan ?? null,
    running: scannerState?.running ?? false,
  };
}

export function startScanner(port: number, onCandidate: (ip: string) => void, intervalMs = 30_000): void {
  if (scannerState) return; // idempotent
  const tick = async () => {
    try {
      const res = await scanForPeers({ port, onCandidate });
      if (scannerState) scannerState.lastScan = res;
    } catch (err) { swallow(err); }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  scannerState = { timer, lastScan: null, running: true };
  // Run one immediately so peers don't wait for the first interval tick.
  void tick();
}

export function stopScanner(): void {
  if (!scannerState) return;
  try { clearInterval(scannerState.timer); } catch (err) { swallow(err); }
  scannerState = null;
}
