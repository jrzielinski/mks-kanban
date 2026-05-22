/**
 * plugin-k8s — Kubernetes deployment commands.
 * Adds `makestudio k8s` subcommands for deploy, rollback, status.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { MakeStudioPlugin } from '../core/plugin-types';

const plugin: MakeStudioPlugin = {
  name: 'k8s',
  version: '1.0.0',
  description: 'Kubernetes deployment, rollback, and status commands',

  commands: [
    {
      name: 'k8s',
      description: 'Kubernetes operations — deploy, rollback, status',
      options: [
        { flags: '-a, --action <action>', description: 'Action: deploy, rollback, status, logs (default: status)' },
        { flags: '-n, --namespace <ns>', description: 'Kubernetes namespace (default: from kubeconfig)' },
        { flags: '-d, --deployment <name>', description: 'Deployment name' },
        { flags: '-i, --image <tag>', description: 'Image tag for deploy (default: latest)' },
      ],

      async handler(options: Record<string, any>): Promise<void> {
        const chalk = (await import('chalk')).default;
        const action = options.action || 'status';
        const namespace = options.namespace ? `-n ${options.namespace}` : '';
        const deployment = options.deployment || '';

        // Check kubectl
        try {
          execSync('kubectl version --client --short 2>/dev/null', { stdio: 'pipe' });
        } catch {
          console.log(chalk.red('kubectl not found. Install: https://kubernetes.io/docs/tasks/tools/'));
          return;
        }

        try {
          switch (action) {
            case 'status': {
              console.log(chalk.cyan('Cluster Status:'));
              const pods = execSync(`kubectl get pods ${namespace} --no-headers 2>&1`, { encoding: 'utf8', stdio: 'pipe' });
              console.log(pods);

              if (deployment) {
                console.log(chalk.cyan(`\nDeployment: ${deployment}`));
                const deploy = execSync(`kubectl describe deployment ${deployment} ${namespace} 2>&1`, { encoding: 'utf8', stdio: 'pipe' });
                // Show just the important parts
                const lines = deploy.split('\n').filter(l =>
                  l.includes('Replicas:') || l.includes('Image:') || l.includes('Available') || l.includes('Conditions:'),
                );
                console.log(lines.join('\n'));
              }
              break;
            }

            case 'deploy': {
              if (!deployment) { console.log(chalk.red('--deployment required')); return; }
              const image = options.image || 'latest';
              console.log(chalk.cyan(`Deploying ${deployment} with image tag: ${image}...`));

              // Check for k8s manifests
              const manifestPaths = ['k8s/', 'kubernetes/', 'deploy/', '.k8s/'];
              let manifestDir = '';
              for (const mp of manifestPaths) {
                if (fs.existsSync(path.join(process.cwd(), mp))) { manifestDir = mp; break; }
              }

              if (manifestDir) {
                execSync(`kubectl apply -f ${manifestDir} ${namespace}`, { stdio: 'inherit', timeout: 120_000 });
              }

              // Update image
              execSync(
                `kubectl set image deployment/${deployment} ${deployment}=${deployment}:${image} ${namespace}`,
                { stdio: 'inherit', timeout: 60_000 },
              );

              console.log(chalk.green(`\n✓ Deployment updated. Watching rollout...`));
              execSync(`kubectl rollout status deployment/${deployment} ${namespace} --timeout=300s`, { stdio: 'inherit' });
              break;
            }

            case 'rollback': {
              if (!deployment) { console.log(chalk.red('--deployment required')); return; }
              console.log(chalk.yellow(`Rolling back ${deployment}...`));
              execSync(`kubectl rollout undo deployment/${deployment} ${namespace}`, { stdio: 'inherit' });
              console.log(chalk.green(`✓ Rollback initiated`));
              break;
            }

            case 'logs': {
              if (!deployment) { console.log(chalk.red('--deployment required')); return; }
              execSync(`kubectl logs deployment/${deployment} ${namespace} --tail=100 -f`, { stdio: 'inherit' });
              break;
            }

            default:
              console.log(chalk.red(`Unknown action: ${action}. Use: deploy, rollback, status, logs`));
          }
        } catch (err: any) {
          console.log(chalk.red(`kubectl error: ${err.message?.substring(0, 200)}`));
          process.exitCode = 1;
        }
      },
    },
  ],
};

export default plugin;
