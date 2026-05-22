import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { logInfo, logSuccess, logError } from '../ui/terminal';
import chalk from 'chalk';
import { DUM_VIEWER_CSS } from './dum-view-css';
import { dumViewerScript } from './dum-view-script';

import { swallow } from '../utils/log';
export async function dumViewCommand(
  files: string[],
  options: { output?: string; noOpen?: boolean },
): Promise<void> {
  // ── Collect & parse DUM files ───────────────────────────────────
  const dums: any[] = [];
  let failed = 0;

  let normalized = 0;
  for (const file of files) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) {
      logError(`Arquivo não encontrado: ${resolved}`);
      failed++;
      continue;
    }
    try {
      const raw = fs.readFileSync(resolved, 'utf8').trim();
      const parsed = JSON.parse(raw);

      // Normalize legacy Codex format: `id` → `tempId`
      // Also derive tempId from filename if both are missing (dum_NNN.json → dum_NNN)
      let needsRewrite = false;
      if (!parsed.tempId) {
        if (parsed.id) {
          parsed.tempId = parsed.id;
          delete parsed.id;
          needsRewrite = true;
        } else {
          const fnMatch = path.basename(resolved).match(/^(dum_\d+)\.json$/);
          if (fnMatch) {
            parsed.tempId = fnMatch[1];
            needsRewrite = true;
          }
        }
      }
      // Persist normalization back to disk so next read is already correct
      if (needsRewrite) {
        try {
          fs.writeFileSync(resolved, JSON.stringify(parsed, null, 2), 'utf8');
          normalized++;
        } catch (err) { swallow(err); }
      }

      dums.push({ ...parsed, _sourceFile: resolved });
    } catch (err: any) {
      logError(`Falha ao parsear ${path.basename(resolved)}: ${err.message}`);
      failed++;
    }
  }

  if (normalized > 0) {
    logInfo(chalk.dim(`Normalizados ${normalized} DUMs (id → tempId)`));
  }

  if (dums.length === 0) {
    logError('Nenhum DUM válido encontrado.');
    return;
  }

  // Sort by DUM number
  dums.sort((a, b) => {
    const na = parseInt((a.tempId || '').replace(/[^0-9]/g, ''), 10) || 0;
    const nb = parseInt((b.tempId || '').replace(/[^0-9]/g, ''), 10) || 0;
    return na - nb;
  });

  logInfo(`Carregados ${dums.length} DUMs${failed > 0 ? `, ${failed} com erro` : ''}`);

  // ── Generate HTML ───────────────────────────────────────────────
  const projectTitle = dums.find(d => d.level === 1)?.title || dums[0]?.title || 'Projeto';
  const totalTasks = dums.reduce((s: number, d: any) => s + (d.tasks?.length || 0), 0);
  const html = buildHtml(dums, projectTitle, totalTasks);

  // ── Write file ──────────────────────────────────────────────────
  const outputPath = options.output
    ? path.resolve(options.output)
    : path.join(os.tmpdir(), `makestudio-dums-${Date.now()}.html`);

  fs.writeFileSync(outputPath, html, 'utf8');
  logSuccess(`Documento gerado: ${outputPath}`);

  if (!options.noOpen) {
    // Try platform-appropriate openers in priority order. macOS: `open`;
    // Linux: `xdg-open`; WSL: `wslview` (or `explorer.exe` fallback);
    // Windows native: `start`. Fall through to manual hint if all fail.
    const isWsl = !!process.env.WSL_DISTRO_NAME || /microsoft/i.test(os.release?.() || '');
    const candidates: string[] = [];
    if (process.platform === 'darwin') {
      candidates.push(`open "${outputPath}"`);
    } else if (process.platform === 'win32') {
      candidates.push(`start "" "${outputPath}"`);
    } else if (isWsl) {
      candidates.push(`wslview "${outputPath}"`);
      candidates.push(`explorer.exe "${outputPath.replace(/\//g, '\\')}"`);
      candidates.push(`xdg-open "${outputPath}"`);
    } else {
      candidates.push(`xdg-open "${outputPath}"`);
      candidates.push(`open "${outputPath}"`);
    }
    let opened = false;
    for (const cmd of candidates) {
      try {
        execSync(cmd, { stdio: 'ignore' });
        opened = true;
        break;
      } catch (err) { swallow(err); }
    }
    if (!opened) {
      logInfo(chalk.dim(`Abra manualmente: ${outputPath}`));
    }
  }
}

// ── HTML Builder ─────────────────────────────────────────────────

