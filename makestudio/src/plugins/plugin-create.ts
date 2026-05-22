/**
 * plugin-create — Scaffold a new MakeStudio plugin from template.
 * Creates a ready-to-use plugin directory with TypeScript setup.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';

const plugin: MakeStudioPlugin = {
  name: 'create-plugin',
  version: '1.0.0',
  description: 'Scaffold a new MakeStudio plugin from template',

  commands: [
    {
      name: 'create-plugin',
      description: 'Create a new MakeStudio plugin from template',
      options: [
        { flags: '-n, --name <name>', description: 'Plugin name (e.g., my-plugin)' },
        { flags: '-t, --type <type>', description: 'Plugin type: hook, verify, context, cli, command (default: hook)' },
        { flags: '-d, --dir <path>', description: 'Output directory (default: current dir)' },
      ],

      async handler(options: Record<string, any>): Promise<void> {
        const chalk = (await import('chalk')).default;
        const name = options.name;
        const type = options.type || 'hook';
        const baseDir = options.dir || process.cwd();

        if (!name) {
          console.log(chalk.red('Plugin name required: --name my-plugin'));
          return;
        }

        const pluginDir = path.join(baseDir, `makestudio-plugin-${name}`);

        if (fs.existsSync(pluginDir)) {
          console.log(chalk.red(`Directory already exists: ${pluginDir}`));
          return;
        }

        fs.mkdirSync(path.join(pluginDir, 'src'), { recursive: true });

        // package.json
        fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
          name: `makestudio-plugin-${name}`,
          version: '1.0.0',
          description: `MakeStudio plugin: ${name}`,
          main: 'dist/index.js',
          types: 'dist/index.d.ts',
          scripts: {
            build: 'tsc',
            dev: 'tsc -w',
          },
          keywords: ['makestudio', 'makestudio-plugin', name],
          files: ['dist/'],
          devDependencies: {
            typescript: '^5.3.0',
          },
        }, null, 2), 'utf8');

        // tsconfig.json
        fs.writeFileSync(path.join(pluginDir, 'tsconfig.json'), JSON.stringify({
          compilerOptions: {
            target: 'ES2020',
            module: 'commonjs',
            lib: ['ES2020'],
            outDir: './dist',
            rootDir: './src',
            declaration: true,
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
          },
          include: ['src/'],
        }, null, 2), 'utf8');

        // Generate template based on type
        const templates: Record<string, string> = {
          hook: `/**
 * makestudio-plugin-${name}
 */

const plugin = {
  name: '${name}',
  version: '1.0.0',
  description: 'My custom MakeStudio plugin',

  async onLoad(ctx) {
    ctx.logger.info('Plugin ${name} loaded!');
  },

  hooks: {
    async beforeTaskExec(task) {
      // Modify task before execution
      return task;
    },

    async afterTaskExec(task, result) {
      // React to task completion
    },
  },
};

export default plugin;
`,
          verify: `/**
 * makestudio-plugin-${name}
 */

const plugin = {
  name: '${name}',
  version: '1.0.0',
  description: 'Custom verification check',

  verifyChecks: [
    {
      name: '${name}',
      appliesTo: ['feature'],

      async run(repoPath, taskType) {
        // Your verification logic here
        return { passed: true, output: 'Check passed!' };
      },
    },
  ],
};

export default plugin;
`,
          context: `/**
 * makestudio-plugin-${name}
 */

const plugin = {
  name: '${name}',
  version: '1.0.0',
  description: 'Custom context provider',

  contextProviders: [
    {
      name: '${name}',
      fileName: '${name}-context.md',

      async generate(projectId, repoPath) {
        // Generate context markdown
        return '# Custom Context\\n\\nYour context here.';
      },
    },
  ],
};

export default plugin;
`,
          cli: `/**
 * makestudio-plugin-${name}
 */

const plugin = {
  name: '${name}',
  version: '1.0.0',
  description: 'Custom CLI strategy',

  cliStrategies: [
    {
      name: '${name}',

      async detect() {
        // Return CLIInfo if installed, null otherwise
        return null;
      },

      buildCommand(prompt, options) {
        return { command: '${name}', args: [] };
      },
    },
  ],
};

export default plugin;
`,
          command: `/**
 * makestudio-plugin-${name}
 */

const plugin = {
  name: '${name}',
  version: '1.0.0',
  description: 'Custom command',

  commands: [
    {
      name: '${name}',
      description: 'My custom command',
      options: [],

      async handler(options) {
        console.log('Hello from ${name} plugin!');
      },
    },
  ],
};

export default plugin;
`,
        };

        const template = templates[type] || templates.hook;
        fs.writeFileSync(path.join(pluginDir, 'src', 'index.ts'), template, 'utf8');

        // README
        fs.writeFileSync(path.join(pluginDir, 'README.md'), `# makestudio-plugin-${name}

A MakeStudio plugin (type: ${type}).

## Install

\`\`\`bash
makestudio plugin install ./makestudio-plugin-${name}
\`\`\`

## Build

\`\`\`bash
cd makestudio-plugin-${name}
npm install
npm run build
\`\`\`
`, 'utf8');

        console.log(chalk.green(`\n✓ Plugin scaffolded at: ${pluginDir}\n`));
        console.log(`  ${chalk.dim('Next steps:')}`);
        console.log(`  ${chalk.cyan(`cd makestudio-plugin-${name}`)}`);
        console.log(`  ${chalk.cyan('npm install')}`);
        console.log(`  ${chalk.cyan('npm run build')}`);
        console.log(`  ${chalk.cyan(`makestudio plugin install .`)}`);
        console.log();
      },
    },
  ],
};

export default plugin;
