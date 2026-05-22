import * as readline from 'readline';
import { Writable } from 'stream';
import chalk from 'chalk';
import {
  DirectProviderName,
  getProviderKey,
  hasProviderKey,
  listConfiguredProviders,
  listKnownProviders,
  maskKey,
  removeProviderKey,
  setProviderKey,
} from '../config/credentials';
import { logError, logInfo, logSuccess } from '../ui/terminal';
import { isJsonMode, emitSuccess } from '../utils/output-format';

const cyan = chalk.hex('#22D3EE');
const dim = chalk.hex('#64748B');
const green = chalk.hex('#22C55E');
const yellow = chalk.hex('#FBBF24');

function isSupported(_name: string): _name is DirectProviderName {
  return true; // any provider is valid
}

function askSecret(question: string): Promise<string> {
  return new Promise((resolve) => {
    const mute = new Writable({ write(_c, _e, cb) { cb(); } });
    const rl = readline.createInterface({ input: process.stdin, output: mute, terminal: true });
    process.stdout.write(question);
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function normalizeProvider(raw: string): DirectProviderName | null {
  const lc = raw.trim().toLowerCase();
  return isSupported(lc) ? lc : null;
}

export async function providerListCommand(options: { json?: boolean } = {}): Promise<void> {
  const known = listKnownProviders();  if (isJsonMode(options)) {    emitSuccess(known.map(p => ({      name: p,      configured: !!getProviderKey(p),    })));    return;  }
  console.log();
  console.log(chalk.white.bold('  Providers configurados'));
  console.log();
  if (known.length === 0) {
    console.log(`  ${dim('Nenhum provider configurado.')}`);
  } else {
    for (const p of known) {
      const key = getProviderKey(p);
      const status = key ? `${green('OK')}  ${dim(maskKey(key))}` : yellow('sem chave');
      console.log(`  ${cyan(p.padEnd(12))} ${status}`);
    }
  }
  console.log();
  console.log(`  ${dim('Configure com:')} ${cyan('makestudio provider set <nome> --key <valor>')}`);
  console.log(`  ${dim('Ou configure via api-configs no backend — chaves sao injetadas automaticamente.')}`);
}

export async function providerSetCommand(
  name: string,
  options: { key?: string },
): Promise<void> {
  const provider = normalizeProvider(name);
  if (!provider) {
    logError(`Nome de provider invalido: ${name}`);
    process.exit(1);
  }

  let key = options.key?.trim();
  if (!key) {
    key = (await askSecret(`  Chave API para ${provider}: `)).trim();
  }
  if (!key) {
    logError('Chave vazia — nada foi salvo.');
    process.exit(1);
  }

  setProviderKey(provider, key);
  logSuccess(`Chave ${provider} salva (criptografada em ~/.makestudio/credentials.enc)`);
  logInfo(`Uso: ${maskKey(key)}`);
}

export async function providerRemoveCommand(name: string): Promise<void> {
  const provider = normalizeProvider(name);
  if (!provider) {
    logError(`Nome de provider invalido: ${name}`);
    process.exit(1);
  }
  if (!hasProviderKey(provider)) {
    logInfo(`Nenhuma chave configurada para ${provider}.`);
    return;
  }
  removeProviderKey(provider);
  logSuccess(`Chave ${provider} removida.`);
}
