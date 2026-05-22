import { swallow } from '../utils/log';
/**
 * plugin-db-schema — Injects live database schema as context for AI.
 * Connects to PostgreSQL and extracts tables, columns, FKs, indexes.
 *
 * Config: plugins.dbSchema.connectionString or DATABASE_URL env var
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';

function getConnectionString(): string | null {
  const envUrl = process.env.DATABASE_URL || process.env.MAKESTUDIO_DB_URL;
  if (envUrl) return envUrl;

  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.plugins?.dbSchema?.connectionString || null;
    }
  } catch (err) { swallow(err); }

  // Try to read from project .env
  try {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const match = envContent.match(/DATABASE_URL=(.+)/);
      if (match) return match[1].trim().replace(/["']/g, '');
    }
  } catch (err) { swallow(err); }

  return null;
}

const plugin: MakeStudioPlugin = {
  name: 'db-schema',
  version: '1.0.0',
  description: 'Inject live PostgreSQL database schema as AI context',

  async onLoad(ctx: PluginContext) {
    if (getConnectionString()) {
      ctx.logger.info('Database schema provider configured');
    } else {
      ctx.logger.warning('DB schema not configured — set DATABASE_URL or plugins.dbSchema.connectionString');
    }
  },

  contextProviders: [
    {
      name: 'db-schema',
      fileName: 'database-schema.md',

      async generate(_projectId?: string, repoPath?: string): Promise<string | null> {
        const connStr = getConnectionString();
        if (!connStr) return null;

        try {
          // Use psql to extract schema — works without node-pg dependency
          const schemaQuery = `
            SELECT
              t.table_name,
              c.column_name,
              c.data_type,
              c.is_nullable,
              c.column_default,
              tc.constraint_type,
              kcu2.table_name AS fk_table
            FROM information_schema.tables t
            JOIN information_schema.columns c ON t.table_name = c.table_name AND t.table_schema = c.table_schema
            LEFT JOIN information_schema.key_column_usage kcu ON c.column_name = kcu.column_name AND c.table_name = kcu.table_name
            LEFT JOIN information_schema.table_constraints tc ON kcu.constraint_name = tc.constraint_name AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')
            LEFT JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
            LEFT JOIN information_schema.key_column_usage kcu2 ON rc.unique_constraint_name = kcu2.constraint_name AND kcu2.ordinal_position = 1
            WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
            ORDER BY t.table_name, c.ordinal_position;
          `;

          const result = execSync(
            `psql "${connStr}" -t -A -F"|" -c "${schemaQuery.replace(/\n/g, ' ')}" 2>/dev/null`,
            { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 },
          ).trim();

          if (!result) return null;

          // Parse and format as markdown
          const tables: Record<string, Array<{ col: string; type: string; nullable: string; default: string; constraint: string; fk: string }>> = {};

          for (const line of result.split('\n')) {
            const [table, col, type, nullable, defaultVal, constraint, fkTable] = line.split('|');
            if (!table || !col) continue;

            if (!tables[table]) tables[table] = [];
            tables[table].push({
              col, type: type || '',
              nullable: nullable || 'YES',
              default: defaultVal || '',
              constraint: constraint || '',
              fk: fkTable || '',
            });
          }

          const lines: string[] = [
            '# Database Schema (Live)',
            '',
            `> ${Object.keys(tables).length} tables in public schema`,
            '',
          ];

          for (const [tableName, columns] of Object.entries(tables)) {
            lines.push(`## ${tableName}`);
            lines.push('| Column | Type | Nullable | Default | Constraint | FK |');
            lines.push('|--------|------|----------|---------|------------|-----|');

            // Deduplicate columns
            const seen = new Set<string>();
            for (const c of columns) {
              if (seen.has(c.col)) continue;
              seen.add(c.col);
              lines.push(`| ${c.col} | ${c.type} | ${c.nullable} | ${c.default || '-'} | ${c.constraint || '-'} | ${c.fk || '-'} |`);
            }
            lines.push('');
          }

          return lines.join('\n');
        } catch {
          return null;
        }
      },
    },
  ],
};

export default plugin;
