import { SlashCommand, SlashContext } from '../slash-registry';
import { join } from 'path';
import { homedir } from 'os';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { swallow } from '../../utils/log';
const chalk = require('chalk');
const { green, cyan, dim, yellow } = { green: chalk.green, cyan: chalk.cyan, dim: chalk.dim, yellow: chalk.yellow };

function getTeleportDir(): string {
  const dir = join(homedir(), '.makestudio', 'teleport');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getTeleportPath(code: string): string {
  return join(getTeleportDir(), `${code}.json`);
}

function generateCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

async function handleSlashTeleport(sc: SlashContext): Promise<void> {
  const { ctx } = sc;
  const os = await import('os');

  if (!ctx.messages || ctx.messages.length === 0) {
    console.log(`  ${dim('Nenhuma mensagem para teleportar. Inicie uma conversa primeiro.')}`);
    return;
  }

  const code = generateCode();
  const snapshot: any = {
    version: 2,
    createdAt: new Date().toISOString(),
    machine: { hostname: os.hostname(), platform: process.platform, arch: process.arch },
    activeProject: ctx.activeProject,
    provider: ctx.provider,
    effort: ctx.effort,
    messages: ctx.messages,
    usage: ctx.usage,
    approvedTools: ctx.approvedTools ? [...ctx.approvedTools] : [],
    autoApprove: ctx.autoApprove,
    lastUserMessage: ctx.lastUserMessage,
    lastToolCall: ctx.lastToolCall,
  };

  // Capture git state
  if (ctx.activeProject?.localPath) {
    try {
      const { execSync } = await import('child_process');
      const cwd = ctx.activeProject.localPath;
      snapshot.gitState = {
        sha: execSync('git rev-parse HEAD', { cwd, timeout: 5_000 }).toString().trim(),
        branch: execSync('git rev-parse --abbrev-ref HEAD', { cwd, timeout: 5_000 }).toString().trim(),
        status: execSync('git status --short', { cwd, timeout: 5_000 }).toString(),
        remote: execSync('git config --get remote.origin.url', { cwd, timeout: 5_000 }).toString().trim(),
      };
    } catch (err) { swallow(err); }
  }

  writeFileSync(getTeleportPath(code), JSON.stringify(snapshot, null, 2));

  console.log(`  ${green('✓')} Teleport code: ${cyan(code)}`);
  console.log(`  ${dim('Arquivo:')} ~/.makestudio/teleport/${code}.json`);
  console.log(`  ${dim('Inclui:')} ${snapshot.messages.length} msgs, git ${snapshot.gitState?.sha?.slice(0, 8) || 'none'}`);
  console.log();
  console.log(`  ${dim('Na outra maquina, execute:')}`);
  console.log(`    ${cyan('makestudio --teleport ' + code)}`);
  console.log();
  console.log(`  ${dim('Ou copie manualmente o arquivo para ~/.makestudio/teleport/ e use o comando acima.')}`);
}

export function loadTeleportSnapshot(code: string): any | null {
  const file = getTeleportPath(code);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}


export const TELEPORT_SLASH_COMMANDS: SlashCommand[] = [
  {
    names: ['/teleport'],
    handler: handleSlashTeleport,
  },
];
