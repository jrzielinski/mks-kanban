import { swallow } from '../utils/log';
/**
 * plugin-supabase — Context provider that extracts Supabase schema and config.
 * Connects to Supabase project and injects table definitions, RLS policies, and functions.
 *
 * Config: SUPABASE_URL + SUPABASE_SERVICE_KEY or plugins.supabase.{url, serviceKey}
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';

interface SupabaseConfig { url: string; serviceKey: string; }

function getConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) return { url, serviceKey: key };

  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const sb = config.plugins?.supabase;
      if (sb?.url && sb?.serviceKey) return sb;
    }
  } catch (err) { swallow(err); }

  // Try project .env
  try {
    const envPaths = ['.env', '.env.local', '.env.development'];
    for (const envFile of envPaths) {
      const envPath = path.join(process.cwd(), envFile);
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        const urlMatch = content.match(/SUPABASE_URL=["']?([^\s"']+)/);
        const keyMatch = content.match(/SUPABASE_SERVICE_(?:ROLE_)?KEY=["']?([^\s"']+)/);
        if (urlMatch && keyMatch) return { url: urlMatch[1], serviceKey: keyMatch[1] };
      }
    }
  } catch (err) { swallow(err); }

  return null;
}

async function supabaseRest(config: SupabaseConfig, sqlQuery: string): Promise<any> {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(config.url);
      const body = JSON.stringify({ query: sqlQuery });

      const req = https.request({
        hostname: parsedUrl.hostname,
        path: '/rest/v1/rpc/exec_sql',
        method: 'POST',
        headers: {
          apikey: config.serviceKey,
          Authorization: `Bearer ${config.serviceKey}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
          Prefer: 'return=representation',
        },
        timeout: 20_000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    } catch { resolve(null); }
  });
}

async function supabaseGet(config: SupabaseConfig, apiPath: string): Promise<any> {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(config.url);

      const req = https.request({
        hostname: parsedUrl.hostname,
        path: apiPath,
        method: 'GET',
        headers: {
          apikey: config.serviceKey,
          Authorization: `Bearer ${config.serviceKey}`,
          Accept: 'application/json',
        },
        timeout: 15_000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      });

      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch { resolve(null); }
  });
}

const plugin: MakeStudioPlugin = {
  name: 'supabase',
  version: '1.0.0',
  description: 'Inject Supabase schema, RLS policies, and edge functions as AI context',

  async onLoad(ctx: PluginContext) {
    if (getConfig()) {
      ctx.logger.info('Supabase integration configured');
    } else {
      ctx.logger.warning('Supabase not configured — set SUPABASE_URL + SUPABASE_SERVICE_KEY');
    }
  },

  contextProviders: [
    {
      name: 'supabase-schema',
      fileName: 'supabase-schema.md',

      async generate(_projectId?: string, repoPath?: string): Promise<string | null> {
        const config = getConfig();
        if (!config) return null;

        const lines: string[] = [
          '# Supabase Schema',
          '',
          `> Project: ${config.url}`,
          '',
        ];

        // Get tables via OpenAPI definition endpoint
        const openapi = await supabaseGet(config, '/rest/v1/?apikey=' + config.serviceKey);

        if (openapi?.definitions) {
          lines.push('## Tables', '');

          for (const [tableName, def] of Object.entries(openapi.definitions as Record<string, any>)) {
            if (tableName.startsWith('_')) continue; // Skip internal tables

            lines.push(`### ${tableName}`);

            if (def.properties) {
              lines.push('| Column | Type | Format | Description |');
              lines.push('|--------|------|--------|-------------|');

              for (const [colName, colDef] of Object.entries(def.properties as Record<string, any>)) {
                const required = def.required?.includes(colName) ? ' *required*' : '';
                lines.push(`| ${colName} | ${colDef.type || 'unknown'} | ${colDef.format || '-'} | ${colDef.description || '-'}${required} |`);
              }
            }
            lines.push('');
          }
        }

        // Check for edge functions in project
        const basePath = repoPath || process.cwd();
        const functionsDir = path.join(basePath, 'supabase', 'functions');
        if (fs.existsSync(functionsDir)) {
          lines.push('## Edge Functions', '');
          try {
            for (const entry of fs.readdirSync(functionsDir, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                const indexPath = path.join(functionsDir, entry.name, 'index.ts');
                if (fs.existsSync(indexPath)) {
                  const content = fs.readFileSync(indexPath, 'utf8');
                  const firstComment = content.match(/\/\*\*([\s\S]*?)\*\//)?.[1]?.trim() || '';
                  lines.push(`- **${entry.name}**: ${firstComment || 'Edge function'}`);
                }
              }
            }
          } catch (err) { swallow(err); }
          lines.push('');
        }

        // Check for migrations
        const migrationsDir = path.join(basePath, 'supabase', 'migrations');
        if (fs.existsSync(migrationsDir)) {
          lines.push('## Migrations', '');
          try {
            const migrations = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort().reverse();
            for (const m of migrations.slice(0, 10)) {
              lines.push(`- \`${m}\``);
            }
            if (migrations.length > 10) {
              lines.push(`- ... and ${migrations.length - 10} more`);
            }
          } catch (err) { swallow(err); }
          lines.push('');
        }

        // Check for RLS policies in migrations
        const rlsPolicies: string[] = [];
        if (fs.existsSync(migrationsDir)) {
          try {
            for (const m of fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'))) {
              const content = fs.readFileSync(path.join(migrationsDir, m), 'utf8');
              const policyMatches = content.matchAll(/CREATE\s+POLICY\s+["']([^"']+)["']\s+ON\s+["']?(\w+)["']?/gi);
              for (const match of policyMatches) {
                rlsPolicies.push(`- **${match[1]}** on \`${match[2]}\``);
              }
            }
          } catch (err) { swallow(err); }
        }

        if (rlsPolicies.length > 0) {
          lines.push('## RLS Policies', '', ...rlsPolicies, '');
        }

        return lines.length > 4 ? lines.join('\n') : null;
      },
    },
  ],
};

export default plugin;
