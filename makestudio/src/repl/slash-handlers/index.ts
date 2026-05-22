/**
 * Barrel exporting BUILTIN_SLASH_COMMANDS as the union of all topics.
 */

import { AGENT_SLASH_COMMANDS } from './agent';
import { CLUSTER_SLASH_COMMANDS } from './cluster';
import { MODEL_SLASH_COMMANDS } from './model';
import { REPO_SLASH_COMMANDS } from './repo';
import { SECURITY_SLASH_COMMANDS } from './security';
import { SESSION_SLASH_COMMANDS } from './session';
import { SYSTEM_SLASH_COMMANDS } from './system';
import { UI_SLASH_COMMANDS } from './ui';
import { ASK_SLASH_COMMANDS } from './ask';
import { REMOTE_SLASH_COMMANDS } from './remote';
import { EASTER_EGG_SLASH_COMMANDS } from './easter-eggs';
import { FILES_SLASH_COMMANDS } from './files';
import { THINKBACK_SLASH_COMMANDS } from './thinkback';
import { CTX_VIZ_SLASH_COMMANDS } from './ctx-viz';
import { TELEPORT_SLASH_COMMANDS } from './teleport';
import { INSIGHTS_SLASH_COMMANDS } from './insights';
import { DIAGNOSE_SLASH_COMMANDS } from './diagnose';
import { DIFF_SLASH_COMMANDS } from './diff';
import { EFFICIENCY_SLASH_COMMANDS } from './efficiency';
import { REPLAY_SLASH_COMMANDS } from './replay';

import type { SlashCommand } from '../slash-registry';

export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  ...AGENT_SLASH_COMMANDS,
  ...ASK_SLASH_COMMANDS,
  ...CLUSTER_SLASH_COMMANDS,
  ...CTX_VIZ_SLASH_COMMANDS,
  ...DIAGNOSE_SLASH_COMMANDS,
  ...DIFF_SLASH_COMMANDS,
  ...EFFICIENCY_SLASH_COMMANDS,
  ...FILES_SLASH_COMMANDS,
  ...INSIGHTS_SLASH_COMMANDS,
  ...TELEPORT_SLASH_COMMANDS,
  ...THINKBACK_SLASH_COMMANDS,
  ...MODEL_SLASH_COMMANDS,
  ...REMOTE_SLASH_COMMANDS,
  ...REPLAY_SLASH_COMMANDS,
  ...REPO_SLASH_COMMANDS,
  ...SECURITY_SLASH_COMMANDS,
  ...SESSION_SLASH_COMMANDS,
  ...SYSTEM_SLASH_COMMANDS,
  ...UI_SLASH_COMMANDS,
  ...EASTER_EGG_SLASH_COMMANDS,
];
