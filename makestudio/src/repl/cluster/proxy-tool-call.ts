/**
 * cluster/proxy-tool-call.ts — extracted from client.ts to break the
 * client ↔ subagent-dispatch import cycle.
 *
 * `sendToolCallToOrigin` is the worker-side of the tool proxy: when a
 * subagent runs under a coordinator-issued spawn-worker and a tool can't
 * run locally (no access to the coordinator's filesystem), the call is
 * routed back through the same WS socket. The subagent dispatcher used
 * to lazy-require this from client.ts, but client.ts also reaches into
 * subagent-dispatch — rollup flagged the static cycle. Lifting the proxy
 * helper out of client.ts removes the back-edge.
 */

import { randomBytes } from 'crypto';

type WsSocket = any;

function newRequestId(): string {
  return 'req-' + randomBytes(6).toString('hex');
}

export function sendToolCallToOrigin(
  sock: WsSocket,
  toolName: string,
  toolInput: unknown,
  timeoutMs = 5 * 60 * 1000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = newRequestId();
    let settled = false;
    const onMessage = (raw: Buffer) => {
      if (settled) return;
      let msg: any;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (msg?.type !== 'tool-call-result' || msg.requestId !== requestId) return;
      settled = true;
      clearTimeout(timer);
      sock.off('message', onMessage);
      if (msg.ok) resolve(msg.result || '');
      else reject(new Error(msg.error || 'proxy tool-call failed'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.off('message', onMessage);
      reject(new Error(`proxy tool-call "${toolName}" timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    timer.unref?.();
    sock.on('message', onMessage);
    try {
      sock.send(JSON.stringify({ type: 'tool-call', requestId, toolName, toolInput }));
    } catch (err: any) {
      settled = true;
      clearTimeout(timer);
      sock.off('message', onMessage);
      reject(err);
    }
  });
}
