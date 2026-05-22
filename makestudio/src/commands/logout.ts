import { clearConfig } from '../config/config';
import { disconnectWebSocket } from '../network/ws-client';
import { logSuccess } from '../ui/terminal';

export function logoutCommand(): void {
  disconnectWebSocket();
  clearConfig();
  logSuccess('Desconectado e credenciais removidas.');
}
