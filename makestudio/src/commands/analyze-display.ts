/**
 * `analyze` command — display module. Extracted from analyze.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import chalk from 'chalk';

const dim    = chalk.hex('#64748B');
const yellow = chalk.hex('#FBBF24');
const green  = chalk.hex('#22C55E');
const cyan   = chalk.hex('#22D3EE');
const red    = chalk.hex('#EF4444');
const blue   = chalk.hex('#60A5FA');
import { logInfo, logSuccess, logError, logWarning, logTool } from '../ui/terminal';


export function showAuditResults(audit: any): void {
  console.log();
  console.log(chalk.red.bold('  ─── AUDIT RESULTS ───'));
  console.log();

  // Score
  if (audit.score) {
    const overall = audit.score.overall || 0;
    const scoreColor = overall >= 8 ? chalk.green : overall >= 6 ? chalk.yellow : chalk.red;
    logSuccess(`Projeto: ${chalk.bold(audit.projectName || 'Unknown')}`);
    console.log();
    console.log(`  ${chalk.bold('Score Geral:')} ${scoreColor.bold(overall.toFixed(1) + '/10')}`);
    console.log();

    const categories = [
      { key: 'security', label: 'Segurança', icon: '🔒' },
      { key: 'codeQuality', label: 'Qualidade de Código', icon: '📝' },
      { key: 'testCoverage', label: 'Cobertura de Testes', icon: '🧪' },
      { key: 'architecture', label: 'Arquitetura', icon: '🏗️' },
      { key: 'performance', label: 'Performance', icon: '⚡' },
      { key: 'documentation', label: 'Documentação', icon: '📚' },
    ];

    for (const cat of categories) {
      const val = audit.score[cat.key] || 0;
      const color = val >= 8 ? chalk.green : val >= 6 ? chalk.yellow : val < 4 ? chalk.red.bold : chalk.red;
      const bar = '█'.repeat(Math.round(val)) + '░'.repeat(10 - Math.round(val));
      console.log(`  ${cat.icon} ${cat.label.padEnd(22)} ${color(bar)} ${color(val.toFixed(1))}`);
    }
  }

  // Stats
  if (audit.stats) {
    console.log();
    console.log(chalk.gray('  ─── Estatísticas ───'));
    const s = audit.stats;
    if (s.totalFiles) logInfo(`Arquivos: ${s.totalFiles}`);
    if (s.totalLines) logInfo(`Linhas de código: ~${s.totalLines.toLocaleString()}`);
    if (s.endpoints) logInfo(`Endpoints: ${s.endpoints}`);
    if (s.entities) logInfo(`Entities: ${s.entities}`);
    logInfo(`Arquivos de teste: ${s.testFiles || 0}`);
    logInfo(`Cobertura estimada: ${s.estimatedCoverage || 0}%`);
    if (s.todoCount) logWarning(`TODOs/FIXMEs encontrados: ${s.todoCount}`);
  }

  // Release Risk
  if (audit.releaseRisk) {
    const rr = audit.releaseRisk;
    const riskColor = rr.level === 'critical' ? chalk.red.bold :
      rr.level === 'high' ? chalk.red : rr.level === 'medium' ? chalk.yellow : chalk.green;
    console.log();
    console.log(chalk.gray('  ─── Risco de Release ───'));
    console.log();
    console.log(`  ${riskColor.bold(`⚠ RISCO: ${(rr.level || 'unknown').toUpperCase()}`)} ${rr.score ? chalk.gray(`(${rr.score}/10)`) : ''}`);
    if (rr.reasons?.length) {
      for (const reason of rr.reasons) {
        console.log(chalk.red(`    • ${reason}`));
      }
    }
    if (rr.recommendation) {
      console.log();
      console.log(chalk.yellow(`  → ${rr.recommendation}`));
    }

    // Auto-fix summary
    const autoFixable = (audit.findings || []).filter((f: any) => f.autoFix);
    const totalAutoFixTasks = autoFixable.reduce((sum: number, f: any) => sum + (f.autoFixTasks || 0), 0);
    if (autoFixable.length > 0) {
      console.log();
      console.log(`  ${chalk.green.bold('🤖 Auto-fix disponível:')} ${autoFixable.length}/${audit.findings?.length || 0} findings podem ser corrigidos automaticamente (~${totalAutoFixTasks} tasks)`);
    }
  }

  // Findings by severity
  if (audit.findings?.length) {
    console.log();
    console.log(chalk.gray('  ─── Problemas Encontrados ───'));
    console.log();

    const severityOrder = ['critical', 'high', 'medium', 'low', 'info'];
    const severityColors: Record<string, any> = {
      critical: chalk.red.bold,
      high: chalk.red,
      medium: chalk.yellow,
      low: chalk.gray,
      info: chalk.blue,
    };
    const severityIcons: Record<string, string> = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🔵',
      info: 'ℹ️',
    };

    const sorted = [...audit.findings].sort(
      (a: any, b: any) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity),
    );

    for (const f of sorted) {
      const color = severityColors[f.severity] || chalk.white;
      const icon = severityIcons[f.severity] || '•';
      // Header: severity + confidence + title
      const confStr = f.confidence ? chalk.gray(` (${Math.round(f.confidence * 100)}% certeza)`) : '';
      console.log(`  ${icon} ${color(f.severity.toUpperCase().padEnd(8))} ${chalk.bold(f.title)}${confStr}`);
      // Impact tags
      if (f.impact?.length) {
        const impactLabels: Record<string, string> = {
          security: '🔒 Segurança', revenue: '💰 Receita', performance: '⚡ Performance',
          maintainability: '🔧 Manutenção', ux: '🎨 UX', reliability: '🛡️ Confiabilidade',
        };
        const tags = f.impact.map((i: string) => impactLabels[i] || i).join('  ');
        console.log(chalk.gray(`    Impacto: ${tags}`));
      }
      console.log(chalk.gray(`    ${f.description}`));
      if (f.files?.length) {
        console.log(chalk.gray(`    Arquivos: ${f.files.slice(0, 3).join(', ')}${f.files.length > 3 ? ` +${f.files.length - 3}` : ''}`));
      }
      console.log(chalk.cyan(`    Sugestão: ${f.suggestion}`));
      // Auto-fix indicator
      if (f.autoFix) {
        console.log(chalk.green(`    🤖 Auto-fix: sim (~${f.autoFixTasks || '?'} tasks)`));
      }
      console.log();
    }

    // Count by severity
    const counts: Record<string, number> = {};
    for (const f of audit.findings) {
      counts[f.severity] = (counts[f.severity] || 0) + 1;
    }
    const summary = Object.entries(counts)
      .sort(([a], [b]) => severityOrder.indexOf(a) - severityOrder.indexOf(b))
      .map(([sev, count]) => `${(severityColors[sev] || chalk.white)(count + ' ' + sev)}`)
      .join(', ');
    logInfo(`Total: ${audit.findings.length} findings (${summary})`);
  }

  // Backlog
  if (audit.backlog?.length) {
    console.log();
    console.log(chalk.gray('  ─── Backlog Técnico ───'));
    console.log();
    for (let i = 0; i < audit.backlog.length; i++) {
      const item = audit.backlog[i];
      const priorityColor = item.priority === 'critical' ? chalk.red.bold :
        item.priority === 'high' ? chalk.red : chalk.yellow;
      const fixBadge = item.autoFix ? chalk.green(' 🤖') : '';
      console.log(`  ${chalk.bold(`${i + 1}.`)} ${priorityColor(`[${item.priority}]`)} ${chalk.bold(item.title)}${fixBadge}`);
      console.log(chalk.gray(`     ${item.description.substring(0, 120)}${item.description.length > 120 ? '...' : ''}`));
      if (item.estimatedTasks) console.log(chalk.gray(`     ~${item.estimatedTasks} tasks${item.autoFix ? ' (auto-fix)' : ''}`));
    }
  }

  // Roadmap
  if (audit.roadmap?.length) {
    console.log();
    console.log(chalk.gray('  ─── Roadmap Sugerido ───'));
    console.log();
    for (const phase of audit.roadmap) {
      const priorityColor = phase.priority === 'critical' ? chalk.red :
        phase.priority === 'high' ? chalk.yellow : chalk.cyan;
      console.log(`  ${chalk.bold(`Fase ${phase.phase}:`)} ${chalk.bold(phase.title)} ${priorityColor(`[${phase.priority}]`)}`);
      for (const item of phase.items || []) {
        console.log(chalk.gray(`    • ${item}`));
      }
    }
  }

  // Best Practices
  if (audit.bestPractices) {
    console.log();
    console.log(chalk.gray('  ─── Boas Práticas ───'));
    console.log();
    for (const [key, val] of Object.entries(audit.bestPractices) as [string, any][]) {
      const icon = val.status === 'pass' ? chalk.green('✓') :
        val.status === 'warn' ? chalk.yellow('⚠') : chalk.red('✗');
      const name = key.replace(/([A-Z])/g, ' $1').replace(/^./, (s: string) => s.toUpperCase());
      console.log(`  ${icon} ${name.padEnd(22)} ${chalk.gray(val.details || '')}`);
    }
  }

  console.log();
}
