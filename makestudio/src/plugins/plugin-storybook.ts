import { swallow } from '../utils/log';
/**
 * plugin-storybook — Auto-generates Storybook stories for new React components.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';
import { TaskDispatch, TaskResult } from '../types';

const plugin: MakeStudioPlugin = {
  name: 'storybook',
  version: '1.0.0',
  description: 'Auto-generate Storybook stories for new React components',

  hooks: {
    async afterTaskExec(task: TaskDispatch, result: TaskResult): Promise<void> {
      if (task.taskType !== 'feature' && task.taskType !== 'design') return;

      try {
        const repoPath = process.cwd();

        // Find new TSX/JSX component files
        const newFiles = execSync(
          'git diff --name-only --diff-filter=A HEAD | grep -E "\\.(tsx|jsx)$" || true',
          { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 10_000 },
        ).trim().split('\n').filter(Boolean);

        if (!newFiles.length) return;

        for (const file of newFiles.slice(0, 10)) {
          const content = fs.readFileSync(path.join(repoPath, file), 'utf8');

          // Check if it's a component (exports a function/const that returns JSX)
          const componentMatch = content.match(/export\s+(?:default\s+)?(?:function|const)\s+(\w+)/);
          if (!componentMatch) continue;

          const componentName = componentMatch[1];
          const storyPath = file.replace(/\.(tsx|jsx)$/, '.stories.$1');

          // Don't overwrite existing stories
          if (fs.existsSync(path.join(repoPath, storyPath))) continue;

          // Extract props interface
          const propsMatch = content.match(/interface\s+(\w*Props)\s*\{([^}]*)\}/s);
          const propsName = propsMatch?.[1] || `${componentName}Props`;
          const propsBody = propsMatch?.[2] || '';

          // Parse prop names for args
          const propNames = propsBody.split('\n')
            .map(line => line.trim().match(/^(\w+)\s*[?:]/))?.[0]
            ?.filter(Boolean) || [];

          const importPath = './' + path.basename(file).replace(/\.(tsx|jsx)$/, '');

          const story = `import type { Meta, StoryObj } from '@storybook/react';
import { ${componentName} } from '${importPath}';

const meta: Meta<typeof ${componentName}> = {
  title: 'Components/${componentName}',
  component: ${componentName},
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof ${componentName}>;

export const Default: Story = {
  args: {},
};
`;

          fs.writeFileSync(path.join(repoPath, storyPath), story, 'utf8');
        }
      } catch (err) { swallow(err); }
    },
  },
};

export default plugin;
