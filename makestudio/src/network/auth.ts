import { loadConfig } from '../config/config';
import { refreshAuthToken, login } from './api-client';
import * as readline from 'readline';
import { Writable } from 'stream';

import { swallow } from '../utils/log';
export function getToken(): string | null {
  const config = loadConfig();
  return config?.token || null;
}

export function isAuthenticated(): boolean {
  return !!getToken();
}

/**
 * Pure: extract the `exp` claim from a JWT's payload (seconds since the
 * epoch) and return it in milliseconds. Returns null when the token is
 * malformed, the payload does not decode as JSON, or `exp` is missing.
 */
export function parseJwtExpiryMs(token: string | null | undefined): number | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    const exp = payload?.exp;
    if (typeof exp !== 'number') return null;
    return exp * 1000;
  } catch {
    return null;
  }
}

/**
 * Pure: decide if a token should be refreshed before use. A token is
 * considered near expiration when it expires within `thresholdMs` of now
 * (defaults to 5 minutes). Unparseable or missing tokens fall back to
 * `true` so callers refresh/re-login defensively.
 */
export function isJwtNearExpiration(
  token: string | null | undefined,
  thresholdMs: number = 5 * 60 * 1000,
  now: number = Date.now(),
): boolean {
  const expMs = parseJwtExpiryMs(token);
  if (expMs === null) return true;
  return expMs - now < thresholdMs;
}

async function ask(question: string): Promise<string> {
  // Route through the TUI bridge when running inside the Ink REPL — readline
  // can't share stdin with Ink's raw-mode handler, so naked rl.question()
  // makes Enter print as ^M instead of submitting. askTuiOrReadline picks
  // the right path automatically (TUI prompt vs. plain readline outside TUI).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { askTuiOrReadline } = require('../repl/tui/bridge');
    return await askTuiOrReadline(question.replace(/[:\s]+$/, ''));
  } catch {
    // Bridge unavailable (non-TUI binary path, tests) — fall back to readline.
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return await new Promise<string>(resolve => {
      rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
    });
  }
}

async function askPassword(question: string): Promise<string> {
  // TUI mode: route through the same bridge as `ask`. The TUI input box
  // already supports a password mode for sensitive prompts (when /login is
  // active the placeholder hint reads "Senha"). Until that's wired into the
  // bridge contract, accept the trade-off: prompt visible in the TUI.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { askTuiOrReadline, getTuiBridge } = require('../repl/tui/bridge');
    if (getTuiBridge()) return await askTuiOrReadline(question.replace(/[:\s]+$/, ''));
  } catch (err) { swallow(err); }
  return new Promise(resolve => {
    const muted = new Writable({
      write(_chunk, _encoding, callback) { callback(); },
    });
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    process.stdout.write(question);
    rl.question('', answer => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function interactiveLogin(): Promise<string> {
  console.log('\n⚠️  Você não está autenticado. Faça login para continuar.\n');

  const config = loadConfig();
  const defaultServer = config?.serverUrl || 'https://api.zielinski.dev.br';
  const serverInput = await ask(`  Server [${defaultServer}]: `);
  const serverUrl = serverInput || defaultServer;
  const email = await ask('  Email: ');
  const password = await askPassword('  Senha: ');
  console.log('');

  const result = await login(email, password, serverUrl);
  if (!result) {
    throw new Error('Login falhou. Verifique suas credenciais.');
  }

  const newToken = getToken();
  if (!newToken) {
    throw new Error('Login falhou. Token não gerado.');
  }

  console.log('  ✅ Login realizado com sucesso!\n');
  return newToken;
}

export async function ensureAuthenticated(): Promise<string> {
  const token = getToken();
  if (!token) {
    return interactiveLogin();
  }

  // Try to parse JWT expiration
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString(),
    );
    const expiresAt = payload.exp * 1000;
    const now = Date.now();

    // If token expires in less than 5 minutes, refresh
    if (expiresAt - now < 5 * 60 * 1000) {
      const refreshed = await refreshAuthToken();
      if (!refreshed) {
        // Token expired and refresh failed — interactive login
        return interactiveLogin();
      }
      const newToken = getToken();
      if (!newToken) {
        return interactiveLogin();
      }
      return newToken;
    }
  } catch (err: any) {
    if (err.message.includes('Login falhou')) throw err;
    // If we can't parse, just use the token as-is
  }

  return token;
}
