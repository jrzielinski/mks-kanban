import { swallow } from '../utils/log';
/**
 * plugin-figma — Injects Figma design specs as context for AI.
 * Config: MAKESTUDIO_FIGMA_TOKEN + plugins.figma.fileKey
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';

interface FigmaConfig { token: string; fileKey: string; }

function getConfig(): FigmaConfig | null {
  const token = process.env.MAKESTUDIO_FIGMA_TOKEN;
  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const fg = config.plugins?.figma;
      const t = token || fg?.token;
      const fk = fg?.fileKey;
      if (t && fk) return { token: t, fileKey: fk };
    }
  } catch (err) { swallow(err); }
  return null;
}

async function figmaGet(token: string, apiPath: string): Promise<any> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.figma.com',
      path: apiPath,
      method: 'GET',
      headers: { 'X-Figma-Token': token },
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
    req.end();
  });
}

function extractComponents(node: any, depth: number = 0): string[] {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);

  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
    lines.push(`${indent}- **${node.name}** (${node.type})`);
    if (node.description) lines.push(`${indent}  ${node.description}`);
  } else if (node.type === 'FRAME' || node.type === 'GROUP') {
    lines.push(`${indent}- ${node.name} (${node.type})`);
  }

  if (node.children && depth < 4) {
    for (const child of node.children) {
      lines.push(...extractComponents(child, depth + 1));
    }
  }

  return lines;
}

const plugin: MakeStudioPlugin = {
  name: 'figma',
  version: '1.0.0',
  description: 'Inject Figma design specs as AI context',

  async onLoad(ctx: PluginContext) {
    if (getConfig()) {
      ctx.logger.info('Figma integration configured');
    } else {
      ctx.logger.warning('Figma not configured — set MAKESTUDIO_FIGMA_TOKEN + plugins.figma.fileKey');
    }
  },

  contextProviders: [
    {
      name: 'figma-design',
      fileName: 'figma-design.md',

      async generate(): Promise<string | null> {
        const config = getConfig();
        if (!config) return null;

        const file = await figmaGet(config.token, `/v1/files/${config.fileKey}?depth=3`);
        if (!file || !file.document) return null;

        const lines: string[] = [
          `# Figma Design: ${file.name || 'Design File'}`,
          '',
          `> Last modified: ${file.lastModified || 'unknown'}`,
          '',
        ];

        // Extract pages and components
        if (file.document.children) {
          for (const page of file.document.children) {
            lines.push(`## Page: ${page.name}`, '');
            lines.push(...extractComponents(page, 0));
            lines.push('');
          }
        }

        // Extract styles
        if (file.styles) {
          lines.push('## Design Tokens', '');
          for (const [id, style] of Object.entries(file.styles as Record<string, any>)) {
            lines.push(`- **${style.name}** (${style.styleType}): ${style.description || 'no description'}`);
          }
          lines.push('');
        }

        return lines.join('\n');
      },
    },
  ],
};

export default plugin;
