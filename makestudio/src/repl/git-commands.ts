/**
 * Git slash commands — /diff, /commit, /branch, /commit-push-pr
 */

import { execSync } from 'child_process';
import chalk from 'chalk';
import { ReplContext } from './context';

const cyan = chalk.hex('#22D3EE');
const dim = chalk.hex('#64748B');
const green = chalk.hex('#22C55E');
const yellow = chalk.hex('#FBBF24');
const red = chalk.hex('#EF4444');

function getProjectPath(ctx: ReplContext): string {
  return ctx.activeProject?.localPath || ctx.cwd;
}

function runGit(cwd: string, cmd: string): { ok: boolean; out: string } {
  try {
    const out = execSync(`git ${cmd}`, { cwd, timeout: 30_000 }).toString();
    return { ok: true, out };
  } catch (err: any) {
    return { ok: false, out: err.stderr?.toString() || err.message };
  }
}

export function handleDiff(ctx: ReplContext, _args: string[]): void {
  const cwd = getProjectPath(ctx);
  const r = runGit(cwd, 'diff --stat HEAD');
  console.log();
  console.log(`  ${chalk.white.bold('Git diff (vs HEAD)')}`);
  console.log();
  if (!r.ok) {
    console.log(`  ${red('!')} ${r.out}`);
    return;
  }
  if (!r.out.trim()) {
    console.log(`  ${dim('Sem mudancas.')}`);
  } else {
    console.log(r.out.split('\n').map(l => '  ' + l).join('\n'));
  }
  console.log();
}

export function handleBranch(ctx: ReplContext, _args: string[]): void {
  const cwd = getProjectPath(ctx);
  const current = runGit(cwd, 'branch --show-current');
  const all = runGit(cwd, 'branch -a --sort=-committerdate');
  console.log();
  console.log(`  ${chalk.white.bold('Git branches')}`);
  console.log();
  if (current.ok) console.log(`  ${dim('Current:')} ${cyan(current.out.trim())}`);
  console.log();
  if (all.ok) {
    all.out.split('\n').filter(l => l.trim()).slice(0, 20).forEach(l => {
      const marker = l.startsWith('*') ? green('●') : dim('○');
      const name = l.replace(/^\*?\s*/, '').trim();
      console.log(`  ${marker} ${name}`);
    });
  }
  console.log();
}

export async function handleCommit(ctx: ReplContext, argsStr: string): Promise<void> {
  const cwd = getProjectPath(ctx);
  const status = runGit(cwd, 'status --short');
  if (!status.ok || !status.out.trim()) {
    console.log(`  ${yellow('!')} Nada para commitar.`);
    return;
  }

  console.log();
  console.log(`  ${chalk.white.bold('Arquivos a commitar')}`);
  console.log(status.out.split('\n').map(l => '  ' + l).join('\n'));
  console.log();

  // If user passed a message as argument, use it directly
  let message = argsStr.replace(/^\/commit\s*/, '').trim();

  if (!message) {
    // Ask AI to suggest a commit message from the diff
    const diff = runGit(cwd, 'diff HEAD --stat').out + '\n' + runGit(cwd, 'diff HEAD').out.substring(0, 3000);
    console.log(`  ${dim('Gerando mensagem de commit via IA...')}`);
    try {
      const { getProvider } = require('./ai/providers');
      const provider = getProvider(ctx.provider);
      const response = await provider.sendMessage({
        system: 'You are a git commit message generator. Generate ONE concise commit message (max 80 chars for title, optional body) based on the diff. Format: "type: subject" using types: feat, fix, refactor, test, docs, chore. English only. Respond with ONLY the message, no preamble.',
        messages: [{ role: 'user', content: `Generate a commit message for this diff:\n\n${diff}` }],
        tools: [],
      });
      const text = response.content.filter((b: any) => b.type === 'text' && b.text).map((b: any) => b.text).join('').trim();
      message = text.split('\n')[0].replace(/^["']|["']$/g, '');
    } catch {
      console.log(`  ${yellow('!')} IA falhou. Use: ${cyan('/commit "mensagem manual"')}`);
      return;
    }
  }

  console.log(`  ${dim('Mensagem:')} ${cyan(message)}`);
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise<string>((resolve) =>
    rl.question(`  Commitar? [S/n] `, (a: string) => { rl.close(); resolve(a.trim().toLowerCase()); }),
  );
  if (ans && ans !== 's' && ans !== 'y' && ans !== '') {
    console.log(`  ${dim('Cancelado.')}`);
    return;
  }

  const add = runGit(cwd, 'add -A');
  if (!add.ok) { console.log(`  ${red('!')} git add falhou: ${add.out}`); return; }
  const commit = runGit(cwd, `commit -m "${message.replace(/"/g, '\\"')}"`);
  if (commit.ok) {
    console.log(`  ${green('✓')} Commit criado: ${dim(commit.out.split('\n')[0])}`);
  } else {
    console.log(`  ${red('!')} Commit falhou: ${commit.out}`);
  }
}

export async function handleCommitPushPr(ctx: ReplContext, argsStr: string): Promise<void> {
  const cwd = getProjectPath(ctx);
  await handleCommit(ctx, argsStr);

  // Push
  const branch = runGit(cwd, 'branch --show-current').out.trim();
  if (!branch) { console.log(`  ${yellow('!')} Nao consegui detectar branch atual.`); return; }

  console.log(`  ${dim('Pushing...')}`);
  const push = runGit(cwd, `push -u origin ${branch}`);
  if (!push.ok) { console.log(`  ${red('!')} Push falhou: ${push.out}`); return; }
  console.log(`  ${green('✓')} Push OK para origin/${branch}`);

  // Create PR via gh
  console.log(`  ${dim('Criando PR via gh...')}`);
  try {
    const prBody = argsStr || 'Auto-generated PR';
    const out = execSync(
      `gh pr create --title "${branch}" --body "${prBody.replace(/"/g, '\\"')}" --base develop 2>&1`,
      { cwd, timeout: 30_000, shell: '/bin/sh' },
    ).toString();
    console.log(`  ${green('✓')} PR criado: ${cyan(out.trim().split('\n').pop() || '')}`);
  } catch (err: any) {
    console.log(`  ${yellow('!')} gh pr create falhou: ${err.message?.substring(0, 200)}`);
  }
}
