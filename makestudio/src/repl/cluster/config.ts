import { swallow } from '../../utils/log';
/**
 * cluster/config.ts — persistent cluster settings at ~/.makestudio/cluster.json.
 *
 * {
 *   "enabled": false,
 *   "listenPort": 42425,
 *   "multicastGroup": "239.255.42.42",
 *   "multicastPort": 42042
 * }
 *
 * The peerId is no longer stored here — it's derived from the Ed25519
 * public key in ~/.makestudio/cluster-identity.json (see identity.ts). The
 * shared HMAC secret is also gone; each peer authenticates with its own
 * signed payloads, so there is nothing to share between machines anymore.
 *
 * Discovery is OPT-IN (enabled=false by default) — a cluster beacon leaks
 * hostname and capabilities to the local network, which is fine on a home
 * LAN but undesirable on shared coffee-shop Wi-Fi. `/cluster enable` flips
 * the flag and persists it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getIdentity } from './identity';

export interface ClusterConfig {
  enabled: boolean;
  peerId: string;
  listenPort: number;
  multicastGroup: string;
  multicastPort: number;
}

interface StoredClusterConfig {
  enabled: boolean;
  listenPort: number;
  multicastGroup: string;
  multicastPort: number;
}

const CONFIG_FILE = path.join(os.homedir(), '.makestudio', 'cluster.json');
const DEFAULT_GROUP = '239.255.42.42';
const DEFAULT_MULTICAST_PORT = 42042;
// Same port as multicast. UDP and TCP stacks are independent in the OS — a
// UDP:42042 (multicast listener) and TCP:42042 (WS server) coexist on the
// same port without conflict. Using one number for both simplifies user
// mental model: "cluster speaks on 42042". 42425 was the old default and
// collided with OrbStack's mDNS bridge on macOS.
const DEFAULT_LISTEN_PORT = 42042;

export function loadClusterConfig(): ClusterConfig {
  let loaded: Partial<StoredClusterConfig> = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (err) { swallow(err); }

  const stored: StoredClusterConfig = {
    enabled: loaded.enabled ?? false,
    listenPort: loaded.listenPort || DEFAULT_LISTEN_PORT,
    multicastGroup: loaded.multicastGroup || DEFAULT_GROUP,
    multicastPort: loaded.multicastPort || DEFAULT_MULTICAST_PORT,
  };

  try {
    if (JSON.stringify(loaded) !== JSON.stringify(stored)) {
      fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(stored, null, 2));
    }
  } catch (err) { swallow(err); }

  return { ...stored, peerId: getIdentity().peerId };
}

export function saveClusterConfig(cfg: ClusterConfig): void {
  const stored: StoredClusterConfig = {
    enabled: cfg.enabled,
    listenPort: cfg.listenPort,
    multicastGroup: cfg.multicastGroup,
    multicastPort: cfg.multicastPort,
  };
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(stored, null, 2));
  } catch (err) { swallow(err); }
}
