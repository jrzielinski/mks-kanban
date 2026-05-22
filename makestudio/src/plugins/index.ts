/**
 * Built-in plugins barrel export.
 * These plugins ship with the agent and can be enabled/disabled via config.
 */

import { MakeStudioPlugin } from '../core/plugin-types';

// ── Verify Checks ────────────────────���──────────────────────────
import eslintPlugin from './plugin-eslint';
import jestPlugin from './plugin-jest';
import prettierPlugin from './plugin-prettier';
import securityScanPlugin from './plugin-security-scan';
import envCheckPlugin from './plugin-env-check';
import typeCoveragePlugin from './plugin-type-coverage';
import deadCodePlugin from './plugin-dead-code';
import complexityPlugin from './plugin-complexity';
import circularDepsPlugin from './plugin-circular-deps';
import migrationCheckPlugin from './plugin-migration-check';
import i18nPlugin from './plugin-i18n';

// ── Lifecycle Hooks ─────────────────────���───────────────────────
import slackPlugin from './plugin-slack';
import discordPlugin from './plugin-discord';
import telegramPlugin from './plugin-telegram';
import costAlertPlugin from './plugin-cost-alert';
import prReviewPlugin from './plugin-pr-review';
import changelogPlugin from './plugin-changelog';
import metricsPlugin from './plugin-metrics';
import gitConventionalPlugin from './plugin-git-conventional';
import backupPlugin from './plugin-backup';
import jiraPlugin from './plugin-jira';
import linearPlugin from './plugin-linear';
import githubIssuesPlugin from './plugin-github-issues';
import webhookPlugin from './plugin-webhook';
import ciStatusPlugin from './plugin-ci-status';
import autoReviewPlugin from './plugin-auto-review';
import storybookPlugin from './plugin-storybook';
import selfHealPlugin from './plugin-self-heal';

// ── Kanban ──────────────────────────────────────────────────────
import kanbanSyncPlugin from './plugin-kanban-sync';
import kanbanAutoAssignPlugin from './plugin-kanban-auto-assign';
import kanbanBurndownPlugin from './plugin-kanban-burndown';
import kanbanWipAlertPlugin from './plugin-kanban-wip-alert';
import kanbanConsolePlugin from './plugin-kanban-console';

// ── AI Enhancement ──────────��───────────────────────────────────
import learningPlugin from './plugin-learning';
import tokenOptimizerPlugin from './plugin-token-optimizer';
import promptCachePlugin from './plugin-prompt-cache';
import abTestingPlugin from './plugin-ab-testing';

// ── Context Providers ───────────────────────────────────────────
import sentryPlugin from './plugin-sentry';
import dbSchemaPlugin from './plugin-db-schema';
import openapiPlugin from './plugin-openapi';
import figmaPlugin from './plugin-figma';
import notionPlugin from './plugin-notion';
import ragPlugin from './plugin-rag';
import seedPlugin from './plugin-seed';

// ── CLI Strategies ��────────────────────────────────────────���────
import cursorPlugin from './plugin-cursor';
import aiderPlugin from './plugin-aider';

// ── Platform Integrations ───────────────────────────────────────
import gitlabPlugin from './plugin-gitlab';
import bitbucketPlugin from './plugin-bitbucket';
import supabasePlugin from './plugin-supabase';
import prismaPlugin from './plugin-prisma';

// ── Commands ────────────────────────────────────────────────────
import dockerDeployPlugin from './plugin-docker-deploy';
import dashboardPlugin from './plugin-dashboard';
import k8sPlugin from './plugin-k8s';
import rollbackPlugin from './plugin-rollback';
import tracingPlugin from './plugin-tracing';
import watcherPlugin from './plugin-watcher';
import cronPlugin from './plugin-cron';
import apiMockPlugin from './plugin-api-mock';
import marketplacePlugin from './plugin-marketplace';
import createPluginPlugin from './plugin-create';

/**
 * All built-in plugins with their default enabled state.
 * Plugins requiring external config are disabled by default.
 * Total: 60 plugins
 */
