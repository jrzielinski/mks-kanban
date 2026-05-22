/**
 * plugin-api-mock — Generates API mock handlers from OpenAPI spec.
 * Creates MSW (Mock Service Worker) handlers for frontend testing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';

const OPENAPI_FILES = [
  'openapi.yaml', 'openapi.yml', 'openapi.json',
  'swagger.yaml', 'swagger.yml', 'swagger.json',
];

const plugin: MakeStudioPlugin = {
  name: 'api-mock',
  version: '1.0.0',
  description: 'Generate API mock handlers from OpenAPI spec',

  commands: [
    {
      name: 'mock',
      description: 'Generate MSW mock handlers from OpenAPI spec',
      options: [
        { flags: '-o, --output <path>', description: 'Output file path (default: src/mocks/handlers.ts)' },
        { flags: '-s, --spec <path>', description: 'OpenAPI spec file path (auto-detected if omitted)' },
      ],

      async handler(options: Record<string, any>): Promise<void> {
        const chalk = (await import('chalk')).default;
        const repoPath = process.cwd();
        const outputPath = options.output || 'src/mocks/handlers.ts';

        // Find spec file
        let specPath = options.spec;
        if (!specPath) {
          for (const file of OPENAPI_FILES) {
            const full = path.join(repoPath, file);
            if (fs.existsSync(full)) { specPath = full; break; }
          }
        }

        if (!specPath || !fs.existsSync(specPath)) {
          console.log(chalk.red('No OpenAPI spec found. Use --spec to specify.'));
          return;
        }

        try {
          const content = fs.readFileSync(specPath, 'utf8');
          let spec: any;

          if (specPath.endsWith('.json')) {
            spec = JSON.parse(content);
          } else {
            console.log(chalk.yellow('YAML parsing not supported — use JSON spec or convert first'));
            return;
          }

          if (!spec.paths) {
            console.log(chalk.red('No paths found in spec'));
            return;
          }

          const baseUrl = spec.servers?.[0]?.url || '';
          const handlers: string[] = [];

          for (const [pathStr, methods] of Object.entries(spec.paths || {})) {
            for (const [method, detail] of Object.entries(methods as Record<string, any>)) {
              if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;

              // Generate mock response based on response schema
              const response = detail.responses?.['200'] || detail.responses?.['201'];
              const schema = response?.content?.['application/json']?.schema;
              let mockData = '{}';

              if (schema) {
                mockData = generateMockFromSchema(schema, spec.components?.schemas || {});
              }

              // Convert OpenAPI path params {id} to MSW :id format
              const mswPath = pathStr.replace(/\{(\w+)\}/g, ':$1');

              handlers.push(`  http.${method}('${baseUrl}${mswPath}', () => {
    return HttpResponse.json(${mockData})
  })`);
            }
          }

          const output = `// Auto-generated MSW mock handlers from ${path.basename(specPath)}
import { http, HttpResponse } from 'msw'

export const handlers = [
${handlers.join(',\n\n')}
]
`;

          const fullOutputPath = path.join(repoPath, outputPath);
          fs.mkdirSync(path.dirname(fullOutputPath), { recursive: true });
          fs.writeFileSync(fullOutputPath, output, 'utf8');

          console.log(chalk.green(`✓ Generated ${handlers.length} mock handler(s) at ${outputPath}`));
        } catch (err: any) {
          console.log(chalk.red(`Failed: ${err.message}`));
        }
      },
    },
  ],
};

function generateMockFromSchema(schema: any, schemas: Record<string, any>, depth: number = 0): string {
  if (depth > 3) return '{}';

  if (schema.$ref) {
    const refName = schema.$ref.split('/').pop();
    if (refName && schemas[refName]) {
      return generateMockFromSchema(schemas[refName], schemas, depth + 1);
    }
    return '{}';
  }

  if (schema.type === 'array') {
    const item = generateMockFromSchema(schema.items || {}, schemas, depth + 1);
    return `[${item}]`;
  }

  if (schema.type === 'object' || schema.properties) {
    const props: string[] = [];
    for (const [name, prop] of Object.entries((schema.properties || {}) as Record<string, any>)) {
      const value = getMockValue(name, prop);
      props.push(`${name}: ${value}`);
    }
    return `{ ${props.join(', ')} }`;
  }

  return getMockValue('', schema);
}

function getMockValue(name: string, schema: any): string {
  const type = schema.type || 'string';
  const lowerName = name.toLowerCase();

  if (schema.example !== undefined) return JSON.stringify(schema.example);
  if (schema.enum?.length) return JSON.stringify(schema.enum[0]);

  if (type === 'string') {
    if (lowerName.includes('email')) return "'user@example.com'";
    if (lowerName.includes('name')) return "'John Doe'";
    if (lowerName.includes('id')) return "'abc-123'";
    if (lowerName.includes('url')) return "'https://example.com'";
    if (lowerName.includes('date') || schema.format === 'date-time') return "'2024-01-01T00:00:00Z'";
    return `'mock-${name}'`;
  }
  if (type === 'number' || type === 'integer') return '1';
  if (type === 'boolean') return 'true';
  return 'null';
}

export default plugin;
