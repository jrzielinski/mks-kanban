import { swallow } from '../utils/log';
/**
 * plugin-notion — Injects Notion documentation pages as AI context.
 * Config: MAKESTUDIO_NOTION_TOKEN + plugins.notion.pageIds[]
 */

import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MakeStudioPlugin, PluginContext } from '../core/plugin-types';

interface NotionConfig { token: string; pageIds: string[]; }

function getConfig(): NotionConfig | null {
  const token = process.env.MAKESTUDIO_NOTION_TOKEN;
  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const notion = config.plugins?.notion;
      const t = token || notion?.token;
      const pages = notion?.pageIds;
      if (t && pages?.length) return { token: t, pageIds: pages };
    }
  } catch (err) { swallow(err); }
  return null;
}

async function notionGet(token: string, apiPath: string): Promise<any> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.notion.com',
      path: apiPath,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
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
  });
}

function blocksToMarkdown(blocks: any[]): string {
  const lines: string[] = [];

  for (const block of blocks) {
    const type = block.type;
    const content = block[type];

    if (!content) continue;

    const text = content.rich_text?.map((t: any) => t.plain_text).join('') || '';

    switch (type) {
      case 'paragraph': lines.push(text, ''); break;
      case 'heading_1': lines.push(`# ${text}`, ''); break;
      case 'heading_2': lines.push(`## ${text}`, ''); break;
      case 'heading_3': lines.push(`### ${text}`, ''); break;
      case 'bulleted_list_item': lines.push(`- ${text}`); break;
      case 'numbered_list_item': lines.push(`1. ${text}`); break;
      case 'code': lines.push('```' + (content.language || ''), text, '```', ''); break;
      case 'quote': lines.push(`> ${text}`, ''); break;
      case 'divider': lines.push('---', ''); break;
      case 'to_do': lines.push(`- [${content.checked ? 'x' : ' '}] ${text}`); break;
      default: if (text) lines.push(text, '');
    }
  }

  return lines.join('\n');
}

const plugin: MakeStudioPlugin = {
  name: 'notion',
  version: '1.0.0',
  description: 'Inject Notion documentation as AI context',

  async onLoad(ctx: PluginContext) {
    if (getConfig()) {
      ctx.logger.info('Notion integration configured');
    } else {
      ctx.logger.warning('Notion not configured — set MAKESTUDIO_NOTION_TOKEN + plugins.notion.pageIds');
    }
  },

  contextProviders: [
    {
      name: 'notion-docs',
      fileName: 'notion-docs.md',

      async generate(): Promise<string | null> {
        const config = getConfig();
        if (!config) return null;

        const lines: string[] = ['# Project Documentation (Notion)', ''];
        let hasContent = false;

        for (const pageId of config.pageIds.slice(0, 5)) { // Max 5 pages
          // Get page title
          const page = await notionGet(config.token, `/v1/pages/${pageId}`);
          const title = page?.properties?.title?.title?.[0]?.plain_text
            || page?.properties?.Name?.title?.[0]?.plain_text
            || 'Untitled';

          // Get page blocks (content)
          const blocksRes = await notionGet(config.token, `/v1/blocks/${pageId}/children?page_size=100`);
          if (!blocksRes?.results?.length) continue;

          lines.push(`## ${title}`, '');
          lines.push(blocksToMarkdown(blocksRes.results));
          lines.push('---', '');
          hasContent = true;
        }

        return hasContent ? lines.join('\n') : null;
      },
    },
  ],
};

export default plugin;
