import { swallow } from '../utils/log';
/**
 * plugin-seed — Generates database seed data based on entity schemas.
 * Scans TypeORM entities and generates realistic seed files.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';

const plugin: MakeStudioPlugin = {
  name: 'seed',
  version: '1.0.0',
  description: 'Generate database seed data from TypeORM entity schemas',

  contextProviders: [
    {
      name: 'entity-schema',
      fileName: 'entity-schema.md',

      async generate(_projectId?: string, repoPath?: string): Promise<string | null> {
        const basePath = repoPath || process.cwd();

        // Find entity files
        const entityDirs = ['src', 'src/entities', 'src/database/entities'];
        const entityFiles: string[] = [];

        const walkDir = (dir: string) => {
          try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              if (entry.name === 'node_modules' || entry.name === 'dist') continue;
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                walkDir(fullPath);
              } else if (entry.name.endsWith('.entity.ts')) {
                entityFiles.push(fullPath);
              }
            }
          } catch (err) { swallow(err); }
        };

        for (const dir of entityDirs) {
          walkDir(path.join(basePath, dir));
        }

        if (entityFiles.length === 0) return null;

        const lines: string[] = [
          '# Entity Schema Summary',
          '',
          `> ${entityFiles.length} entity file(s) found`,
          '',
        ];

        for (const file of entityFiles.slice(0, 30)) {
          try {
            const content = fs.readFileSync(file, 'utf8');
            const className = content.match(/export\s+class\s+(\w+)/)?.[1] || path.basename(file);
            const tableName = content.match(/@Entity\(['"](\w+)['"]\)/)?.[1] || '';

            // Extract columns
            const columns: string[] = [];
            const columnMatches = content.matchAll(/@(?:Column|PrimaryGeneratedColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn)(?:\([^)]*\))?\s*\n?\s*(\w+)\s*[?:]?\s*:?\s*(\w+)?/g);
            for (const match of columnMatches) {
              columns.push(`${match[1]}: ${match[2] || 'unknown'}`);
            }

            // Extract relations
            const relations: string[] = [];
            const relMatches = content.matchAll(/@(?:ManyToOne|OneToMany|ManyToMany|OneToOne)\([^)]*\)\s*\n?\s*(\w+)\s*[?:]?\s*:?\s*(\w+)?/g);
            for (const match of relMatches) {
              relations.push(`${match[1]}: ${match[2] || 'unknown'}`);
            }

            lines.push(`## ${className}${tableName ? ` (\`${tableName}\`)` : ''}`);
            lines.push(`*File: ${path.relative(basePath, file)}*`);
            if (columns.length) lines.push(`**Columns:** ${columns.join(', ')}`);
            if (relations.length) lines.push(`**Relations:** ${relations.join(', ')}`);
            lines.push('');
          } catch (err) { swallow(err); }
        }

        return lines.join('\n');
      },
    },
  ],
};

export default plugin;
