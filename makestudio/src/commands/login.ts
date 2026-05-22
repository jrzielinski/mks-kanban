import * as readline from 'readline';
import { Writable } from 'stream';
import { login } from '../network/api-client';
import { logSuccess, logError, logInfo } from '../ui/terminal';

import { swallow } from '../utils/log';
async function ask(question: string): Promise<string> {
  // Route through TUI bridge when Ink owns stdin — bare readline collides
  // with Ink's raw-mode handler and Enter prints as ^M instead of submitting.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { askTuiOrReadline } = require('../repl/tui/bridge');
    return await askTuiOrReadline(question.replace(/[:\s]+$/, ''));
  } catch {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return await new Promise<string>(resolve => {
      rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
    });
  }
}

async function askPassword(question: string): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { askTuiOrReadline, getTuiBridge } = require('../repl/tui/bridge');
    if (getTuiBridge()) return await askTuiOrReadline(question.replace(/[:\s]+$/, ''));
  } catch (err) { swallow(err); }
  return new Promise(resolve => {
    const mutableStdout = new Writable({
      write(_chunk, _encoding, cb) { cb(); },
    });
    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: true,
    });
    process.stdout.write(question);
    rl.question('', answer => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

export async function loginCommand(options: {
  server?: string;
  email?: string;
}): Promise<void> {
  const serverUrl = options.server || 'https://api.zielinski.dev.br';

  logInfo(`Servidor: ${serverUrl}`);

  const email = options.email || await ask('Email: ');
  const password = await askPassword('Senha: ');

  if (!email || !password) {
    logError('Email e senha são obrigatórios.');
    process.exit(1);
  }

  try {
    const result = await login(email, password, serverUrl);
    logSuccess(`Autenticado como ${result.user.firstName || result.user.email}`);
    logInfo(`Tenant: ${result.user.tenantId}`);
    logInfo('Token salvo em ~/.makestudio/config.json');
  } catch (err: any) {
    const msg = err?.response?.data?.message || err.message || 'Falha na autenticação';
    logError(`Login falhou: ${msg}`);
    process.exit(1);
  }
}
