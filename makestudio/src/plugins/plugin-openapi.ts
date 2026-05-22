/**
 * plugin-openapi — Injects OpenAPI/Swagger spec as context for AI.
 * Auto-detects openapi.yaml, openapi.json, swagger.json in the repo.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';

const OPENAPI_FILES = [
  'openapi.yaml', 'openapi.yml', 'openapi.json',
  'swagger.yaml', 'swagger.yml', 'swagger.json',
  'docs/openapi.yaml', 'docs/openapi.json',
  'api/openapi.yaml', 'api/openapi.json',
];

const plugin: MakeStudioPlugin = {
  name: 'openapi',
  version: '1.0.0',
  description: 'Inject OpenAPI/Swagger spec as AI context',

  contextProviders: [
    {
      name: 'openapi',
      fileName: 'api-spec.md',

      async generate(_projectId?: string, repoPath?: string): Promise<string | null> {
        const basePath = repoPath || process.cwd();

        // Find first matching OpenAPI file
        let specPath: string | null = null;
        for (const file of OPENAPI_FILES) {
          const fullPath = path.join(basePath, file);
          if (fs.existsSync(fullPath)) {
            specPath = fullPath;
            break;
          }
        }

        if (!specPath) return null;

        try {
          const content = fs.readFileSync(specPath, 'utf8');
          let spec: any;

          if (specPath.endsWith('.json')) {
            spec = JSON.parse(content);
          } else {
            // For YAML, do a basic parse (avoid extra dep)
            // Just include raw YAML as context
            return [
              '# API Specification (OpenAPI)',
              '',
              `> Source: ${path.relative(basePath, specPath)}`,
              '',
              '```yaml',
              content.substring(0, 50_000), // Cap at 50KB
              '```',
            ].join('\n');
          }

          // Format JSON spec as readable markdown
          const lines: string[] = [
            `# API Specification: ${spec.info?.title || 'API'}`,
            '',
            `> Version: ${spec.info?.version || 'unknown'}`,
            spec.info?.description ? `> ${spec.info.description}` : '',
            '',
          ];

          if (spec.paths) {
            lines.push('## Endpoints', '');
            for (const [pathStr, methods] of Object.entries(spec.paths || {})) {
              for (const [method, detail] of Object.entries(methods as Record<string, any>)) {
                if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
                  lines.push(`### \`${method.toUpperCase()} ${pathStr}\``);
                  if (detail.summary) lines.push(detail.summary);
                  if (detail.description) lines.push(detail.description);
                  if (detail.parameters?.length) {
                    lines.push('**Parameters:**');
                    for (const p of detail.parameters) {
                      lines.push(`- \`${p.name}\` (${p.in}) — ${p.description || p.schema?.type || 'any'}${p.required ? ' *required*' : ''}`);
                    }
                  }
                  lines.push('');
                }
              }
            }
          }

          if (spec.components?.schemas) {
            lines.push('## Schemas', '');
            for (const [name, schema] of Object.entries(spec.components.schemas as Record<string, any>)) {
              lines.push(`### ${name}`);
              if (schema.properties) {
                for (const [prop, def] of Object.entries(schema.properties as Record<string, any>)) {
                  const required = schema.required?.includes(prop) ? ' *required*' : '';
                  lines.push(`- \`${prop}\`: ${def.type || def.$ref || 'any'}${required}`);
                }
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
};

export default plugin;