export const builtinPlugins: Array<{ plugin: MakeStudioPlugin; enabledByDefault: boolean }> = [
  // ── Always-on by default — safe, no external dependencies ─────
  { plugin: metricsPlugin, enabledByDefault: true },
  { plugin: backupPlugin, enabledByDefault: true },
  { plugin: changelogPlugin, enabledByDefault: true },
  { plugin: gitConventionalPlugin, enabledByDefault: true },
  { plugin: prReviewPlugin, enabledByDefault: true },
  { plugin: costAlertPlugin, enabledByDefault: true },
  { plugin: envCheckPlugin, enabledByDefault: true },
  { plugin: learningPlugin, enabledByDefault: true },
  { plugin: tokenOptimizerPlugin, enabledByDefault: true },
  { plugin: abTestingPlugin, enabledByDefault: true },
  { plugin: migrationCheckPlugin, enabledByDefault: true },
  { plugin: tracingPlugin, enabledByDefault: true },
  { plugin: autoReviewPlugin, enabledByDefault: true },
  { plugin: selfHealPlugin, enabledByDefault: true },
  { plugin: kanbanBurndownPlugin, enabledByDefault: true },

  // ── Code quality — require project tooling ────────────────────
  { plugin: eslintPlugin, enabledByDefault: false },
  { plugin: jestPlugin, enabledByDefault: false },
  { plugin: prettierPlugin, enabledByDefault: false },
  { plugin: securityScanPlugin, enabledByDefault: false },
  { plugin: typeCoveragePlugin, enabledByDefault: false },
  { plugin: deadCodePlugin, enabledByDefault: false },
  { plugin: complexityPlugin, enabledByDefault: false },
  { plugin: circularDepsPlugin, enabledByDefault: false },
  { plugin: i18nPlugin, enabledByDefault: false },
  { plugin: storybookPlugin, enabledByDefault: false },

  // ── Kanban — require server connection ──────────────────────────
  { plugin: kanbanSyncPlugin, enabledByDefault: false },
  { plugin: kanbanAutoAssignPlugin, enabledByDefault: false },
  { plugin: kanbanWipAlertPlugin, enabledByDefault: false },
  // kanban-console is the /kanban TUI — no hard external deps; it just
  // checks login at runtime and bails with a friendly message otherwise.
  { plugin: kanbanConsolePlugin, enabledByDefault: true },

  // ── Context providers — some require external config ──────────
  { plugin: ragPlugin, enabledByDefault: false },
  { plugin: openapiPlugin, enabledByDefault: false },
  { plugin: dbSchemaPlugin, enabledByDefault: false },
  { plugin: sentryPlugin, enabledByDefault: false },
  { plugin: figmaPlugin, enabledByDefault: false },
  { plugin: notionPlugin, enabledByDefault: false },
  { plugin: seedPlugin, enabledByDefault: false },

  // ─�� Integrations — require external configuration ─────────────
  { plugin: slackPlugin, enabledByDefault: false },
  { plugin: discordPlugin, enabledByDefault: false },
  { plugin: telegramPlugin, enabledByDefault: false },
  { plugin: jiraPlugin, enabledByDefault: false },
  { plugin: linearPlugin, enabledByDefault: false },
  { plugin: githubIssuesPlugin, enabledByDefault: false },
  { plugin: webhookPlugin, enabledByDefault: false },
  { plugin: ciStatusPlugin, enabledByDefault: false },

  // ── Platform integrations — require external config ────────────
  { plugin: gitlabPlugin, enabledByDefault: false },
  { plugin: bitbucketPlugin, enabledByDefault: false },
  { plugin: supabasePlugin, enabledByDefault: false },
  { plugin: prismaPlugin, enabledByDefault: false },

  // ── AI enhancement ────────────────────────────────────────────
  { plugin: promptCachePlugin, enabledByDefault: false },

  // ── CLI strategies ────────────────────────────────────────────
  { plugin: cursorPlugin, enabledByDefault: false },
  { plugin: aiderPlugin, enabledByDefault: false },

  // ── Commands ──────────────────────────────────────────────────
  { plugin: dockerDeployPlugin, enabledByDefault: false },
  { plugin: dashboardPlugin, enabledByDefault: false },
  { plugin: k8sPlugin, enabledByDefault: false },
  { plugin: rollbackPlugin, enabledByDefault: false },
  { plugin: watcherPlugin, enabledByDefault: false },
  { plugin: cronPlugin, enabledByDefault: false },
  { plugin: apiMockPlugin, enabledByDefault: false },
  { plugin: marketplacePlugin, enabledByDefault: false },
  { plugin: createPluginPlugin, enabledByDefault: false },
];
