import { swallow } from '../utils/log';
/**
 * plugin-kanban-console — Renders MakeStudio Kanban boards in the terminal.
 *
 * Commands:
 *   makestudio kanban                    — list all boards
 *   makestudio kanban --board <id>       — render a specific board
 *   makestudio kanban --watch            — auto-refresh every 10s
 *   makestudio kanban --watch --interval 30  — custom refresh interval (seconds)
 *
 * Config (required):
 *   ~/.makestudio/config.json → { "serverUrl": "...", "token": "..." }
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { MakeStudioPlugin } from '../core/plugin-types';

// ── ANSI helpers ────────────────────────────────────────────────────────────

const c = {
  reset:    '\x1b[0m',
  bold:     '\x1b[1m',
  dim:      '\x1b[2m',
  red:      '\x1b[31m',
  green:    '\x1b[32m',
  yellow:   '\x1b[33m',
  blue:     '\x1b[34m',
  magenta:  '\x1b[35m',
  cyan:     '\x1b[36m',
  white:    '\x1b[37m',
  bgRed:    '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgCyan:   '\x1b[46m',
  bgWhite:  '\x1b[47m',
  black:    '\x1b[30m',
  gray:     '\x1b[90m',
};

const COLUMN_COLORS = [c.cyan, c.blue, c.magenta, c.yellow, c.green, c.red];

function col(color: string, text: string): string {
  return `${color}${text}${c.reset}`;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// Strip emoji and other wide unicode chars that break terminal alignment
function stripEmoji(str: string): string {
  return str
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')  // emoji blocks
    .replace(/[\u{2600}-\u{26FF}]/gu, '')     // misc symbols
    .replace(/[\u{2700}-\u{27BF}]/gu, '')     // dingbats
    .replace(/[\u{FE00}-\u{FEFF}]/gu, '')     // variation selectors
    .replace(/\s{2,}/g, ' ')                  // collapse double spaces left by removed chars
    .trim();
}

function visibleLen(str: string): number {
  return stripAnsi(str).length;
}

function padEnd(str: string, len: number): string {
  const visible = visibleLen(str);
  return str + ' '.repeat(Math.max(0, len - visible));
}

// ── Config ──────────────────────────────────────────────────────────────────

interface KanbanConfig {
  serverUrl: string;
  token: string;
}

function getConfig(): KanbanConfig | null {
  try {
    const configPath = path.join(os.homedir(), '.makestudio', 'config.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg.serverUrl && cfg.token) return { serverUrl: cfg.serverUrl, token: cfg.token };
    }
  } catch (err) { swallow(err); }
  return null;
}

// ── API — mesma implementação do plugin-kanban-sync ─────────────────────────

async function apiRequest(config: KanbanConfig, method: string, apiPath: string, body?: any): Promise<any> {
  return new Promise((resolve) => {
    try {
      const url = new URL(config.serverUrl);
      const transport = url.protocol === 'https:' ? https : http;
      const bodyStr = body ? JSON.stringify(body) : '';

      const req = transport.request({
        hostname: url.hostname,
        port: url.port,
        path: `/api/v1${apiPath}`,
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
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
      if (bodyStr) req.write(bodyStr);
      req.end();
    } catch { resolve(null); }
  });
}

// ── Data types ───────────────────────────────────────────────────────────────

interface KanbanCard {
  id: string;
  title: string;
  description?: string;
  assignee?: { name?: string; email?: string };
  labels?: Array<{ name: string; color?: string }>;
  dueDate?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  blockedBy?: string[];
  _count?: { activities?: number; checklist?: number; [key: string]: any };
}

interface KanbanList {
  id: string;
  title: string;
  wipLimit?: number;
  cards: KanbanCard[];
}

interface KanbanBoard {
  id: string;
  title: string;
  lists: KanbanList[];
}

// ── Rendering ────────────────────────────────────────────────────────────────

const CARD_WIDTH = 32;
const PRIORITY_ICONS: Record<string, string> = {
  critical: col(c.red, '!!!'),
  high:     col(c.yellow, '!!'),
  medium:   col(c.cyan, '!'),
  low:      col(c.gray, '·'),
};

function truncate(str: string, maxLen: number): string {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}

function isOverdue(dueDate: string): boolean {
  return new Date(dueDate) < new Date();
}

function formatDue(dueDate: string): string {
  const d = new Date(dueDate);
  const over = isOverdue(dueDate);
  const str = `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;
  return over ? col(c.red, `due:${str}!`) : col(c.gray, `due:${str}`);
}

function wrapText(text: string, maxLen: number, maxLines: number): string[] {
  const words = text.split(' ');
  const result: string[] = [];
  let line = '';
  for (const word of words) {
    if ((line + (line ? ' ' : '') + word).length <= maxLen) {
      line += (line ? ' ' : '') + word;
    } else {
      if (line) result.push(line);
      line = word.slice(0, maxLen);
      if (result.length + 1 >= maxLines) break;
    }
  }
  if (line && result.length < maxLines) result.push(line);
  return result;
}

function renderCard(card: KanbanCard, colColor: string): string[] {
  const inner = CARD_WIDTH - 2;
  const lines: string[] = [];

  const addLine = (content: string = '') => {
    lines.push(col(colColor, '│') + ' ' + padEnd(content, inner - 1) + col(colColor, '│'));
  };

  // Top border
  lines.push(col(colColor, '╭' + '─'.repeat(inner) + '╮'));

  // Title — up to 3 wrapped lines (strip emoji to avoid alignment breaks)
  const titleLines = wrapText(stripEmoji(card.title), inner - 1, 3);
  for (const tl of titleLines) {
    addLine(col(c.bold + c.white, tl));
  }

  // Labels row
  const labels = card.labels?.slice(0, 3) || [];
  if (labels.length > 0) {
    const labelStr = labels.map(l => col(c.magenta, `[${truncate(l.name, 8)}]`)).join(' ');
    addLine(labelStr);
  }

  // Separator
  lines.push(col(colColor, '├' + '─'.repeat(inner) + '┤'));

  // Priority + Assignee
  const priority = card.priority ? (PRIORITY_ICONS[card.priority] || '') : '';
  const assigneeName = card.assignee?.name || card.assignee?.email?.split('@')[0] || '';
  const assigneeStr = assigneeName ? col(c.cyan, truncate(`@${assigneeName}`, 16)) : col(c.gray, '');
  const metaLeft = priority ? priority + ' ' : '   ';
  addLine(metaLeft + padEnd(assigneeStr, inner - 5));

  // Due date + checklist + comments
  const parts: string[] = [];
  if (card.dueDate) parts.push(formatDue(card.dueDate));
  if (card.blockedBy?.length) parts.push(col(c.red, '[blocked]'));
  const checklist = (card._count as any)?.checklist;
  const comments  = (card._count as any)?.activities || (card as any).commentCount;
  if (checklist) parts.push(col(c.gray, `chk:${checklist}`));
  if (comments)  parts.push(col(c.gray, `cmt:${comments}`));
  if (parts.length > 0) addLine(parts.join('  '));
  else addLine();

  // Bottom border
  lines.push(col(colColor, '╰' + '─'.repeat(inner) + '╯'));

  return lines;
}

function renderBoard(board: KanbanBoard): void {
  const termWidth = process.stdout.columns || 120;

  // ── Board title ──
  console.log('');
  console.log(col(c.bold + c.white, `  📋  ${board.title}`));
  console.log(col(c.gray, '  ' + '─'.repeat(Math.min(termWidth - 4, 80))));
  console.log('');

  if (!board.lists || board.lists.length === 0) {
    console.log(col(c.gray, '  Nenhuma lista encontrada neste board.'));
    return;
  }

  // How many columns fit in the terminal
  const colsPerRow = Math.max(1, Math.floor((termWidth - 2) / (CARD_WIDTH + 2)));
  const listChunks: KanbanList[][] = [];
  for (let i = 0; i < board.lists.length; i += colsPerRow) {
    listChunks.push(board.lists.slice(i, i + colsPerRow));
  }

  for (const chunk of listChunks) {
    // Column headers
    const headers = chunk.map((list, idx) => {
      const color = COLUMN_COLORS[idx % COLUMN_COLORS.length];
      const cardCount = list.cards?.length || 0;
      const wip = list.wipLimit;
      const wipOver = wip && cardCount > wip;

      let countStr = col(wipOver ? c.red : c.gray, `(${cardCount}${wip ? `/${wip}` : ''})`);
      if (wipOver) countStr += col(c.red + c.bold, ' WIP!');

      const title = truncate(list.title.toUpperCase(), CARD_WIDTH - 6);
      const header = col(color + c.bold, title) + ' ' + countStr;
      return padEnd(header, CARD_WIDTH + 2);
    });
    console.log('  ' + headers.join('  '));
    console.log('  ' + chunk.map(() => col(c.gray, '─'.repeat(CARD_WIDTH))).join('  '));

    // Cards
    const maxCards = Math.max(...chunk.map(l => l.cards?.length || 0));
    if (maxCards === 0) {
      const emptyRow = chunk.map(() => col(c.gray, ' '.repeat(CARD_WIDTH))).join('  ');
      console.log('  ' + emptyRow);
      console.log('  ' + chunk.map(() => col(c.gray, `  ${col(c.dim, 'vazio')}`)).join('  '));
      console.log('');
      continue;
    }

    // Render each card row
    for (let ci = 0; ci < maxCards; ci++) {
      const cardLineGroups = chunk.map((list, colIdx) => {
        const color = COLUMN_COLORS[colIdx % COLUMN_COLORS.length];
        const card = list.cards?.[ci];
        if (!card) {
          // Empty placeholder lines (same height as a card: 7 lines)
          return Array(7).fill(' '.repeat(CARD_WIDTH));
        }
        return renderCard(card, color);
      });

      const cardHeight = Math.max(...cardLineGroups.map(g => g.length));
      for (let li = 0; li < cardHeight; li++) {
        const row = cardLineGroups.map(lines => {
          const line = lines[li] || '';
          return padEnd(line, CARD_WIDTH + 2);
        });
        console.log('  ' + row.join('  '));
      }
      console.log('');
    }
  }

  // ── Legend ──
  console.log(col(c.gray, `  Legenda: ${PRIORITY_ICONS['critical']} crítico  ${PRIORITY_ICONS['high']} alto  ${PRIORITY_ICONS['medium']} médio  ${PRIORITY_ICONS['low']} baixo  🔒 bloqueado  ⏰ atrasado`));
  console.log(col(c.gray, `  Atualizado em: ${new Date().toLocaleTimeString('pt-BR')}`));
  console.log('');
}

function renderBoardList(boards: any[], selIdx: number = 0): void {
  console.log('');
  console.log(col(c.bold + c.white, '  📋  Seus boards'));
  console.log(col(c.gray, '  ' + '─'.repeat(60)));
  console.log('');

  if (!boards || boards.length === 0) {
    console.log(col(c.gray, '  Nenhum board encontrado.'));
    console.log('');
    return;
  }

  // Header
  console.log(
    `  ${col(c.gray, '  #')}   ` +
    padEnd(col(c.gray, 'Nome'), 32) +
    padEnd(col(c.gray, 'Slug'), 30) +
    col(c.gray, 'ID'),
  );
  console.log(col(c.gray, '  ' + '─'.repeat(90)));

  boards.forEach((board, idx) => {
    const isSel   = idx === selIdx;
    const cursor  = isSel ? col(c.cyan + c.bold, '▶ ') : '  ';
    const num     = col(isSel ? c.cyan + c.bold : c.gray, String(idx + 1).padStart(2));
    const starred = board.isStarred ? col(c.yellow, '★ ') : '  ';
    const titleColor = isSel ? c.cyan + c.bold : c.white;
    const title   = padEnd(col(titleColor, truncate(board.title, 28)), 32);
    const slug    = padEnd(col(isSel ? c.cyan : c.green, truncate(board.slug || '', 28)), 30);
    const id      = col(c.gray, board.id);
    const cards   = board._count?.cards != null
      ? col(c.gray, ` (${board._count.cards})`)
      : '';

    console.log(`${cursor}${num}  ${starred}${title}${slug}${id}${cards}`);
  });

  console.log('');
  console.log(col(c.gray, '  Abrir por número:  ') + col(c.cyan, 'makestudio kanban --board 1'));
  console.log(col(c.gray, '  Abrir por slug:    ') + col(c.cyan, 'makestudio kanban --board meu-projeto'));
  console.log(col(c.gray, '  Abrir por ID:      ') + col(c.cyan, 'makestudio kanban --board <uuid>'));
  console.log('');
}

// ── TUI State ────────────────────────────────────────────────────────────────

type TuiMode = 'boards' | 'board' | 'detail' | 'move' | 'comment' | 'new-card';

interface TuiState {
  mode: TuiMode;
  boards: any[];
  board: any;
  selCol: number;
  selRow: number;
  cardScroll: number;   // index of first visible card row
  detailScroll: number; // scroll offset in detail view
  selBoardIdx: number;
  cardDetail: any;
  activities: any[];
  timeLogs: any[];
  commentInput: string;
  newCardInput: string;
  statusMsg: string;
  loading: boolean;
}

// ── Keyboard helpers ─────────────────────────────────────────────────────────

const KEY = {
  UP:     '\u001b[A',
  DOWN:   '\u001b[B',
  RIGHT:  '\u001b[C',
  LEFT:   '\u001b[D',
  ENTER:  '\r',
  ESC:    '\u001b',
  CTRL_C: '\u0003',
  BACKSP: '\u007f',
};

// ── Detail view renderer ─────────────────────────────────────────────────────

function renderCardDetail(state: TuiState): void {
  const card = state.cardDetail;
  if (!card) return;
  const termWidth  = process.stdout.columns || 120;
  const termHeight = process.stdout.rows    || 40;
  const w = Math.min(termWidth - 4, 100);

  // Build all content lines into array, then slice for scroll
  const lines: string[] = [];
  const push = (line: string = '') => lines.push(line);

  // ── Title + column badge ──────────────────────────────────────────────────
  const list = state.board?.lists?.find((l: any) =>
    l.cards?.some((ca: any) => ca.id === card.id),
  );
  const columnBadge = list ? col(c.cyan, ` [${list.title}]`) : '';
  push('');
  push(`  ${col(c.bold + c.white, stripEmoji(card.title))}${columnBadge}`);
  push(col(c.gray, '  ' + '═'.repeat(Math.min(w, termWidth - 6))));
  push('');

  // ── Meta row (priority, assignee, due, votes) ─────────────────────────────
  const metaParts: string[] = [];
  if (card.priority) {
    const pc = { critical: c.red, high: c.yellow, medium: c.cyan, low: c.gray }[card.priority as string] || c.white;
    metaParts.push(`Prioridade: ${col(pc, (card.priority as string).toUpperCase())}`);
  }
  if (card.assignee?.name || card.assignee?.email) {
    const nm = card.assignee.name || (card.assignee.email as string).split('@')[0];
    metaParts.push(`Responsável: ${col(c.cyan, '@' + nm)}`);
  }
  if (card.dueDate) metaParts.push(`Entrega: ${formatDue(card.dueDate as string)}`);
  const votes = (card as any).votes ?? (card as any).voteCount ?? (card as any)._count?.votes;
  if (votes) metaParts.push(`Votos: ${col(c.yellow, String(votes))}`);
  if (metaParts.length) push('  ' + metaParts.join('   '));

  // Labels
  if (card.labels?.length) {
    const lbls = card.labels.map((l: any) => col(c.magenta, `[${l.name}]`)).join(' ');
    push('  ' + col(c.gray, 'Etiquetas: ') + lbls);
  }
  if (metaParts.length || card.labels?.length) push('');

  // ── Descrição ─────────────────────────────────────────────────────────────
  push(col(c.bold + c.gray, '  DESCRIÇÃO'));
  push(col(c.gray, '  ' + '─'.repeat(Math.min(40, w))));
  if (card.description) {
    const descLines = wrapText(card.description as string, w - 4, 20);
    descLines.forEach((l: string) => push('  ' + col(c.white, l)));
  } else {
    push(col(c.gray, '  (sem descrição)'));
  }
  push('');

  // ── Checklist ─────────────────────────────────────────────────────────────
  const checklists: any[] = (card as any).checklists || [];
  if (checklists.length) {
    let totalItems = 0; let doneItems = 0;
    for (const grp of checklists) {
      for (const item of (grp.items || [])) {
        totalItems++;
        if (item.isCompleted) doneItems++;
      }
    }
    const pct = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;
    const barFill = Math.round(pct / 5);
    const bar = col(c.green, '█'.repeat(barFill)) + col(c.gray, '░'.repeat(20 - barFill));
    push(col(c.bold + c.gray, `  CHECKLIST`) + col(c.gray, `  ${bar} ${pct}%  (${doneItems}/${totalItems})`));
    push(col(c.gray, '  ' + '─'.repeat(Math.min(40, w))));
    for (const grp of checklists) {
      if (grp.title) push('  ' + col(c.gray, `  ${grp.title}`));
      for (const item of (grp.items || [])) {
        const done = item.isCompleted ? col(c.green, '[x]') : col(c.gray, '[ ]');
        push(`    ${done} ${col(item.isCompleted ? c.gray : c.white, stripEmoji(item.title))}`);
      }
    }
    push('');
  }

  // ── Registro de Horas ─────────────────────────────────────────────────────
  push(col(c.bold + c.gray, '  REGISTRO DE HORAS'));
  push(col(c.gray, '  ' + '─'.repeat(Math.min(40, w))));
  if (state.timeLogs?.length) {
    let totalMins = 0;
    for (const log of state.timeLogs) {
      const user = log.user?.name || (log.user?.email as string)?.split('@')[0] || '?';
      const mins = (log.minutes || log.durationMinutes || 0) as number;
      totalMins += mins;
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      const timeStr = h > 0 ? `${h}h${m > 0 ? m + 'm' : ''}` : `${m}m`;
      const note = log.description ? col(c.gray, ` — ${truncate(log.description as string, 50)}`) : '';
      const dateStr = log.loggedAt ? col(c.gray, ` (${new Date(log.loggedAt).toLocaleDateString('pt-BR')})`) : '';
      push(`  ${col(c.cyan, '@' + user)}: ${col(c.white, timeStr)}${dateStr}${note}`);
    }
    const th = Math.floor(totalMins / 60);
    const tm = totalMins % 60;
    push(col(c.gray, `  Total: ${th > 0 ? th + 'h' : ''}${tm > 0 ? tm + 'm' : '0m'}`));
  } else {
    push(col(c.gray, '  Nenhuma hora registrada.'));
  }
  push('');

  // ── Bloqueadores ──────────────────────────────────────────────────────────
  const blockers: any[] = (card as any).blockers || (card as any).blockedBy || [];
  push(col(c.bold + c.gray, '  BLOQUEADORES'));
  push(col(c.gray, '  ' + '─'.repeat(Math.min(40, w))));
  if (blockers.length) {
    for (const b of blockers) {
      const bTitle = typeof b === 'string' ? b : (b.title || b.id || String(b));
      push(`  ${col(c.red, '◈')} ${col(c.white, stripEmoji(bTitle))}`);
    }
  } else {
    push(col(c.gray, '  Nenhum bloqueador — card pode ser movido livremente.'));
  }
  push('');

  // ── Cards Vinculados ──────────────────────────────────────────────────────
  const linkedCards: any[] = (card as any).linkedCards || (card as any).relations || [];
  push(col(c.bold + c.gray, '  CARDS VINCULADOS'));
  push(col(c.gray, '  ' + '─'.repeat(Math.min(40, w))));
  if (linkedCards.length) {
    for (const lc of linkedCards) {
      const lcTitle = typeof lc === 'string' ? lc : (lc.title || lc.card?.title || lc.id);
      const lcBoard = lc.board?.title ? col(c.gray, ` — ${lc.board.title}`) : '';
      const lcList  = lc.list?.title  ? col(c.gray, ` [${lc.list.title}]`)  : '';
      const relType = lc.type ? col(c.gray, ` (${lc.type})`) : '';
      push(`  ${col(c.blue, '→')} ${col(c.white, stripEmoji(String(lcTitle)))}${relType}${lcBoard}${lcList}`);
    }
  } else {
    push(col(c.gray, '  Nenhum card vinculado.'));
  }
  push('');

  // ── Comentários ───────────────────────────────────────────────────────────
  const comments = (state.activities || []).filter((a: any) => a.type === 'comment');
  push(col(c.bold + c.gray, `  COMENTÁRIOS`) + col(c.gray, `  (${comments.length})`));
  push(col(c.gray, '  ' + '─'.repeat(Math.min(40, w))));
  if (comments.length === 0) {
    push(col(c.gray, '  (sem comentários)'));
  } else {
    for (const act of comments) {
      const author = act.user?.name || (act.user?.email as string)?.split('@')[0] || '?';
      const ts = act.createdAt
        ? col(c.gray, ' ' + new Date(act.createdAt).toLocaleDateString('pt-BR'))
        : '';
      push(`  ${col(c.cyan, '@' + author)}${ts}:`);
      const contentLines = wrapText(String(act.text || ''), w - 6, 5);
      contentLines.forEach((l: string) => push('    ' + col(c.white, l)));
    }
  }
  push('');

  // ── Scroll + render ───────────────────────────────────────────────────────
  const FOOTER_H = 2;
  const viewHeight = termHeight - FOOTER_H;
  const maxScroll  = Math.max(0, lines.length - viewHeight);
  state.detailScroll = Math.max(0, Math.min(state.detailScroll, maxScroll));

  const visibleLines = lines.slice(state.detailScroll, state.detailScroll + viewHeight);
  visibleLines.forEach(l => console.log(l));

  // Pad remaining rows so footer is always at bottom
  const remaining = viewHeight - visibleLines.length;
  for (let i = 0; i < remaining; i++) console.log('');

  // Footer — two lines: actions + navigation
  const scrollHint = lines.length > viewHeight
    ? col(c.gray, `  ↑↓ scroll ${state.detailScroll + 1}/${maxScroll + 1}`)
    : '';
  const votesCount = (card as any).votes ?? (card as any).voteCount ?? (card as any)._count?.votes ?? 0;
  console.log(
    col(c.gray, '  ') +
    col(c.cyan, '[M]') + col(c.gray, 'Mover  ') +
    col(c.cyan, '[C]') + col(c.gray, 'Comentar  ') +
    col(c.cyan, '[V]') + col(c.gray, `Votar(${votesCount})  `) +
    col(c.cyan, '[R]') + col(c.gray, 'Refresh') +
    scrollHint,
  );
  console.log(col(c.gray, `  [ESC]Voltar  [Q]Sair`));
}

// ── Move modal renderer ───────────────────────────────────────────────────────

function renderMoveModal(state: TuiState): void {
  const lists = state.board?.lists || [];
  const card = state.cardDetail;
  console.log('');
  console.log(col(c.bold + c.white, `  Mover card para:`));
  console.log(col(c.gray, '  ' + '─'.repeat(40)));
  lists.forEach((list: any, idx: number) => {
    const sel = idx === state.selCol;
    const marker = sel ? col(c.cyan + c.bold, ' ► ') : '   ';
    const inCurrent = list.cards?.some((ca: any) => ca.id === card?.id);
    const tag = inCurrent ? col(c.gray, ' (atual)') : '';
    console.log(`${marker}${col(sel ? c.white + c.bold : c.gray, list.title)}${tag}`);
  });
  console.log('');
  console.log(col(c.gray, '  ↑↓ navegar  Enter confirmar  ESC cancelar'));
}

// ── Comment / New card input renderer ────────────────────────────────────────

function renderInputModal(state: TuiState, title: string, input: string): void {
  console.log('');
  console.log(col(c.bold + c.white, `  ${title}`));
  console.log(col(c.gray, '  ' + '─'.repeat(50)));
  console.log(`  ${col(c.cyan, '›')} ${input}${col(c.white, '█')}`);
  console.log('');
  console.log(col(c.gray, '  Enter confirmar  ESC cancelar'));
}

// ── Main TUI loop ─────────────────────────────────────────────────────────────

async function runInteractiveTui(cfg: KanbanConfig, boardArg?: string): Promise<void> {
  const CARD_H = 9;  // lines per card (fixed height for layout calc)

  const state: TuiState = {
    mode: boardArg ? 'board' : 'boards',
    boards: [],
    board: null,
    selCol: 0,
    selRow: 0,
    cardScroll: 0,
    detailScroll: 0,
    selBoardIdx: 0,
    cardDetail: null,
    activities: [],
    timeLogs: [],
    commentInput: '',
    newCardInput: '',
    statusMsg: '',
    loading: true,
  };

  // ── Fetch helpers ──
  async function loadBoards(): Promise<void> {
    const res = await apiRequest(cfg, 'GET', '/kanban/boards');
    state.boards = Array.isArray(res) ? res : res?.data || res?.boards || [];
  }

  async function loadBoard(id: string): Promise<void> {
    const res = await apiRequest(cfg, 'GET', `/kanban/boards/${id}`);
    if (res && !res.statusCode) {
      state.board = res;
      state.selCol = Math.min(state.selCol, (res.lists?.length || 1) - 1);
      state.selRow = 0;
    }
  }

  async function resolveAndLoadBoard(arg: string): Promise<void> {
    await loadBoards();
    const idx = parseInt(arg, 10);
    let id = arg;
    if (!isNaN(idx) && idx >= 1 && idx <= state.boards.length) {
      id = state.boards[idx - 1].id;
    } else {
      const bySlug = state.boards.find((b: any) => b.slug === arg);
      if (bySlug) id = bySlug.id;
    }
    await loadBoard(id);
  }

  async function loadCardDetail(cardId: string): Promise<void> {
    // Try full card endpoint first (has linkedCards, blockers, votes, etc.)
    const fullCard = await apiRequest(cfg, 'GET', `/kanban/cards/${cardId}`);
    if (fullCard && !fullCard.statusCode) {
      state.cardDetail = fullCard;
    } else {
      // Fallback: get from already-loaded board data
      const allCards = (state.board?.lists || []).flatMap((l: any) => l.cards || []);
      state.cardDetail = allCards.find((ca: any) => ca.id === cardId) || null;
    }
    // Fetch activities/comments
    const acts = await apiRequest(cfg, 'GET', `/kanban/cards/${cardId}/activities`);
    state.activities = Array.isArray(acts) ? acts : acts?.data || [];
    // Fetch time logs
    const logs = await apiRequest(cfg, 'GET', `/kanban/cards/${cardId}/time-logs`);
    state.timeLogs = Array.isArray(logs) ? logs : logs?.data || [];
    state.detailScroll = 0;
  }

  // ── Render ──
  function render(): void {
    process.stdout.write('\x1b[2J\x1b[H'); // clear screen

    if (state.loading) {
      console.log(col(c.gray, '\n  Carregando...'));
      return;
    }

    if (state.statusMsg) {
      console.log(col(c.green, `  ✓ ${state.statusMsg}`));
      console.log('');
    }

    switch (state.mode) {
      case 'boards':
        renderBoardList(state.boards, state.selBoardIdx);
        console.log(col(c.gray, '  ↑↓ navegar   Enter abrir   Q sair'));
        break;

      case 'board': {
        // Render board with selected card highlighted
        renderBoardWithCursor(state);
        const lists = state.board?.lists || [];
        const curList = lists[state.selCol];
        const totalCards = curList?.cards?.length || 0;
        console.log(col(c.gray,
          `  ←→ coluna   ↑↓ card (${state.selRow + 1}/${totalCards})   Enter detalhes   M mover   N novo   R refresh   Q sair`,
        ));
        break;
      }

      case 'detail':
        renderCardDetail(state);
        break;

      case 'move':
        renderMoveModal(state);
        break;

      case 'comment':
        renderInputModal(state, 'Adicionar comentário:', state.commentInput);
        break;

      case 'new-card':
        renderInputModal(state, 'Novo card:', state.newCardInput);
        break;
    }
  }

  // ── Board render with cursor and virtual scroll ──
  function renderBoardWithCursor(state: TuiState): void {
    const board = state.board;
    if (!board) return;

    const termWidth  = process.stdout.columns || 120;
    const termHeight = process.stdout.rows    || 40;
    // Layout: 1 blank + 1 title + 1 sep + 1 blank + 1 col-header + 1 col-sep = 6 rows header
    //         1 status bar = 1 row footer
    const HEADER_ROWS = 6;
    const FOOTER_ROWS = 2;
    const available   = termHeight - HEADER_ROWS - FOOTER_ROWS;
    // Each card = CARD_H content lines + 1 blank line between = CARD_H+1 lines
    const visibleCards = Math.max(1, Math.floor(available / (CARD_H + 1)));

    const lists: any[] = board.lists || [];
    if (!lists.length) return;

    const colsPerRow = Math.max(1, Math.floor((termWidth - 2) / (CARD_WIDTH + 2)));

    // ── Header ──
    console.log('');
    console.log(col(c.bold + c.white, `  >> ${stripEmoji(board.title)}`));
    console.log(col(c.gray, '  ' + '─'.repeat(Math.min(termWidth - 4, termWidth - 4))));
    console.log('');

    // ── Column headers (all columns in one row group) ──
    const headerLine = lists.map((list: any, colIdx: number) => {
      const color   = colIdx === state.selCol ? c.white + c.bold : COLUMN_COLORS[colIdx % COLUMN_COLORS.length];
      const cnt     = list.cards?.length || 0;
      const wip     = list.wipLimit;
      const wipOver = wip && cnt > wip;
      const countStr = col(wipOver ? c.red : c.gray, `(${cnt}${wip ? `/${wip}` : ''})`);
      const sel   = colIdx === state.selCol ? col(c.cyan, '▌ ') : '  ';
      const title = truncate(list.title.toUpperCase(), CARD_WIDTH - 6);
      return padEnd(sel + col(color, title) + ' ' + countStr, CARD_WIDTH + 4);
    });
    console.log('  ' + headerLine.slice(0, colsPerRow).join('  '));
    console.log('  ' + lists.slice(0, colsPerRow).map((_: any, colIdx: number) =>
      col(colIdx === state.selCol ? c.white : c.gray, '─'.repeat(CARD_WIDTH)),
    ).join('  '));

    // ── Ensure selected card is within scroll window ──
    if (state.selRow < state.cardScroll) {
      state.cardScroll = state.selRow;
    } else if (state.selRow >= state.cardScroll + visibleCards) {
      state.cardScroll = state.selRow - visibleCards + 1;
    }

    // ── Render only the visible card rows ──
    const maxCards = Math.max(...lists.map((l: any) => l.cards?.length || 0));
    const endRow   = Math.min(state.cardScroll + visibleCards, maxCards);

    for (let ci = state.cardScroll; ci < endRow; ci++) {
      // One row = all visible columns side by side
      const cardLines: string[][] = lists.slice(0, colsPerRow).map((list: any, localIdx: number) => {
        const isSelectedCard = localIdx === state.selCol && ci === state.selRow;
        const color = isSelectedCard ? c.cyan + c.bold : COLUMN_COLORS[localIdx % COLUMN_COLORS.length];
        const card  = list.cards?.[ci];
        if (!card) {
          // Empty cell — same height as a card so columns stay aligned
          return Array(CARD_H).fill(' '.repeat(CARD_WIDTH));
        }
        let lines = renderCard(card, color);
        // Normalize to CARD_H lines (pad short cards, truncate if needed)
        while (lines.length < CARD_H) lines.push(' '.repeat(CARD_WIDTH));
        lines = lines.slice(0, CARD_H);
        if (isSelectedCard) {
          // Invert background: bgWhite + black text for max contrast
          lines = lines.map(line => {
            const plain = stripAnsi(line);
            const padded = plain + ' '.repeat(Math.max(0, CARD_WIDTH - plain.length));
            return `${c.bgWhite}${c.black}${c.bold}${padded}${c.reset}`;
          });
        }
        return lines;
      });

      for (let li = 0; li < CARD_H; li++) {
        const row = cardLines.map(lines => padEnd(lines[li] || '', CARD_WIDTH + 2));
        console.log('  ' + row.join('  '));
      }
      console.log(''); // blank line between cards
    }

    // ── Scroll indicator ──
    if (maxCards > visibleCards) {
      const from = state.cardScroll + 1;
      const to   = Math.min(state.cardScroll + visibleCards, maxCards);
      process.stdout.write(col(c.gray, `  mostrando ${from}–${to} de ${maxCards} cards`));
    }
  }

  // ── Keyboard handlers ──
  async function handleKey(raw: Buffer): Promise<void> {
    const key = raw.toString();
    if (key === KEY.CTRL_C) {
      (state as any).__quit();
      return;
    }

    const lists: any[] = state.board?.lists || [];

    if (state.mode === 'boards') {
      if (key === KEY.UP)    state.selBoardIdx = Math.max(0, state.selBoardIdx - 1);
      if (key === KEY.DOWN)  state.selBoardIdx = Math.min(state.boards.length - 1, state.selBoardIdx + 1);
      if (key === KEY.ENTER) {
        state.loading = true; render();
        await loadBoard(state.boards[state.selBoardIdx].id);
        state.mode = 'board'; state.loading = false;
      }
      if (key === 'q' || key === 'Q' || key === KEY.ESC) { (state as any).__quit(); return; }
    }

    else if (state.mode === 'board') {
      if (key === KEY.LEFT)  { state.selCol = Math.max(0, state.selCol - 1); state.selRow = 0; state.cardScroll = 0; }
      if (key === KEY.RIGHT) { state.selCol = Math.min(lists.length - 1, state.selCol + 1); state.selRow = 0; state.cardScroll = 0; }
      if (key === KEY.UP)    state.selRow = Math.max(0, state.selRow - 1);
      if (key === KEY.DOWN) {
        const maxRow = (lists[state.selCol]?.cards?.length || 1) - 1;
        state.selRow = Math.min(maxRow, state.selRow + 1);
      }
      if (key === KEY.ENTER) {
        const card = lists[state.selCol]?.cards?.[state.selRow];
        if (card) {
          state.loading = true; render();
          await loadCardDetail(card.id);
          state.mode = 'detail'; state.loading = false;
        }
      }
      if (key === 'm' || key === 'M') {
        const card = lists[state.selCol]?.cards?.[state.selRow];
        if (card) {
          state.loading = true; render();
          await loadCardDetail(card.id);
          state.selCol = lists.findIndex((l: any) => l.cards?.some((ca: any) => ca.id === card.id));
          state.mode = 'move'; state.loading = false;
        }
      }
      if (key === 'n' || key === 'N') {
        state.newCardInput = '';
        state.mode = 'new-card';
      }
      if (key === 'r' || key === 'R') {
        state.loading = true; render();
        await loadBoard(state.board.id);
        state.loading = false;
      }
      if (key === KEY.ESC) {
        // Back to board list (if we came from there)
        if (state.boards.length > 0) {
          state.mode = 'boards';
        } else {
          (state as any).__quit(); return;
        }
      }
      if (key === 'q' || key === 'Q') { (state as any).__quit(); return; }
    }

    else if (state.mode === 'detail') {
      if (key === KEY.ESC || key === 'q' || key === 'Q') { state.mode = 'board'; }
      if (key === KEY.UP)   state.detailScroll = Math.max(0, state.detailScroll - 1);
      if (key === KEY.DOWN) state.detailScroll += 1; // clamped in renderCardDetail
      if (key === 'm' || key === 'M') {
        state.selCol = lists.findIndex((l: any) =>
          l.cards?.some((ca: any) => ca.id === state.cardDetail?.id),
        );
        state.mode = 'move';
      }
      if (key === 'c' || key === 'C') { state.commentInput = ''; state.mode = 'comment'; }
      if (key === 'v' || key === 'V') {
        if (state.cardDetail?.id) {
          await apiRequest(cfg, 'POST', `/kanban/cards/${state.cardDetail.id}/vote`);
          await loadCardDetail(state.cardDetail.id);
          state.statusMsg = 'Voto registrado';
          setTimeout(() => { state.statusMsg = ''; render(); }, 1500);
        }
      }
      if (key === 'r' || key === 'R') {
        if (state.cardDetail?.id) {
          state.loading = true; render();
          await loadCardDetail(state.cardDetail.id);
          state.loading = false;
        }
      }
    }

    else if (state.mode === 'move') {
      if (key === KEY.UP)    state.selCol = Math.max(0, state.selCol - 1);
      if (key === KEY.DOWN)  state.selCol = Math.min(lists.length - 1, state.selCol + 1);
      if (key === KEY.ESC)   { state.mode = 'detail'; }
      if (key === KEY.ENTER && state.cardDetail) {
        const targetList = lists[state.selCol];
        state.loading = true; render();
        await apiRequest(cfg, 'PATCH', `/kanban/cards/${state.cardDetail.id}/move`, {
          listId: targetList.id,
          position: 0,
        });
        await loadBoard(state.board.id);
        state.statusMsg = `Card movido para "${targetList.title}"`;
        setTimeout(() => { state.statusMsg = ''; render(); }, 2000);
        state.mode = 'board'; state.loading = false;
      }
    }

    else if (state.mode === 'comment') {
      if (key === KEY.ESC) { state.mode = 'detail'; }
      else if (key === KEY.ENTER) {
        if (state.commentInput.trim()) {
          state.loading = true; render();
          await apiRequest(cfg, 'POST', `/kanban/cards/${state.cardDetail.id}/activities`, {
            type: 'comment',
            text: state.commentInput.trim(),
          });
          await loadCardDetail(state.cardDetail.id);
          state.commentInput = '';
          state.statusMsg = 'Comentário adicionado';
          setTimeout(() => { state.statusMsg = ''; render(); }, 1500);
          state.mode = 'detail'; state.loading = false;
        }
      }
      else if (key === KEY.BACKSP) state.commentInput = state.commentInput.slice(0, -1);
      else if (key.length === 1 && key >= ' ') state.commentInput += key;
    }

    else if (state.mode === 'new-card') {
      if (key === KEY.ESC) { state.mode = 'board'; }
      else if (key === KEY.ENTER) {
        if (state.newCardInput.trim()) {
          state.loading = true; render();
          const list = lists[state.selCol];
          await apiRequest(cfg, 'POST', `/kanban/lists/${list.id}/cards`, {
            title: state.newCardInput.trim(),
          });
          await loadBoard(state.board.id);
          state.newCardInput = '';
          state.statusMsg = 'Card criado';
          setTimeout(() => { state.statusMsg = ''; render(); }, 1500);
          state.mode = 'board'; state.loading = false;
        }
      }
      else if (key === KEY.BACKSP) state.newCardInput = state.newCardInput.slice(0, -1);
      else if (key.length === 1 && key >= ' ') state.newCardInput += key;
    }

    render();
  }

  let quitResolve: (() => void) | null = null;

  function cleanup(): void {
    process.stdin.off('data', handleKey);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    process.stdout.write('\x1b[?25h');    // show cursor
    process.stdout.write('\x1b[?1049l'); // exit alternative screen (restore terminal)
  }

  function quit(): void {
    cleanup();
    if (quitResolve) {
      const r = quitResolve;
      quitResolve = null;
      r();
    }
  }

  // Expose quit() to handleKey via state (so handlers can call it)
  (state as any).__quit = quit;

  // ── Boot — enter fullscreen ──
  process.stdout.write('\x1b[?1049h'); // enter alternative screen buffer (fullscreen)
  process.stdout.write('\x1b[?25l');   // hide cursor

  state.loading = true;
  render();

  if (boardArg) {
    await resolveAndLoadBoard(boardArg);
    state.mode = 'board';
  } else {
    await loadBoards();
    state.mode = 'boards';
  }

  state.loading = false;
  render();

  // Enable raw keyboard input
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleKey);

  // Wait until user quits (ESC/Q/Ctrl+C) — returns to REPL
  await new Promise<void>((resolve) => { quitResolve = resolve; });
}

// ── Command handler ──────────────────────────────────────────────────────────

async function runKanban(options: Record<string, any>): Promise<void> {
  const config = getConfig();
  if (!config) {
    console.error(col(c.red, '\n  ✗ Configuração não encontrada. Faça login com: makestudio login\n'));
    process.exitCode = 1;
    return;
  }
  await runInteractiveTui(config, options.board);
}

// ── Plugin definition ────────────────────────────────────────────────────────

const plugin: MakeStudioPlugin = {
  name: 'kanban-console',
  version: '1.0.0',
  description: 'Render MakeStudio Kanban boards directly in the terminal',

  commands: [
    {
      name: 'kanban',
      description: 'Show Kanban board in the terminal',
      options: [
        { flags: '--board <id>', description: 'Board ID, número ou slug para abrir direto (omitir = listar todos)' },
      ],
      handler: runKanban,
    },
  ],
};

export default plugin;