function dumNumber(tempIdOrId: string): string {
  const raw = tempIdOrId || '';
  const n = parseInt(raw.replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? '???' : `DUM-${String(n).padStart(3, '0')}`;
}

const TYPE_COLORS: Record<string, string> = {
  contracts:   '#A78BFA',
  backend:     '#38BDF8',
  visual:      '#F472B6',
  database:    '#4ADE80',
  infra:       '#FB923C',
  integration: '#FBBF24',
  flow:        '#34D399',
  frontend:    '#818CF8',
  mixed:       '#94A3B8',
};

const TYPE_LABELS: Record<string, string> = {
  contracts:   'Contratos',
  backend:     'Backend',
  visual:      'Visual / Mobile',
  database:    'Database',
  infra:       'Infraestrutura',
  integration: 'Integração',
  flow:        'Flow',
  frontend:    'Frontend',
  mixed:       'Master',
};

const LAYER_COLORS: Record<string, string> = {
  backend:  '#38BDF8',
  frontend: '#818CF8',
  mobile:   '#F472B6',
  database: '#4ADE80',
  infra:    '#FB923C',
};

const COMPLEXITY_COLORS: Record<string, string> = {
  low:    '#22C55E',
  medium: '#F59E0B',
  high:   '#EF4444',
};

function typeColor(type: string): string {
  return TYPE_COLORS[type?.toLowerCase()] ?? '#94A3B8';
}

function typeLabel(type: string): string {
  return TYPE_LABELS[type?.toLowerCase()] ?? (type || 'Unknown');
}

/**
 * Quality scoring kept in sync with backend's DumQualityService.
 * Replaced 2026-04-27: removed the 1500-char threshold (filler bias) and
 * 5-AC minimum (rigid bar). Now scores by structure-section presence +
 * substantive task content + AC count ≥2 — same shape as the backend
 * validator so DUMs that PASS in the pipeline don't FAIL in the viewer.
 *
 * Sections recognized in PT-BR + EN to match real LLM output language.
 */
const REQUIRED_SECTION_PATTERNS: RegExp[] = [
  /^##\s*(Scope|Escopo|Alcance)\b/im,
  /^##\s*(Technical\s*Context|Contexto\s*T[eé]cnico|Contexto)\b/im,
  /^##\s*(Files|Arquivos)\b/im,
  /^##\s*(Business\s*Rules?|Regras\s*de\s*Neg[oó]cio|Regras)\b/im,
  /^##\s*(Dependencies|Depend[eê]ncias)\b/im,
  /^##\s*(Expected\s*Result|Resultado\s*Esperado)\b/im,
];

// Master DUM (level=1) has a different contract: documents stack/conventions
// every other DUM relies on. Mirrors backend's MASTER_DUM_REQUIRED_SECTIONS.
const MASTER_SECTION_PATTERNS: RegExp[] = [
  /^##\s*(Boilerplate)\b/im,
  /^##\s*(Stack)\b/im,
  /^##\s*(Database|Banco\s*de\s*Dados)\b/im,
  /^##\s*(Authentication|Autentica[çc][aã]o|Auth)\b/im,
  /^##\s*(Testing|Testes)\b/im,
  /^##\s*(Code\s*Conventions|Conven[çc][oõ]es\s*de\s*C[oó]digo|Conventions)\b/im,
];

function qualityScore(dum: any): { descScore: number; taskScore: number; acScore: number } {
  const MIN_TASK_DESC = 200;
  const MIN_AC = 2;
  const desc = dum.description || '';
  const tasks: any[] = dum.tasks || [];
  const isMaster = dum.level === 1;
  const sectionPatterns = isMaster ? MASTER_SECTION_PATTERNS : REQUIRED_SECTION_PATTERNS;
  // Description score: fraction of required sections present (0-1).
  const present = sectionPatterns.filter(p => p.test(desc)).length;
  const descScore = sectionPatterns.length > 0
    ? present / sectionPatterns.length
    : 0;
  const taskScores = tasks.map((t: any) => {
    const tDescLen = (t.description || '').length;
    const acCount = (t.acceptanceCriteria || []).length;
    return {
      desc: Math.min(tDescLen / MIN_TASK_DESC, 1),
      ac: Math.min(acCount / MIN_AC, 1),
    };
  });
  return {
    descScore,
    taskScore: tasks.length === 0 ? (isMaster ? 1 : 0) : taskScores.reduce((s, t) => s + t.desc, 0) / tasks.length,
    acScore: tasks.length === 0 ? (isMaster ? 1 : 0) : taskScores.reduce((s, t) => s + t.ac, 0) / tasks.length,
  };
}

function scoreColor(score: number): string {
  if (score >= 0.9) return '#22C55E';
  if (score >= 0.7) return '#F59E0B';
  return '#EF4444';
}

function buildHtml(dums: any[], projectTitle: string, totalTasks: number): string {
  const generatedAt = new Date().toLocaleString('pt-BR');
  // Escape `<` so a literal `</script>` inside any DUM field can't close
  // the script tag and inject HTML/JS. Also escape U+2028/U+2029 which are
  // valid in JSON but break JS string literals.
  const dumsJson = JSON.stringify(dums)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(new RegExp('\\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\\u2029', 'g'), '\\u2029');

  // Sidebar DUM list
  const sidebarItems = dums.map((d, i) => {
    const num = dumNumber(d.tempId);
    const tc = typeColor(d.type);
    const qs = qualityScore(d);
    const overallScore = (qs.descScore + qs.taskScore + qs.acScore) / 3;
    const scoreC = scoreColor(overallScore);
    const taskCount = (d.tasks || []).length;
    return `
      <button class="dum-nav-item" data-index="${i}" onclick="selectDum(${i})" id="nav-${i}">
        <div class="nav-badge" style="background:${tc}22;color:${tc};border-color:${tc}44">${num}</div>
        <div class="nav-body">
          <div class="nav-title">${escHtml(d.title || 'Sem título')}</div>
          <div class="nav-meta">
            <span class="nav-type" style="color:${tc}">${typeLabel(d.type)}</span>
            ${taskCount > 0 ? `<span class="nav-count">${taskCount} tasks</span>` : ''}
          </div>
          <div class="nav-quality">
            <div class="quality-bar-track">
              <div class="quality-bar-fill" style="width:${Math.round(overallScore * 100)}%;background:${scoreC}"></div>
            </div>
            <span class="quality-pct" style="color:${scoreC}">${Math.round(overallScore * 100)}%</span>
          </div>
        </div>
      </button>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MakeStudio — DUM Viewer · ${escHtml(projectTitle)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>${DUM_VIEWER_CSS}</style>
</head>
<body>

<!-- HEADER -->
<header class="header">
  <div class="logo">
    <svg class="logo-mark" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="8" fill="url(#logoGrad)"/>
      <path d="M7 22V10l5.5 7 3.5-4.5 3.5 4.5L25 10v12" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="7" cy="22" r="1.5" fill="white"/>
      <circle cx="25" cy="22" r="1.5" fill="white"/>
      <defs>
        <linearGradient id="logoGrad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="#7C3AED"/>
          <stop offset="100%" stop-color="#06B6D4"/>
        </linearGradient>
      </defs>
    </svg>
    <span class="logo-wordmark">MakeStudio</span>
  </div>
  <div class="header-divider"></div>
  <span class="header-pill">DUM Viewer</span>
  <span class="header-project" title="${escHtml(projectTitle)}">${escHtml(projectTitle)}</span>
  <div class="header-spacer"></div>
  <div class="header-stats">
    <div class="header-stat">
      <span class="header-stat-value">${dums.length}</span>
      <span class="header-stat-label">DUMs</span>
    </div>
    <div class="header-divider"></div>
    <div class="header-stat">
      <span class="header-stat-value">${totalTasks}</span>
      <span class="header-stat-label">Tasks</span>
    </div>
    <div class="header-divider"></div>
    <span class="header-meta">${escHtml(generatedAt)}</span>
  </div>
</header>

<!-- LAYOUT -->
<div class="layout">

  <!-- SIDEBAR -->
  <aside class="sidebar">
    <div class="sidebar-search">
      <input class="search-input" type="text" placeholder="Buscar DUMs..." oninput="filterDums(this.value)" id="searchInput">
    </div>
    <div class="sidebar-list" id="sidebarList">
      ${sidebarItems}
    </div>
  </aside>

  <!-- MAIN -->
  <main class="main" id="mainContent">
    <div class="main-inner" id="mainInner">
      <div class="empty-state">
        <div class="empty-state-icon">📄</div>
        <div class="empty-state-text">Selecione um DUM na barra lateral</div>
      </div>
    </div>
  </main>

</div>

<script>${dumViewerScript({ dumsJson, typeColors: TYPE_COLORS, typeLabels: TYPE_LABELS, layerColors: LAYER_COLORS, complexityColors: COMPLEXITY_COLORS })}</script>
</body>
</html>`;
}

// ── HTML escape ─────────────────────────────────────────────────

function escHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
