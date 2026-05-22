/**
 * plugin-prisma — Context provider for Prisma-based projects.
 * Parses prisma/schema.prisma and injects models, relations, and enums as AI context.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';

interface PrismaModel {
  name: string;
  fields: Array<{ name: string; type: string; attributes: string }>;
}

interface PrismaEnum {
  name: string;
  values: string[];
}

function parsePrismaSchema(content: string): { models: PrismaModel[]; enums: PrismaEnum[]; datasource: string; generator: string } {
  const models: PrismaModel[] = [];
  const enums: PrismaEnum[] = [];
  let datasource = '';
  let generator = '';

  const blocks = content.split(/\n(?=\w)/);

  for (const block of blocks) {
    const trimmed = block.trim();

    // Datasource
    const dsMatch = trimmed.match(/datasource\s+\w+\s*\{([^}]+)\}/s);
    if (dsMatch) {
      const providerMatch = dsMatch[1].match(/provider\s*=\s*"(\w+)"/);
      datasource = providerMatch?.[1] || 'unknown';
      continue;
    }

    // Generator
    const genMatch = trimmed.match(/generator\s+\w+\s*\{([^}]+)\}/s);
    if (genMatch) {
      const providerMatch = genMatch[1].match(/provider\s*=\s*"([^"]+)"/);
      generator = providerMatch?.[1] || 'prisma-client-js';
      continue;
    }

    // Model
    const modelMatch = trimmed.match(/model\s+(\w+)\s*\{([^}]+)\}/s);
    if (modelMatch) {
      const modelName = modelMatch[1];
      const fieldLines = modelMatch[2].split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//') && !l.startsWith('@@'));

      const fields: PrismaModel['fields'] = [];
      for (const line of fieldLines) {
        const fieldMatch = line.match(/^(\w+)\s+([\w\[\]?]+)\s*(.*)/);
        if (fieldMatch) {
          fields.push({
            name: fieldMatch[1],
            type: fieldMatch[2],
            attributes: fieldMatch[3]?.trim() || '',
          });
        }
      }

      models.push({ name: modelName, fields });
      continue;
    }

    // Enum
    const enumMatch = trimmed.match(/enum\s+(\w+)\s*\{([^}]+)\}/s);
    if (enumMatch) {
      const values = enumMatch[2].split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));
      enums.push({ name: enumMatch[1], values });
    }
  }

  return { models, enums, datasource, generator };
}

const SCHEMA_PATHS = [
  'prisma/schema.prisma',
  'schema.prisma',
  'packages/database/prisma/schema.prisma',
  'apps/api/prisma/schema.prisma',
];

const plugin: MakeStudioPlugin = {
  name: 'prisma',
  version: '1.0.0',
  description: 'Parse Prisma schema and inject models/relations as AI context',

  contextProviders: [
    {
      name: 'prisma-schema',
      fileName: 'prisma-schema.md',

      async generate(_projectId?: string, repoPath?: string): Promise<string | null> {
        const basePath = repoPath || process.cwd();

        // Find schema file
        let schemaPath: string | null = null;
        for (const sp of SCHEMA_PATHS) {
          const full = path.join(basePath, sp);
          if (fs.existsSync(full)) { schemaPath = full; break; }
        }

        if (!schemaPath) return null;

        try {
          const content = fs.readFileSync(schemaPath, 'utf8');
          const { models, enums, datasource, generator } = parsePrismaSchema(content);

          if (models.length === 0) return null;

          const lines: string[] = [
            '# Prisma Schema',
            '',
            `> Source: ${path.relative(basePath, schemaPath)}`,
            `> Datasource: ${datasource} | Generator: ${generator}`,
            `> ${models.length} model(s), ${enums.length} enum(s)`,
            '',
          ];

          // Models
          for (const model of models) {
            lines.push(`## ${model.name}`);
            lines.push('| Field | Type | Attributes |');
            lines.push('|-------|------|------------|');

            for (const field of model.fields) {
              const attrs = field.attributes
                .replace(/@id/g, '**PK**')
                .replace(/@unique/g, '**unique**')
                .replace(/@default\(([^)]+)\)/g, 'default: $1')
                .replace(/@relation\(([^)]+)\)/g, 'FK: $1')
                .replace(/@map\("[^"]+"\)/g, '')
                .trim();

              lines.push(`| ${field.name} | \`${field.type}\` | ${attrs || '-'} |`);
            }
            lines.push('');
          }

          // Enums
          if (enums.length > 0) {
            lines.push('## Enums', '');
            for (const e of enums) {
              lines.push(`### ${e.name}`);
              lines.push(e.values.map(v => `- \`${v}\``).join('\n'));
              lines.push('');
            }
          }

          // Also check for Prisma migrations
          const migrationsDir = path.join(path.dirname(schemaPath), 'migrations');
          if (fs.existsSync(migrationsDir)) {
            const migrations = fs.readdirSync(migrationsDir, { withFileTypes: true })
              .filter(e => e.isDirectory())
              .map(e => e.name)
              .sort()
              .reverse();

            if (migrations.length > 0) {
              lines.push('## Recent Migrations', '');
              for (const m of migrations.slice(0, 10)) {
                lines.push(`- \`${m}\``);
              }
              lines.push('');
            }
          }

          return lines.join('\n');
        } catch {
          return null;
        }
      },
    },
  ],

  verifyChecks: [
    {
      name: 'prisma-validate',
      appliesTo: ['database', 'feature', 'architecture'],

      async run(repoPath: string): Promise<{ passed: boolean; output?: string }> {
        // Check if schema.prisma was modified
        const { execSync } = await import('child_process');
        try {
          const modifiedFiles = execSync(
            'git diff --name-only --diff-filter=ACMR HEAD | grep -i prisma || true',
            { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
          ).trim();

          if (!modifiedFiles) return { passed: true, output: 'No Prisma files modified' };

          // Validate schema
          try {
            execSync('npx prisma validate 2>&1', {
              cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 30_000,
            });
            return { passed: true, output: 'Prisma schema valid' };
          } catch (err: any) {
            return { passed: false, output: `Prisma validation failed: ${(err.stdout || err.message).substring(0, 300)}` };
          }
        } catch {
          return { passed: true, output: 'Prisma check skipped' };
        }
      },
    },
  ],
};

export default plugin;
