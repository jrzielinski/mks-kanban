/**
 * remote/index.ts — barrel exports for remote-control module.
 */

export { loadRemoteConfig, saveRemoteConfig, rotateToken } from './config';
export type { RemoteConfig } from './config';
export {
  startRemoteServer,
  stopRemoteServer,
  isRemoteRunning,
  getRemoteUrl,
  onTuiMessage,
  onStdoutData,
} from './server';
export {
  connectRelay,
  disconnectRelay,
  isRelayConnected,
  getRelaySessionId,
  getRelayUrl as getRelayClientUrl,
} from './relay-client';
