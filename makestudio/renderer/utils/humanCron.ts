/**
 * humanCron — renderiza expressões cron em PT-BR pra patterns comuns.
 * Não cobre 100% dos casos; cai em "cron: <expr>" pra patterns que não
 * baterem. Decisão de não puxar `cronstrue` (~30KB) — a UI mostra o
 * próprio cron junto da label, então ambiguity não compromete clareza.
 */

const SHORTCUTS: Record<string, string> = {
  '@hourly': 'A cada hora',
  '@daily': 'Todo dia à meia-noite',
  '@midnight': 'Todo dia à meia-noite',
  '@weekly': 'Todo domingo à meia-noite',
  '@monthly': 'Todo dia 1 à meia-noite',
  '@yearly': 'Todo 1º de janeiro à meia-noite',
  '@annually': 'Todo 1º de janeiro à meia-noite',
};

const WEEKDAYS = [
  'domingo',
  'segunda',
  'terça',
  'quarta',
  'quinta',
  'sexta',
  'sábado',
];
const MONTHS = [
  '',
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

const DAY_ALIAS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const MONTH_ALIAS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function asInt(v: string): number | null {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function formatTime(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function humanCron(expr: string): string {
  const trimmed = expr.trim();
  if (!trimmed) return '';
  if (SHORTCUTS[trimmed]) return SHORTCUTS[trimmed];

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return `cron: ${trimmed}`;

  const [minS, hourS, domS, monS, dowS] = parts;

  // Padrões muito comuns — bater rápido sem parser pesado.

  // "* * * * *" — a cada minuto.
  if (parts.every((p) => p === '*')) return 'A cada minuto';

  // "*/N * * * *" — a cada N minutos.
  const everyMinMatch = /^\*\/(\d+)$/.exec(minS);
  if (
    everyMinMatch &&
    hourS === '*' &&
    domS === '*' &&
    monS === '*' &&
    dowS === '*'
  ) {
    return `A cada ${everyMinMatch[1]} minutos`;
  }

  // "0 N * * *" / "M H * * *" — todo dia às HH:MM.
  const m = asInt(minS);
  const h = asInt(hourS);
  if (m !== null && h !== null && monS === '*') {
    if (domS === '*' && dowS === '*') {
      return `Todo dia às ${formatTime(h, m)}`;
    }
    if (domS === '*' && dowS !== '*') {
      // "M H * * D" — toda <weekday> às HH:MM
      const dowNorm = dowS.toLowerCase().replace(/[a-z]{3}/g, (w) =>
        w in DAY_ALIAS ? String(DAY_ALIAS[w]) : w,
      );
      const dow = asInt(dowNorm);
      if (dow !== null && dow >= 0 && dow <= 6) {
        return `Toda ${WEEKDAYS[dow]} às ${formatTime(h, m)}`;
      }
    }
    if (domS !== '*' && dowS === '*') {
      const dom = asInt(domS);
      if (dom !== null && dom >= 1 && dom <= 31) {
        return `Dia ${dom} de cada mês às ${formatTime(h, m)}`;
      }
    }
    if (domS !== '*' && dowS === '*' && monS !== '*') {
      const monNorm = monS.toLowerCase().replace(/[a-z]{3}/g, (w) =>
        w in MONTH_ALIAS ? String(MONTH_ALIAS[w]) : w,
      );
      const mon = asInt(monNorm);
      const dom = asInt(domS);
      if (mon && dom) {
        return `${dom} de ${MONTHS[mon] ?? monS} às ${formatTime(h, m)}`;
      }
    }
  }

  // Fallback — mostra o cron cru. UI já exibe `expr` junto, então não confunde.
  return `cron: ${trimmed}`;
}
