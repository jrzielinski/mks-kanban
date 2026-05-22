/**
 * cluster/server-load.ts — neutral seam between the WS server and the
 * peer-card / discovery modules.
 *
 * Without this, peer-card.ts had to lazy-require './server' to read the
 * current load, which creates a static-import cycle (peer-card ↔ server)
 * that rollup flags. The server registers a provider on startup; consumers
 * read via getServerLoad() — neither side imports the other.
 */

export interface ServerLoad {
  running: number;
  cpuCount: number;
}

type Provider = () => ServerLoad;

let provider: Provider | null = null;

export function setServerLoadProvider(fn: Provider | null): void {
  provider = fn;
}

export function getServerLoad(): ServerLoad | null {
  return provider ? provider() : null;
}
