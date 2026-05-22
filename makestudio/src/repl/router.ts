import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { ReplContext } from './context';
import { printHelp, parseSlashArgs, handleProjectSelect, handleProjectsList, handleProviderSwitch, handleCostCommand, handleCtxCommand, handleModelCommand } from './commands';
import { handleAIChat } from './ai/chat';
import { loadAllSkills, findSkill, applySkillArgs } from './skills';
import { loadSchedules, addSchedule, removeSchedule, toggleSchedule, computeNextRun } from './schedule';
import { handleDiff, handleBranch, handleCommit, handleCommitPushPr } from './git-commands';
import { executeCoordinatorTool } from './ai/coordinator-tools';
import { isHelpRequested, renderSlashHelp } from './slash-help';
import {
  dim, yellow, green, cyan, red, bold,
  ghPreflight, ghErrorHint,
  withDetachedRepl, withExitGuard,
  invalidateGhPreflight,
  registerPluginSlashCommand as _registerPluginSlashCommand,
  lookupPluginSlashCommand,
  listPluginSlashCommands as _listPluginSlashCommands,
  __clearPluginSlashCommandsForTests as _clearPluginSlashCommandsForTests,
} from './slash-utils';
import { findSlashCommand, registerSlashCommands } from './slash-registry';
import { BUILTIN_SLASH_COMMANDS } from './slash-handlers';

import { swallow } from '../utils/log';
// Register all built-in handlers exactly once at module load.
registerSlashCommands(BUILTIN_SLASH_COMMANDS);

// Re-exports — preserve the public API older callers expect.
export const __invalidateGhPreflight = invalidateGhPreflight;
export const registerPluginSlashCommand = _registerPluginSlashCommand;
export const listPluginSlashCommands = _listPluginSlashCommands;
export const __clearPluginSlashCommandsForTests = _clearPluginSlashCommandsForTests;

export async function routeInput(input: string, ctx: ReplContext, rl: readline.Interface): Promise<void> {
  const trimmed = input.trim();
  if (!trimmed) return;

  // `!command` — direct shell execution bypassing the LLM. stdio inherited
  // so interactive commands (gh auth login, ssh, vim) work normally.
  if (trimmed.startsWith('!')) {
    const cmd = trimmed.slice(1).trim();
    if (!cmd) return;
    console.log(dim(`$ ${cmd}`));
    await withDetachedRepl(async () => {
      const { spawn } = require('child_process');
      const proc = spawn('bash', ['-c', cmd], {
        cwd: ctx.cwd,
        stdio: 'inherit',
        env: { ...process.env },
      });
      const exitCode: number = await new Promise((resolve) => {
        proc.on('exit', (c: number | null, sig: NodeJS.Signals | null) => resolve(c ?? (sig ? -1 : 0)));
        proc.on('error', () => resolve(-1));
      });
      if (exitCode !== 0) console.log(dim(`(exit ${exitCode})`));
    });
    // Invalidate gh preflight cache — user may have just logged in / out
    invalidateGhPreflight();
    return;
  }

  if (!trimmed.startsWith('/')) {
    await handleAIChat(trimmed, ctx);
    return;
  }

  const [cmd, ...rest] = trimmed.split(/\s+/);
  const argsStr = rest.join(' ');
  const command = cmd.toLowerCase();

  // ── Universal --help / -h interceptor ─────────────────────────────────
  // Runs *before* skill/plugin/built-in dispatch so `/<anything> --help`
  // always produces help output instead of executing the command. Help
  // metadata lives in ./slash-help.ts; plugins and skills fall through to
  // auto-generated help based on their registered description.
  if (isHelpRequested(rest)) {
    renderSlashHelp(command.slice(1), ctx.cwd);
    return;
  }

  // ── Dynamic skill resolution — /<skill-name> → Skill tool expansion ────
  // Before the hard-coded switch: if the token matches a registered user-
  // invocable skill, expand its body and feed it to the model as a fresh
  // user prompt. Port of Claude Code's slash-command-to-skill dispatch.
  // The switch still wins when a built-in command has the same name.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadAllSkills, findSkill, expandSkill } = require('./skills');
    const skills = loadAllSkills(ctx.cwd);
    const bareName = command.slice(1); // strip leading /
    const sk = findSkill(skills, bareName);
    // Only dispatch as skill if:
    //   1. Skill exists AND
    //   2. Skill is userInvocable (default true) AND
    //   3. The switch below does NOT have this name (check by looking for a
    //      case label — we don't have a structured registry, so we rely on
    //      built-ins being lowercase distinct names; collisions resolve to
    //      built-in priority via the break that doesn't fire here).
    if (sk && sk.userInvocable !== false) {
      // A very short safelist of command names that are hard-coded and must
      // NOT be shadowed by a same-named skill. Kept explicit so a malicious
      // project skill can't override /quit or /permissions.
      const RESERVED = new Set([
        'help','h','quit','exit','q','clear','ctx','ctx_viz','ctx-viz','context-viz','model','stats','sessions',
        'continue','resume','plan','compact','undo','undo-file','history-file','rewind','tag',
        'login','logout','whoami','theme','vim','fast','output-style','keybindings','statusline',
        'add-dir','info','keys','memory','tips','agents','agent','permission-mode','permissions',
        'hooks','suggestions','away','refine','verify','doctor','debug','verbose','trust','effort',
        'coordinator', 'cluster', 'usage',
      ]);
      if (!RESERVED.has(bareName)) {
        const expanded = await expandSkill(sk, argsStr, ctx.cwd);
        try {
          const { recordCtxEvent } = require('./trajectory');
          recordCtxEvent(ctx, 'user', 'skill_invoke', {
            skill: bareName,
            args: argsStr,
          });
        } catch (err) { swallow(err); }
        // Mark the context so chat.ts skips extractAttachments for this
        // turn — skill bodies are instructions, not pasted user content,
        // and externalising them turns the skill into [Pasted #N] which
        // the model has to fetch via read_attachment. Worse, it sometimes
        // copies that placeholder verbatim into Write/Edit calls.
        (ctx as any).__skipAttachmentExtractionOnce = true;
        // Preserve the literal slash command the user typed so the TUI
        // can re-render this turn without dumping the entire expanded
        // skill body on session resume. chat.ts attaches this as
        // `displayText` on the persisted user message; the TUI hydration
        // path (App.tsx) prefers it over the full content.
        (ctx as any).__skillDisplayText = `/${bareName}${argsStr ? ' ' + argsStr : ''}`;
        try {
          const bridge = require('./tui/bridge').getTuiBridge?.();
          if (bridge) {
            const { handleAIChatStream } = require('./ai/chat');
            await handleAIChatStream(expanded, ctx);
            return;
          }
        } catch (err) { swallow(err); }
        await handleAIChat(expanded, ctx);
        return;
      }
    }
  } catch (err) { swallow(err); }

  // ── Plugin-registered slash commands ──────────────────────────────────
  // Same precedence rule: don't shadow RESERVED built-ins.
  {
    const bareName = command.slice(1);
    const plugin = lookupPluginSlashCommand(bareName);
    if (plugin) {
      try {
        await plugin.handler(argsStr, ctx);
      } catch (err: any) {
        console.log(`  ${yellow('!')} /${bareName} failed: ${err.message || err}`);
      }
      return;
    }
  }

  // ── Built-in commands — registry lookup ──────────────────────────────
  // Each handler lives in slash-handlers.ts (split by topic in follow-up
  // commits). Behaviour is identical to the previous 3K-line switch.
  const builtin = findSlashCommand(command);
  if (builtin) {
    await builtin.handler({ ctx, rl, argsStr, rest, command, cmd, trimmed, input });
    return;
  }

  // ── Fallbacks for unknown /commands ──────────────────────────────────
  await routeUnknownSlashCommand(command, argsStr, rest, ctx);
}

