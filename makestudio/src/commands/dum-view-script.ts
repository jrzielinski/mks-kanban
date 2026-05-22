/**
 * DUM Viewer client-side JS — extracted from dum-view.ts:buildHtml.
 * The 5 placeholders (__DUMS_JSON__, __TYPE_COLORS__, __TYPE_LABELS__,
 * __LAYER_COLORS__, __COMPLEXITY_COLORS__) get substituted with the
 * server-side computed JSON before being injected into <script>.
 */
export function dumViewerScript(args: {
  dumsJson: string;
  typeColors: any;
  typeLabels: any;
  layerColors: any;
  complexityColors: any;
}): string {
  return `mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    primaryColor: '#1E2A3A',
    primaryTextColor: '#E2E8F0',
    primaryBorderColor: '#2D3F54',
    lineColor: '#38BDF8',
    secondaryColor: '#111827',
    tertiaryColor: '#0C1017',
    background: '#07090D',
    mainBkg: '#111827',
    nodeBorder: '#2D3F54',
    clusterBkg: '#0C1017',
    titleColor: '#E2E8F0',
    edgeLabelBackground: '#111827',
    fontFamily: 'IBM Plex Mono, monospace',
    fontSize: '15px',
    nodeTextColor: '#E2E8F0',
    labelTextColor: '#CBD5E1',
  },
  flowchart: { curve: 'basis', htmlLabels: true, useMaxWidth: true, padding: 20 },
  er: { useMaxWidth: true, fontSize: 14 },
  sequence: { useMaxWidth: true, fontSize: 14 },
});

const DUMS = __DUMS_JSON__;

const TYPE_COLORS = __TYPE_COLORS__;
const TYPE_LABELS = __TYPE_LABELS__;
const LAYER_COLORS = __LAYER_COLORS__;
const COMPLEXITY_COLORS = __COMPLEXITY_COLORS__;

let currentIndex = -1;

function typeColor(type) { return TYPE_COLORS[type?.toLowerCase()] || '#94A3B8'; }
function typeLabel(type) { return TYPE_LABELS[type?.toLowerCase()] || (type || 'Unknown'); }
function layerColor(layer) { return LAYER_COLORS[layer?.toLowerCase()] || '#64748B'; }
function complexityColor(c) { return COMPLEXITY_COLORS[c?.toLowerCase()] || '#64748B'; }

function dumNumber(tempId) {
  const n = parseInt((tempId || '').replace(/[^0-9]/g, ''), 10);
  return isNaN(n) ? '???' : 'DUM-' + String(n).padStart(3, '0');
}

// Browser-side qualityScore — must match the TS-side function above.
// Sections detected in PT-BR + EN to handle real LLM output.
const REQUIRED_PATTERNS = [
  /^##\\s*(Scope|Escopo|Alcance)\\b/im,
  /^##\\s*(Technical\\s*Context|Contexto\\s*T[eé]cnico|Contexto)\\b/im,
  /^##\\s*(Files|Arquivos)\\b/im,
  /^##\\s*(Business\\s*Rules?|Regras\\s*de\\s*Neg[oó]cio|Regras)\\b/im,
  /^##\\s*(Dependencies|Depend[eê]ncias)\\b/im,
  /^##\\s*(Expected\\s*Result|Resultado\\s*Esperado)\\b/im,
];
const MASTER_PATTERNS = [
  /^##\\s*(Boilerplate)\\b/im,
  /^##\\s*(Stack)\\b/im,
  /^##\\s*(Database|Banco\\s*de\\s*Dados)\\b/im,
  /^##\\s*(Authentication|Autentica[çc][aã]o|Auth)\\b/im,
  /^##\\s*(Testing|Testes)\\b/im,
  /^##\\s*(Code\\s*Conventions|Conven[çc][oõ]es\\s*de\\s*C[oó]digo|Conventions)\\b/im,
];
function qualityScore(dum) {
  const MIN_TASK_DESC = 200, MIN_AC = 2;
  const desc = dum.description || '';
  const tasks = dum.tasks || [];
  const isMaster = dum.level === 1;
  const patterns = isMaster ? MASTER_PATTERNS : REQUIRED_PATTERNS;
  const present = patterns.filter(p => p.test(desc)).length;
  const descScore = present / patterns.length;
  const taskScores = tasks.map(t => ({
    desc: Math.min((t.description || '').length / MIN_TASK_DESC, 1),
    ac: Math.min((t.acceptanceCriteria || []).length / MIN_AC, 1),
  }));
  return {
    descScore,
    taskScore: tasks.length === 0 ? (isMaster ? 1 : 0) : taskScores.reduce((s,t) => s + t.desc, 0) / tasks.length,
    acScore: tasks.length === 0 ? (isMaster ? 1 : 0) : taskScores.reduce((s,t) => s + t.ac, 0) / tasks.length,
  };
}

function scoreColor(s) {
  if (s >= 0.9) return '#22C55E';
  if (s >= 0.7) return '#F59E0B';
  return '#EF4444';
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function md(text) {
  if (!text) return '';
  try { return marked.parse(String(text)); } catch { return esc(text); }
}

function selectDum(index) {
  if (index < 0 || index >= DUMS.length) return;
  currentIndex = index;

  // Update sidebar active state
  document.querySelectorAll('.dum-nav-item').forEach((el, i) => {
    el.classList.toggle('active', i === index);
  });

  // Scroll nav item into view
  const navItem = document.getElementById('nav-' + index);
  if (navItem) navItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  // Render DUM
  renderDum(DUMS[index]);

  // Update URL hash
  history.replaceState(null, '', '#' + (DUMS[index].tempId || index));
}

function selectDumById(tempId) {
  const idx = DUMS.findIndex(d => d.tempId === tempId);
  if (idx >= 0) selectDum(idx);
}

function renderDum(dum) {
  const tc = typeColor(dum.type);
  const num = dumNumber(dum.tempId);
  const tasks = dum.tasks || [];
  const qs = qualityScore(dum);
  const descLen = (dum.description || '').length;

  // Quality cards
  const qCards = [
    { label: 'Descrição', score: qs.descScore, val: descLen + ' chars', sub: 'mín 1500' },
    { label: 'Qualidade Tasks', score: qs.taskScore, val: Math.round(qs.taskScore * 100) + '%', sub: tasks.length + ' tasks' },
    { label: 'Critérios AC', score: qs.acScore, val: Math.round(qs.acScore * 100) + '%', sub: 'mín 5 por task' },
  ].map(q => {
    const sc = scoreColor(q.score);
    return \`<div class="quality-card">
      <div class="quality-card-label">\${q.label}</div>
      <div class="quality-card-bar">
        <div class="quality-card-fill" style="width:\${Math.round(q.score*100)}%;background:\${sc}"></div>
      </div>
      <div class="quality-card-bottom">
        <span class="quality-card-val" style="color:\${sc}">\${q.val}</span>
        <span class="quality-card-sub">\${q.sub}</span>
      </div>
    </div>\`;
  }).join('');

  // Dependencies
  const deps = (dum.dependsOn || []);
  const depsHtml = deps.length === 0
    ? '<span style="color:var(--text3);font-size:13px">Nenhuma dependência</span>'
    : deps.map(depId => {
        const depDum = DUMS.find(d => d.tempId === depId);
        const depNum = dumNumber(depId);
        const depTc = typeColor(depDum?.type);
        return \`<button class="dep-chip" onclick="selectDumById('\${esc(depId)}')" title="\${esc(depDum?.title || depId)}">
          <span class="dep-dot" style="background:\${depTc}"></span>
          <span style="color:\${depTc}">\${depNum}</span>
          <span style="color:var(--text2);font-size:11px">\${esc((depDum?.title || depId).substring(0, 28))}\${(depDum?.title || '').length > 28 ? '…' : ''}</span>
        </button>\`;
      }).join('');

  // Tasks
  const tasksHtml = tasks.length === 0
    ? \`<div class="empty-state" style="padding:30px">
        <div class="empty-state-icon">📋</div>
        <div class="empty-state-text">\${dum.level === 1 ? 'DUM Master — sem tasks (visão geral)' : 'Nenhuma task'}</div>
      </div>\`
    : tasks.map((t, ti) => {
        const lc = layerColor(t.layer);
        const cc = complexityColor(t.complexity);
        const acItems = (t.acceptanceCriteria || []).map(ac =>
          \`<div class="ac-item">\${esc(ac)}</div>\`
        ).join('');
        return \`<div class="task-card" id="task-\${ti}">
          <div class="task-header" onclick="toggleTask(\${ti})">
            <div class="task-num">\${ti + 1}</div>
            <div class="task-title">\${esc(t.title || 'Sem título')}</div>
            <div class="task-badges">
              \${t.type ? \`<span class="badge" style="color:var(--text2);border-color:var(--border2);background:var(--surface3)">\${esc(t.type)}</span>\` : ''}
              \${t.layer ? \`<span class="badge" style="color:\${lc};border-color:\${lc}44;background:\${lc}11">\${esc(t.layer)}</span>\` : ''}
              \${t.complexity ? \`<span class="badge" style="color:\${cc};border-color:\${cc}44;background:\${cc}11">\${esc(t.complexity)}</span>\` : ''}
            </div>
            <span class="task-chevron">›</span>
          </div>
          <div class="task-body">
            \${t.techContext ? \`<div class="task-tech">
              <div class="task-tech-label">⚙ Tech Context</div>
              \${esc(t.techContext)}
            </div>\` : ''}
            \${t.description ? \`<div class="task-desc">\${md(t.description)}</div>\` : ''}
            \${acItems ? \`<div class="ac-list">
              <div class="ac-header">Critérios de Aceitação (\${(t.acceptanceCriteria || []).length})</div>
              \${acItems}
            </div>\` : ''}
          </div>
        </div>\`;
      }).join('');

  // Mermaid
  const mermaidHtml = dum.mermaidDiagram
    ? \`<div class="section">
        <div class="section-header">
          <div class="section-icon">🔀</div>
          <span class="section-title">Diagrama</span>
          <button class="maximize-btn" onclick="openDiagramFullscreen()" title="Abrir em tela cheia">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
              <path d="M1 6V1h5M10 1h5v5M15 10v5h-5M6 15H1v-5"/>
            </svg>
          </button>
        </div>
        <div class="section-divider"></div>
        <div class="mermaid-wrapper" onclick="openDiagramFullscreen()" title="Clique para ampliar">
          <div class="mermaid" id="mermaid-\${esc(dum.tempId)}">\${esc(dum.mermaidDiagram)}</div>
        </div>
      </div>\`
    : '';

  // Lightbox HTML (rendered once, updated each DUM change)
  const lightboxHtml = dum.mermaidDiagram
    ? \`<div class="diagram-lightbox" id="diagramLightbox" onclick="closeDiagramFullscreen(event)">
        <div class="diagram-lightbox-card" onclick="event.stopPropagation()">
          <div class="diagram-lightbox-header">
            <div class="diagram-lightbox-title">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M1 6V1h5M10 1h5v5M15 10v5h-5M6 15H1v-5"/></svg>
              \${esc(dum.title || 'Diagrama')}
            </div>
            <div class="diagram-lightbox-toolbar">
              <button class="zoom-btn" onclick="zoomDiagram(-0.2)" title="Reduzir (-)">−</button>
              <span class="zoom-level" id="zoomLevelLabel">100%</span>
              <button class="zoom-btn" onclick="zoomDiagram(0.2)" title="Ampliar (+)">+</button>
              <button class="zoom-btn" onclick="zoomDiagramFit()" title="Ajustar à tela">⊡</button>
              <button class="zoom-btn" onclick="zoomDiagramReset()" title="100%">1:1</button>
              <button class="diagram-lightbox-close" onclick="closeDiagramFullscreen()" title="Fechar (Esc)">×</button>
            </div>
          </div>
          <div class="diagram-lightbox-body" id="diagramLightboxBody">
            <div class="diagram-canvas" id="diagramCanvas">
              <div class="mermaid" id="mermaid-fullscreen-\${esc(dum.tempId)}">\${esc(dum.mermaidDiagram)}</div>
            </div>
          </div>
        </div>
      </div>\`
    : '';

  // Build dep link chips for stat row (deps is array of string IDs)
  const depLinkChips = deps.map(depId => {
    const depDum = DUMS.find(d => d.tempId === depId);
    const depIdx = DUMS.findIndex(d => d.tempId === depId);
    const depNum = dumNumber(depId);
    const depTc = typeColor(depDum?.type);
    const depTitle = esc(depDum?.title || depId);
    return \`<span class="dep-link-chip" onclick="selectDum(\${depIdx})" title="\${depTitle}">\${depNum}</span>\`;
  }).join('');

  const html = \`
    <div class="dum-hero">
      <div class="dum-hero-top">
        <div class="dum-number-big" style="color:\${tc};border-color:\${tc}44;background:\${tc}11">\${num}</div>
        <div class="dum-type-chip" style="color:\${tc};border-color:\${tc}44;background:\${tc}0D">
          \${typeLabel(dum.type)}
        </div>
      </div>
      <div class="dum-title">\${esc(dum.title || 'Sem título')}</div>
      <div class="dum-stats-row">
        <span class="stat-chip">
          <span class="stat-chip-icon">📋</span>
          <span class="stat-chip-val">\${tasks.length}</span>
          <span class="stat-chip-label">tasks</span>
        </span>
        \${deps.length > 0 ? \`<span class="stat-sep"></span>\${depLinkChips}<span class="stat-sep"></span>\` : ''}
        <span class="stat-chip">
          <span class="stat-chip-icon">📌</span>
          <span class="stat-chip-val">\${(dum.requirementIds || []).length}</span>
          <span class="stat-chip-label">requisitos</span>
        </span>
        <span class="stat-chip">
          <span class="stat-chip-icon">✏️</span>
          <span class="stat-chip-val">\${descLen.toLocaleString()}</span>
          <span class="stat-chip-label">chars desc</span>
        </span>
      </div>
    </div>

    <div class="quality-panel">\${qCards}</div>

    <div class="section">
      <div class="section-header">
        <div class="section-icon">📝</div>
        <span class="section-title">Descrição</span>
      </div>
      <div class="section-divider"></div>
      <div class="description-box">\${md(dum.description)}</div>
    </div>

    \${mermaidHtml}

    <div class="section">
      <div class="section-header">
        <div class="section-icon">🔗</div>
        <span class="section-title">Dependências</span>
        \${deps.length > 0 ? \`<span class="section-count">\${deps.length}</span>\` : ''}
      </div>
      <div class="section-divider"></div>
      <div class="deps-grid">\${depsHtml}</div>
    </div>

    <div class="section">
      <div class="section-header">
        <div class="section-icon">⚙️</div>
        <span class="section-title">Tasks</span>
        \${tasks.length > 0 ? \`<span class="section-count">\${tasks.length}</span>\` : ''}
      </div>
      <div class="section-divider"></div>
      <div class="tasks-list">\${tasksHtml}</div>
    </div>
  \`;

  const container = document.getElementById('mainInner');
  container.innerHTML = html + lightboxHtml;
  container.style.animation = 'none';
  container.offsetHeight; // reflow
  container.style.animation = '';

  // Render inline mermaid
  if (dum.mermaidDiagram) {
    setTimeout(() => {
      const node = document.getElementById('mermaid-' + dum.tempId);
      if (!node) return;
      mermaid.run({ nodes: [node] }).then(() => {
        const svg = node.querySelector('svg');
        if (svg) {
          svg.style.width = '100%';
          svg.style.maxWidth = '100%';
          svg.style.height = 'auto';
          svg.removeAttribute('height');
          if (!svg.getAttribute('viewBox') && svg.getAttribute('width') && svg.getAttribute('height')) {
            svg.setAttribute('viewBox', \`0 0 \${svg.getAttribute('width')} \${svg.getAttribute('height')}\`);
          }
        }
      }).catch(() => {});
    }, 80);
  }

  // Scroll main to top
  document.getElementById('mainContent').scrollTo({ top: 0, behavior: 'instant' });
}

// ── Diagram lightbox zoom/pan state ───────────────────────────────
let _diagScale = 1;
let _diagX = 0, _diagY = 0;
let _dragActive = false, _dragStartX = 0, _dragStartY = 0, _dragOriginX = 0, _dragOriginY = 0;

function _applyDiagTransform() {
  const canvas = document.getElementById('diagramCanvas');
  const label = document.getElementById('zoomLevelLabel');
  if (canvas) canvas.style.transform = \`translate(\${_diagX}px, \${_diagY}px) scale(\${_diagScale})\`;
  if (label) label.textContent = Math.round(_diagScale * 100) + '%';
}

function zoomDiagram(delta) {
  _diagScale = Math.min(5, Math.max(0.1, _diagScale + delta));
  _applyDiagTransform();
}

function zoomDiagramFit() {
  const body = document.getElementById('diagramLightboxBody');
  const canvas = document.getElementById('diagramCanvas');
  if (!body || !canvas) return;
  const svgEl = canvas.querySelector('svg');
  if (!svgEl) return;
  const bw = body.clientWidth - 80, bh = body.clientHeight - 80;
  const sw = svgEl.getBoundingClientRect().width / _diagScale;
  const sh = svgEl.getBoundingClientRect().height / _diagScale;
  _diagScale = Math.min(bw / sw, bh / sh, 3);
  _diagX = (body.clientWidth - sw * _diagScale) / 2;
  _diagY = (body.clientHeight - sh * _diagScale) / 2;
  _applyDiagTransform();
}

function zoomDiagramReset() {
  _diagScale = 1;
  const body = document.getElementById('diagramLightboxBody');
  const canvas = document.getElementById('diagramCanvas');
  if (body && canvas) {
    const svgEl = canvas.querySelector('svg');
    if (svgEl) {
      const sw = parseFloat(svgEl.getAttribute('width') || '400');
      const sh = parseFloat(svgEl.getAttribute('height') || '300');
      _diagX = (body.clientWidth - sw) / 2;
      _diagY = (body.clientHeight - sh) / 2;
    } else {
      _diagX = 40; _diagY = 40;
    }
  }
  _applyDiagTransform();
}

function _setupDiagPanZoom() {
  const body = document.getElementById('diagramLightboxBody');
  if (!body || body._panSetup) return;
  body._panSetup = true;

  // Wheel zoom
  body.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = body.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const delta = e.deltaY < 0 ? 0.15 : -0.15;
    const newScale = Math.min(5, Math.max(0.1, _diagScale + delta));
    // Zoom towards cursor
    _diagX = mx - (mx - _diagX) * (newScale / _diagScale);
    _diagY = my - (my - _diagY) * (newScale / _diagScale);
    _diagScale = newScale;
    _applyDiagTransform();
  }, { passive: false });

  // Drag pan
  body.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    _dragActive = true;
    _dragStartX = e.clientX; _dragStartY = e.clientY;
    _dragOriginX = _diagX; _dragOriginY = _diagY;
    body.classList.add('dragging');
  });
  document.addEventListener('mousemove', (e) => {
    if (!_dragActive) return;
    _diagX = _dragOriginX + (e.clientX - _dragStartX);
    _diagY = _dragOriginY + (e.clientY - _dragStartY);
    _applyDiagTransform();
  });
  document.addEventListener('mouseup', () => {
    _dragActive = false;
    document.getElementById('diagramLightboxBody')?.classList.remove('dragging');
  });

  // Keyboard zoom
  document.addEventListener('keydown', (ev) => {
    const lb = document.getElementById('diagramLightbox');
    if (!lb?.classList.contains('open')) return;
    if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoomDiagram(0.2); }
    if (ev.key === '-') { ev.preventDefault(); zoomDiagram(-0.2); }
    if (ev.key === '0') { ev.preventDefault(); zoomDiagramFit(); }
  });
}

function openDiagramFullscreen() {
  const lb = document.getElementById('diagramLightbox');
  if (!lb) return;
  lb.classList.add('open');
  document.body.style.overflow = 'hidden';
  _setupDiagPanZoom();

  // Render fullscreen mermaid if not yet rendered
  const dum = DUMS[currentIndex];
  if (!dum?.mermaidDiagram) return;
  const fsId = 'mermaid-fullscreen-' + dum.tempId;
  const fsNode = document.getElementById(fsId);
  if (!fsNode) return;

  const alreadyRendered = !!fsNode.querySelector('svg');
  if (alreadyRendered) { setTimeout(zoomDiagramFit, 60); return; }

  setTimeout(() => {
    mermaid.run({ nodes: [fsNode] }).then(() => {
      const svg = fsNode.querySelector('svg');
      if (svg) {
        // Keep natural SVG dimensions — do NOT force 100% width here
        svg.style.maxWidth = 'none';
        svg.style.height = 'auto';
        svg.removeAttribute('height');
        if (!svg.getAttribute('viewBox')) {
          const w = svg.getAttribute('width'), h = svg.getAttribute('height');
          if (w && h) svg.setAttribute('viewBox', \`0 0 \${w} \${h}\`);
        }
      }
      // Auto-fit on first open
      setTimeout(zoomDiagramFit, 80);
    }).catch(() => {});
  }, 80);
}

function closeDiagramFullscreen(e) {
  if (e && e.target !== document.getElementById('diagramLightbox')) return;
  const lb = document.getElementById('diagramLightbox');
  if (lb) lb.classList.remove('open');
  document.body.style.overflow = '';
}

// Keyboard: lightbox close + DUM navigation
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const lb = document.getElementById('diagramLightbox');
    if (lb?.classList.contains('open')) {
      lb.classList.remove('open');
      document.body.style.overflow = '';
      return;
    }
    document.getElementById('searchInput')?.blur();
    return;
  }
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault(); selectDum(Math.min(currentIndex + 1, DUMS.length - 1));
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault(); selectDum(Math.max(currentIndex - 1, 0));
  } else if (e.key === '/') {
    e.preventDefault(); document.getElementById('searchInput')?.focus();
  }
});

function toggleTask(index) {
  const card = document.getElementById('task-' + index);
  if (card) card.classList.toggle('open');
}

function filterDums(query) {
  const q = query.toLowerCase().trim();
  document.querySelectorAll('.dum-nav-item').forEach((el, i) => {
    const dum = DUMS[i];
    if (!dum) return;
    const searchText = [
      dum.tempId, dum.title, dum.type,
      ...(dum.tasks || []).map(t => t.title),
    ].join(' ').toLowerCase();
    el.style.display = (!q || searchText.includes(q)) ? '' : 'none';
  });
}

// (keyboard navigation merged into the listener above)

// Init: load from hash or first DUM
const hash = location.hash.replace('#', '');
const initIdx = hash ? DUMS.findIndex(d => d.tempId === hash) : 0;
selectDum(initIdx >= 0 ? initIdx : 0);
`
    .replace(/__DUMS_JSON__/g, args.dumsJson)
    .replace(/__TYPE_COLORS__/g, JSON.stringify(args.typeColors))
    .replace(/__TYPE_LABELS__/g, JSON.stringify(args.typeLabels))
    .replace(/__LAYER_COLORS__/g, JSON.stringify(args.layerColors))
    .replace(/__COMPLEXITY_COLORS__/g, JSON.stringify(args.complexityColors));
}
