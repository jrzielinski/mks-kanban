/**
 * DUM Viewer CSS — extracted from dum-view.ts:buildHtml.
 * Pure static CSS; the surrounding HTML/JS lives in dum-view.ts.
 */
export const DUM_VIEWER_CSS = `
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:         #07090D;
  --surface:    #0C1017;
  --surface2:   #111827;
  --surface3:   #1A2332;
  --border:     #1E2A3A;
  --border2:    #243042;
  --text:       #E2E8F0;
  --text2:      #8BA0B8;
  --text3:      #4A6070;
  --accent:     #38BDF8;
  --accent2:    #7C3AED;
  --glow:       rgba(56,189,248,0.12);
  --sidebar-w:  300px;
  --header-h:   58px;
  --font-display: 'Syne', sans-serif;
  --font-body:    'DM Sans', sans-serif;
  --font-mono:    'IBM Plex Mono', monospace;
}

html { scroll-behavior: smooth; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-body);
  font-size: 15px;
  line-height: 1.6;
  min-height: 100vh;
  overflow: hidden;
}

/* ── SCROLLBAR ─────────────────────────────────────────── */
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 99px; }
::-webkit-scrollbar-thumb:hover { background: var(--text3); }

/* ── HEADER ─────────────────────────────────────────────── */
.header {
  position: fixed; top: 0; left: 0; right: 0; z-index: 100;
  height: var(--header-h);
  background: rgba(7,9,13,0.92);
  backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center;
  padding: 0 20px 0 18px;
  gap: 12px;
}

.logo {
  display: flex; align-items: center; gap: 10px;
  flex-shrink: 0;
  text-decoration: none;
}
.logo-mark {
  width: 32px; height: 32px; flex-shrink: 0;
}
.logo-wordmark {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  background: linear-gradient(135deg, #A78BFA 0%, #38BDF8 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  letter-spacing: -0.3px;
}
.header-divider {
  width: 1px; height: 20px;
  background: var(--border2);
  flex-shrink: 0;
}
.header-pill {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--accent);
  letter-spacing: 0.05em;
  text-transform: uppercase;
  flex-shrink: 0;
}
.header-project {
  font-size: 13px;
  font-weight: 500;
  color: var(--text2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 360px;
}
.header-spacer { flex: 1; }
.header-stats {
  display: flex; gap: 16px; align-items: center;
  flex-shrink: 0;
}
.header-stat {
  display: flex; flex-direction: column; align-items: flex-end;
}
.header-stat-value {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 15px;
  color: var(--text);
  line-height: 1.1;
}
.header-stat-label {
  font-size: 10px;
  color: var(--text3);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.header-meta {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text3);
  white-space: nowrap;
}

/* ── LAYOUT ────────────────────────────────────────────── */
.layout {
  display: flex;
  margin-top: var(--header-h);
  height: calc(100vh - var(--header-h));
}

/* ── SIDEBAR ─────────────────────────────────────────────── */
.sidebar {
  width: var(--sidebar-w);
  flex-shrink: 0;
  height: 100%;
  overflow-y: auto;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
}
.sidebar-search {
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  position: sticky; top: 0;
  background: var(--surface);
  z-index: 10;
}
.search-input {
  width: 100%;
  background: var(--surface2);
  border: 1px solid var(--border2);
  border-radius: 8px;
  padding: 7px 12px;
  font-size: 13px;
  font-family: var(--font-body);
  color: var(--text);
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.search-input::placeholder { color: var(--text3); }
.search-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--glow);
}
.sidebar-list { padding: 8px 0; }

.dum-nav-item {
  width: 100%;
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 14px;
  background: transparent;
  border: none; cursor: pointer;
  text-align: left;
  transition: background 0.15s;
  border-left: 3px solid transparent;
}
.dum-nav-item:hover { background: rgba(255,255,255,0.03); }
.dum-nav-item.active {
  background: rgba(56,189,248,0.06);
  border-left-color: var(--accent);
}
.nav-badge {
  flex-shrink: 0;
  margin-top: 1px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  padding: 3px 7px;
  border-radius: 5px;
  border: 1px solid;
  letter-spacing: 0.05em;
  white-space: nowrap;
}
.nav-body { flex: 1; min-width: 0; }
.nav-title {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text);
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 4px;
}
.dum-nav-item.active .nav-title { color: #fff; }
.nav-meta {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 5px;
}
.nav-type { font-size: 10.5px; font-weight: 500; }
.nav-count {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text3);
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
}
.nav-quality { display: flex; align-items: center; gap: 6px; }
.quality-bar-track {
  flex: 1; height: 3px;
  background: var(--border2);
  border-radius: 99px;
  overflow: hidden;
}
.quality-bar-fill {
  height: 100%; border-radius: 99px;
  transition: width 0.5s ease;
}
.quality-pct {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  width: 30px;
  text-align: right;
}

/* ── MAIN ─────────────────────────────────────────────── */
.main {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow-y: auto;
  padding: 0;
}
.main-inner {
  max-width: 900px;
  margin: 0 auto;
  padding: 36px 40px 80px;
}

/* ── DUM HERO ─────────────────────────────────────────── */
.dum-hero {
  margin-bottom: 28px;
  animation: fadeSlideIn 0.35s ease both;
}
.dum-hero-top {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 10px;
}
.dum-number-big {
  flex-shrink: 0;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid;
}
.dum-type-chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
  padding: 3px 10px;
  border-radius: 5px;
  border: 1px solid;
}
.dum-type-chip::before {
  content: ''; width: 6px; height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.dum-hero-content { flex: 1; }
.dum-title {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  color: #fff;
  line-height: 1.2;
  letter-spacing: -0.5px;
  margin-bottom: 16px;
}
.dum-stats-row {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
}
.stat-chip {
  display: inline-flex; align-items: center; gap: 5px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
}
.stat-chip-icon { font-size: 13px; }
.stat-chip-val { font-family: var(--font-mono); font-weight: 500; color: var(--text); }
.stat-chip-label { color: var(--text3); }
.stat-sep {
  width: 1px; height: 18px;
  background: var(--border);
  flex-shrink: 0;
}
.dep-link-chip {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px 9px;
  font-size: 11px;
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--text2);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
  text-decoration: none;
}
.dep-link-chip:hover {
  border-color: #38BDF8;
  color: #38BDF8;
  background: #38BDF808;
}
.dep-link-chip::before {
  content: ''; width: 5px; height: 5px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.6;
}

/* ── QUALITY PANEL ───────────────────────────────────── */
.quality-panel {
  display: flex; gap: 12px;
  margin-bottom: 28px;
  animation: fadeSlideIn 0.35s ease 0.05s both;
}
.quality-card {
  flex: 1;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
}
.quality-card-label {
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--text3);
  margin-bottom: 8px;
}
.quality-card-bar {
  height: 6px; background: var(--border2);
  border-radius: 99px; overflow: hidden;
  margin-bottom: 6px;
}
.quality-card-fill {
  height: 100%; border-radius: 99px;
  transition: width 0.6s cubic-bezier(0.34,1.56,0.64,1);
}
.quality-card-bottom {
  display: flex; justify-content: space-between; align-items: baseline;
}
.quality-card-val {
  font-family: var(--font-mono); font-size: 15px; font-weight: 500;
}
.quality-card-sub { font-size: 10px; color: var(--text3); }

/* ── SECTION ──────────────────────────────────────────── */
.section {
  margin-bottom: 32px;
  animation: fadeSlideIn 0.35s ease 0.1s both;
}
.section-header {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 14px;
}
.section-icon {
  width: 28px; height: 28px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px;
  flex-shrink: 0;
}
.section-title {
  font-family: var(--font-display);
  font-size: 14px; font-weight: 700;
  letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--text2);
}
.section-count {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11px; color: var(--text3);
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 7px;
}
.section-divider {
  height: 1px; background: var(--border);
  margin-bottom: 16px;
}

/* ── DESCRIPTION ──────────────────────────────────────── */
.description-box {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 22px 24px;
  font-size: 14.5px;
  line-height: 1.7;
  color: var(--text2);
}
.description-box h1,
.description-box h2 { font-family: var(--font-display); font-weight: 700; color: var(--text); margin: 16px 0 6px; font-size: 16px; }
.description-box h3 { font-family: var(--font-display); font-weight: 600; color: var(--text); margin: 12px 0 4px; font-size: 14px; }
.description-box p { margin-bottom: 10px; }
.description-box ul, .description-box ol { padding-left: 20px; margin-bottom: 10px; }
.description-box li { margin-bottom: 3px; }
.description-box code {
  font-family: var(--font-mono);
  font-size: 12.5px;
  background: var(--surface3);
  border: 1px solid var(--border2);
  border-radius: 4px;
  padding: 1px 6px;
  color: var(--accent);
}
.description-box pre {
  background: var(--surface3);
  border: 1px solid var(--border2);
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  margin: 10px 0;
}
.description-box pre code {
  background: none; border: none; padding: 0;
  font-size: 12px; color: #CBD5E1;
}
.description-box strong { color: var(--text); font-weight: 600; }
.description-box blockquote {
  border-left: 3px solid var(--border2);
  padding-left: 14px;
  color: var(--text3);
  margin: 10px 0;
}

/* ── MERMAID ──────────────────────────────────────────── */
.mermaid-wrapper {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 32px 24px;
  overflow: auto;
  min-height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: zoom-in;
  transition: border-color 0.15s;
  position: relative;
}
.mermaid-wrapper:hover { border-color: var(--border2); }
.mermaid-wrapper .mermaid { width: 100%; min-width: 0; }
.mermaid-wrapper svg {
  width: 100% !important;
  max-width: 100% !important;
  height: auto !important;
  min-height: 200px;
}

/* ── DIAGRAM LIGHTBOX ─────────────────────────────────── */
.diagram-lightbox {
  display: none;
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(4, 6, 10, 0.94);
  backdrop-filter: blur(6px);
  align-items: center; justify-content: center;
}
.diagram-lightbox.open { display: flex; }
.diagram-lightbox-card {
  background: var(--surface1);
  border: 1px solid var(--border2);
  border-radius: 16px;
  width: 94vw; height: 90vh;
  display: flex; flex-direction: column;
  overflow: hidden;
  animation: fadeSlideIn 0.2s ease both;
  box-shadow: 0 32px 80px rgba(0,0,0,0.7);
}
.diagram-lightbox-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.diagram-lightbox-title {
  font-family: var(--font-display);
  font-size: 13px; font-weight: 700;
  letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--text2);
  display: flex; align-items: center; gap: 8px;
}
.diagram-lightbox-close {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text2);
  cursor: pointer;
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; line-height: 1;
  transition: border-color 0.15s, color 0.15s;
}
.diagram-lightbox-close:hover { border-color: #F87171; color: #F87171; }
.diagram-lightbox-toolbar {
  display: flex; align-items: center; gap: 6px;
}
.zoom-btn {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text2);
  cursor: pointer;
  height: 28px;
  min-width: 28px;
  padding: 0 8px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 600;
  font-family: var(--font-mono);
  transition: border-color 0.15s, color 0.15s;
  user-select: none;
}
.zoom-btn:hover { border-color: #38BDF8; color: #38BDF8; }
.zoom-level {
  font-family: var(--font-mono); font-size: 11px; font-weight: 600;
  color: var(--text3); min-width: 40px; text-align: center;
}
.diagram-lightbox-body {
  flex: 1;
  overflow: hidden;
  position: relative;
  cursor: grab;
  background:
    radial-gradient(circle, rgba(255,255,255,0.03) 1px, transparent 1px);
  background-size: 24px 24px;
}
.diagram-lightbox-body.dragging { cursor: grabbing; }
.diagram-canvas {
  position: absolute;
  transform-origin: 0 0;
  display: inline-block;
  will-change: transform;
}
.diagram-canvas svg {
  display: block;
  max-width: none !important;
  height: auto;
}
.maximize-btn {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text3);
  cursor: pointer;
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  margin-left: auto;
  transition: border-color 0.15s, color 0.15s;
  flex-shrink: 0;
}
.maximize-btn:hover { border-color: #38BDF8; color: #38BDF8; }

/* ── DEPS ─────────────────────────────────────────────── */
.deps-grid {
  display: flex; flex-wrap: wrap; gap: 8px;
}
.dep-chip {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 5px 11px;
  font-family: var(--font-mono);
  font-size: 12px; font-weight: 500;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.dep-chip:hover { border-color: var(--accent); background: var(--glow); }
.dep-chip .dep-dot {
  width: 7px; height: 7px; border-radius: 50%;
}

/* ── TASKS ────────────────────────────────────────────── */
.tasks-list { display: flex; flex-direction: column; gap: 10px; }
.task-card {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  transition: border-color 0.2s;
}
.task-card:hover { border-color: var(--border2); }
.task-card.open { border-color: var(--border2); }

.task-header {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 18px;
  cursor: pointer;
  user-select: none;
}
.task-num {
  flex-shrink: 0;
  width: 26px; height: 26px;
  background: var(--surface3);
  border: 1px solid var(--border2);
  border-radius: 7px;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-mono);
  font-size: 11px; font-weight: 500;
  color: var(--text3);
}
.task-title {
  flex: 1;
  font-size: 14px; font-weight: 500;
  color: var(--text);
  line-height: 1.35;
}
.task-badges { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
.badge {
  display: inline-block;
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
  padding: 2px 7px; border-radius: 4px;
  border: 1px solid;
}
.task-chevron {
  flex-shrink: 0;
  color: var(--text3);
  font-size: 13px;
  transition: transform 0.2s;
}
.task-card.open .task-chevron { transform: rotate(90deg); }

.task-body {
  display: none;
  padding: 0 18px 18px;
  border-top: 1px solid var(--border);
}
.task-card.open .task-body { display: block; }

.task-tech {
  margin-top: 14px;
  background: var(--surface3);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 10px 13px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text2);
  line-height: 1.6;
}
.task-tech-label {
  font-size: 10px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--accent); margin-bottom: 4px;
}
.task-desc {
  margin-top: 14px;
  font-size: 13.5px; line-height: 1.7;
  color: var(--text2);
}
.task-desc h1, .task-desc h2 { font-family: var(--font-display); font-size: 14px; font-weight: 600; color: var(--text); margin: 12px 0 4px; }
.task-desc h3 { font-family: var(--font-display); font-size: 13px; font-weight: 600; color: var(--text); margin: 10px 0 3px; }
.task-desc p { margin-bottom: 8px; }
.task-desc ul, .task-desc ol { padding-left: 18px; margin-bottom: 8px; }
.task-desc li { margin-bottom: 2px; }
.task-desc code {
  font-family: var(--font-mono); font-size: 11.5px;
  background: var(--surface3); border: 1px solid var(--border2);
  border-radius: 3px; padding: 1px 5px; color: var(--accent);
}
.task-desc pre {
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 7px; padding: 12px 14px; overflow-x: auto; margin: 8px 0;
}
.task-desc pre code { background:none; border:none; padding:0; font-size:11px; color:#94A3B8; }
.task-desc strong { color: var(--text); font-weight: 600; }

.ac-list { margin-top: 14px; }
.ac-header {
  font-size: 10px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: #34D399; margin-bottom: 8px;
  display: flex; align-items: center; gap: 6px;
}
.ac-header::before {
  content: ''; display: inline-block;
  width: 4px; height: 12px;
  background: #34D399; border-radius: 2px;
}
.ac-item {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 6px 10px; margin-bottom: 4px;
  background: rgba(52,211,153,0.04);
  border: 1px solid rgba(52,211,153,0.12);
  border-radius: 7px;
  font-size: 12.5px; line-height: 1.5; color: var(--text2);
  transition: background 0.15s;
}
.ac-item:hover { background: rgba(52,211,153,0.07); }
.ac-item::before {
  content: '✓'; flex-shrink: 0;
  color: #34D399; font-weight: 700; font-size: 12px;
  margin-top: 1px;
}

/* ── EMPTY ────────────────────────────────────────────── */
.empty-state {
  text-align: center; padding: 60px 20px;
  color: var(--text3);
}
.empty-state-icon { font-size: 40px; margin-bottom: 12px; }
.empty-state-text { font-size: 14px; }

/* ── ANIMATIONS ───────────────────────────────────────── */
@keyframes fadeSlideIn {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ── RESPONSIVE ───────────────────────────────────────── */
@media (max-width: 768px) {
  :root { --sidebar-w: 240px; }
  .main-inner { padding: 24px 20px 60px; }
  .dum-title { font-size: 22px; }
  .quality-panel { flex-direction: column; }
}
</style>
`;