async function routeUnknownSlashCommand(
  command: string,
  argsStr: string,
  rest: string[],
  ctx: ReplContext,
): Promise<void> {
  const cmdName = command.replace(/^\//, '');

  // 1. Plugin-contributed commands
  const { pluginRegistry } = require('../core/plugin-registry');
  const pluginCmds = pluginRegistry.getCommands();
  const pluginCmd = pluginCmds.find((c: any) => c.name === cmdName);
  if (pluginCmd) {
    await withDetachedRepl(async () => {
      await pluginCmd.handler(parseSlashArgs(argsStr));
    });
    return;
  }

  // 2. Skills — markdown prompts in ~/.makestudio/skills/
  const skills = loadAllSkills(ctx.cwd);
  const skill = findSkill(skills, cmdName);
  if (skill) {
    const prompt = applySkillArgs(skill, rest);
    await handleAIChat(prompt, ctx);
    return;
  }

  // 3. MCP prompts — server.prompt-name format
  if (cmdName.includes('.')) {
    try {
      const { initMcpServers, getMcpPrompt } = require('./mcp');
      const { prompts } = await initMcpServers(ctx.cwd);
      const mcpPrompt = prompts.find((p: any) => p.name === cmdName);
      if (mcpPrompt) {
        const argObj: Record<string, string> = {};
        const argNames = (mcpPrompt.arguments || []).map((a: any) => a.name);
        rest.forEach((v: string, i: number) => {
          if (argNames[i]) argObj[argNames[i]] = v;
        });
        const promptText = await getMcpPrompt(cmdName, argObj);
        await handleAIChat(promptText, ctx);
        return;
      }
    } catch (err) { swallow(err); }
  }

  console.log(`  ${yellow('!')} Comando desconhecido: ${dim(command)}`);
  console.log(`  ${dim('Use')} ${cyan('/help')} ${dim('para ver comandos disponiveis.')}`);
}
