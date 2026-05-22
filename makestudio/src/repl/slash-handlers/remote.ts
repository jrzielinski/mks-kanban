import { swallow } from '../../utils/log';
/**
 * Slash command handler — /remote
 *
 * Controls the remote-control feature: connects to the backend relay so a
 * browser can interact with this REPL session via api.zielinski.dev.br.
 *
 * Usage:
 *   /remote enable   — connect to relay, print URL + token
 *   /remote disable  — disconnect relay
 *   /remote url      — re-print current URL
 *   /remote status   — show connection state
 *   /remote token    — rotate the auth token
 *   /remote relay    — change relay URL (default: https://api.zielinski.dev.br)
 */

import {
  dim, green, yellow, cyan, red, bold,
} from '../slash-utils';
import type { SlashCommand, SlashContext } from '../slash-registry';

async function handleSlashRemote(sc: SlashContext): Promise<void> {
  const { rest } = sc;
  const sub = (rest[0] || 'status').toLowerCase();

  // Lazy-require so the module doesn't block startup if deps are missing
  const {
    loadRemoteConfig, saveRemoteConfig, rotateToken,
    startRemoteServer, stopRemoteServer, isRemoteRunning, getRemoteUrl,
  } = require('../remote');
  const cfg = loadRemoteConfig();

  if (sub === 'enable' || sub === 'on' || sub === 'start') {
    if (isRemoteRunning()) {
      // Actually check if relay-connected
      try {
        const { isRelayConnected, getRelayUrl } = require('../remote');
        if (isRelayConnected()) {
          console.log(`  ${yellow('!')} Remote control ja esta ativo em ${cyan(getRelayUrl())}`);
          return;
        }
      } catch (err) { swallow(err); }
    }
    cfg.enabled = true;
    saveRemoteConfig(cfg);
    const ok = await startRemoteServer((err: Error) => {
      console.log(`  ${red('!')} Falha ao conectar: ${err.message}`);
    });
    if (ok) {
      const url = getRemoteUrl();
      const lines: string[] = [];
      lines.push(`  ${green('✓')} ${bold('Remote control ativo')}`);
      lines.push(`  ${dim('URL')}:    ${cyan(url)}`);
      lines.push(`  ${dim('Token')}:  ${dim(cfg.token)}`);
      lines.push(`  ${dim('Relay')}:  ${cfg.relayUrl}`);
      lines.push('');
      lines.push(`  ${dim('Abra o navegador e entre na URL acima.')}`);
      lines.push(`  ${dim('O token ja vem embutido na URL — so abrir.')}`);
      lines.push(`  ${dim('Funciona em qualquer lugar (celular, outro PC).')}`);
      console.log(lines.join('\n'));
    } else {
      console.log(`  ${yellow('!')} Nao foi possivel conectar ao relay em ${cfg.relayUrl}.`);
      console.log(`  ${dim('  Verifique se o backend esta no ar:')} ${cyan(cfg.relayUrl + '/api/v1/health')}`);
      console.log(`  ${dim('  Ou configure outro relay:')} ${cyan('/remote relay <url>')}`);
    }
    return;
  }

  if (sub === 'disable' || sub === 'off' || sub === 'stop') {
    if (!isRemoteRunning()) {
      try {
        const { isRelayConnected } = require('../remote');
        if (!isRelayConnected()) {
          console.log(`  ${dim('Remote control ja esta desligado.')}`);
          return;
        }
      } catch {
        console.log(`  ${dim('Remote control ja esta desligado.')}`);
        return;
      }
    }
    stopRemoteServer();
    cfg.enabled = false;
    saveRemoteConfig(cfg);
    console.log(`  ${green('✓')} Remote control desligado.`);
    return;
  }

  if (sub === 'url') {
    if (!isRemoteRunning()) {
      console.log(`  ${yellow('!')} Remote control nao esta ativo. Use ${cyan('/remote enable')} primeiro.`);
      return;
    }
    const url = getRemoteUrl();
    console.log(`  ${bold('Remote control URL')}`);
    console.log(`  ${cyan(url)}`);
    console.log(`  ${dim('Token:')} ${dim(cfg.token)}`);
    console.log(`  ${dim('Abra no celular ou em qualquer navegador.')}`);
    return;
  }

  if (sub === 'status') {
    const running = isRemoteRunning();
    let relayConnected = false;
    let sessionId = '';
    try {
      const { isRelayConnected, getRelaySessionId } = require('../remote');
      relayConnected = isRelayConnected();
      sessionId = getRelaySessionId();
    } catch (err) { swallow(err); }

    const lines: string[] = [];
    lines.push(`  ${bold('Remote control')}`);
    lines.push(`  ${dim('Status')}:    ${running ? green('ativo') : dim('desligado')}`);
    lines.push(`  ${dim('Relay')}:     ${cfg.relayUrl}`);
    lines.push(`  ${dim('Sessao')}:   ${sessionId || dim('—')}`);
    lines.push(`  ${dim('Conectado')}: ${relayConnected ? green('sim') : dim('nao')}`);
    lines.push(`  ${dim('Token')}:    ${cfg.token.slice(0, 16) + '…'}`);
    console.log(lines.join('\n'));
    return;
  }

  if (sub === 'token' || sub === 'rotate') {
    const newToken = rotateToken(cfg);
    if (isRemoteRunning()) {
      stopRemoteServer();
      cfg.enabled = true;
      const ok = await startRemoteServer();
      if (ok) {
        const url = getRemoteUrl();
        console.log(`  ${green('✓')} Token rotacionado. Nova URL:`);
        console.log(`  ${cyan(url)}`);
      } else {
        console.log(`  ${green('✓')} Token rotacionado, mas falha ao reconectar.`);
        console.log(`  ${dim('Use /remote enable para ativar.')}`);
      }
    } else {
      console.log(`  ${green('✓')} Token rotacionado.`);
    }
    console.log(`  ${dim('Novo token:')} ${cyan(newToken)}`);
    return;
  }

  if (sub === 'relay') {
    const newUrl = rest[1];
    if (!newUrl || !newUrl.startsWith('http')) {
      console.log(`  ${yellow('!')} Usage: /remote relay <url>  (ex: ${cyan('/remote relay https://api.zielinski.dev.br')})`);
      console.log(`  ${dim('  Atual:')} ${cfg.relayUrl}`);
      return;
    }
    cfg.relayUrl = newUrl.replace(/\/$/, '');
    saveRemoteConfig(cfg);
    if (isRemoteRunning()) {
      stopRemoteServer();
      cfg.enabled = true;
      const ok = await startRemoteServer();
      if (ok) {
        console.log(`  ${green('✓')} Relay alterado para ${newUrl}. Reconectado.`);
      } else {
        console.log(`  ${yellow('!')} Relay alterado, mas falha ao conectar.`);
      }
    } else {
      console.log(`  ${green('✓')} Relay alterado para ${newUrl}. ${dim('Use /remote enable para ativar.')}`);
    }
    return;
  }

  console.log(`  ${dim('Uso:')}`);
  console.log(`    ${cyan('/remote enable')}   ${dim('conectar ao relay e ativar')}`);
  console.log(`    ${cyan('/remote disable')}  ${dim('desconectar relay')}`);
  console.log(`    ${cyan('/remote url')}      ${dim('mostrar URL atual')}`);
  console.log(`    ${cyan('/remote status')}   ${dim('status da conexao')}`);
  console.log(`    ${cyan('/remote token')}    ${dim('rotacionar token')}`);
  console.log(`    ${cyan('/remote relay <url>')} ${dim('alterar URL do relay')}`);
}

export const REMOTE_SLASH_COMMANDS: SlashCommand[] = [
  { names: ['/remote'], handler: handleSlashRemote },
];
