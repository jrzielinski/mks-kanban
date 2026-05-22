/**
 * theme.ts
 *
 * Central colour palette. Modules import chalk helpers from here instead
 * of hardcoding `chalk.hex(...)` so `/theme <name>` actually takes effect
 * across the TUI.
 *
 * Each theme defines a palette of semantic slots (primary, accent, success,
 * warning, danger, dim, text, inverseBg, inverseFg). Components reference
 * slots by name — not raw colour values.
 */

import chalk from 'chalk';
import { loadSettings, Theme } from './settings';

interface Palette {
  primary: string;   // cyan-ish by default
  accent: string;    // blue / pink / purple depending on theme
  success: string;   // green
  warning: string;   // yellow / orange
  danger: string;    // red
  dim: string;       // subtle gray
  text: string;      // main text
  codeBg: string;    // codespan background
  codeFg: string;    // codespan foreground
  inputBorder: string;
  /** 3 colour stops for the welcome banner gradient (left→middle→right). */
  bannerGradient: [string, string, string];
  /** Optional syntax-highlight overrides used by markdown.ts. When absent,
   *  the cli-highlight theme falls back to the legacy mapping
   *  (keyword→accent, function→warning, string→success, etc.). Define them
   *  on a theme to decouple syntax colours from the rest of the UI palette
   *  — e.g. so `+` markers (success) can stay green while string literals
   *  use a different gold/yellow that matches the editor aesthetic. */
  synKeyword?: string;
  synFunc?: string;
  synString?: string;
  synNumber?: string;
  synType?: string;
  synComment?: string;
}

const PALETTES: Record<Theme, Palette> = {
  default: {
    // Values copied straight from Claude Code's darkTheme in
    // claude-code/src/utils/theme.ts, mapped onto our semantic slots:
    //   primary ← suggestion  (#B1B9F9) light blue-purple — the ● bullets
    //   accent  ← claude       (#D77757) Claude brand orange — file paths, code inline
    //   success ← success      (#4EBA65) bright green — + diff, ok
    //   warning ← warning      (#FFC107) bright amber
    //   danger  ← error        (#FF6B80) coral red — errors, - diff
    //   dim     ← inactive     (#999999) light gray — metadata
    //   text    ← text         (#FFFFFF) white
    // Distinct hues per slot so bullets / headers / code / arrows all read
    // separately instead of blending into a monochrome block.
    primary: '#B1B9F9', accent: '#D77757', success: '#4EBA65',
    warning: '#FFC107', danger: '#FF6B80', dim: '#999999',
    text: '#FFFFFF', codeBg: '#1A1B26', codeFg: '#D77757',
    inputBorder: 'cyan',
    bannerGradient: ['#B1B9F9', '#D77757', '#4EBA65'], // suggestion → claude → success
  },
  // Previous `default` preserved under a new name — amber + indigo accent.
  classic: {
    primary: '#CF7B4B', accent: '#818CF8', success: '#22C55E',
    warning: '#FBBF24', danger: '#EF4444', dim: '#64748B',
    text: '#E2E8F0', codeBg: '#1E293B', codeFg: '#E2E8F0',
    inputBorder: 'yellow',
    bannerGradient: ['#CF7B4B', '#F59E0B', '#818CF8'],
  },
  dark: {
    primary: '#0891B2', accent: '#3B82F6', success: '#16A34A',
    warning: '#CA8A04', danger: '#DC2626', dim: '#475569',
    // codeBg = Claude Code's diffAdded blue (rgb(0,68,102)) — same dark
    // saturated blue used as the background for added lines in their diff
    // viewer. High contrast with white code text, distinct from the
    // primary cyan and the accent blue.
    text: '#CBD5E1', codeBg: '#004466', codeFg: '#F1F5F9',
    inputBorder: 'blue',
    bannerGradient: ['#8B5CF6', '#3B82F6', '#06B6D4'], // violet → blue → cyan
  },
  light: {
    primary: '#0E7490', accent: '#1D4ED8', success: '#15803D',
    warning: '#A16207', danger: '#B91C1C', dim: '#94A3B8',
    text: '#0F172A', codeBg: '#E2E8F0', codeFg: '#0F172A',
    inputBorder: 'blue',
    bannerGradient: ['#7C3AED', '#1D4ED8', '#0E7490'], // violet → blue → teal (dark enough for light bg)
  },
  monokai: {
    primary: '#66D9EF', accent: '#F92672', success: '#A6E22E',
    warning: '#E6DB74', danger: '#F92672', dim: '#75715E',
    text: '#F8F8F2', codeBg: '#272822', codeFg: '#F8F8F2',
    inputBorder: 'magenta',
    bannerGradient: ['#F92672', '#66D9EF', '#A6E22E'], // pink → cyan → green
  },
  dracula: {
    primary: '#8BE9FD', accent: '#FF79C6', success: '#50FA7B',
    warning: '#F1FA8C', danger: '#FF5555', dim: '#6272A4',
    text: '#F8F8F2', codeBg: '#282A36', codeFg: '#F8F8F2',
    inputBorder: 'magenta',
    bannerGradient: ['#FF79C6', '#8BE9FD', '#50FA7B'], // pink → cyan → green
  },
  solarized: {
    primary: '#268BD2', accent: '#CB4B16', success: '#859900',
    warning: '#B58900', danger: '#DC322F', dim: '#657B83',
    text: '#93A1A1', codeBg: '#073642', codeFg: '#93A1A1',
    inputBorder: 'yellow',
    bannerGradient: ['#DC322F', '#B58900', '#268BD2'], // red → yellow → blue
  },
  // Adwaita light — crisp neutrals, Fedora blue
  fedora: {
    primary: '#4A90D9', accent: '#1C71D8', success: '#2EC27E',
    warning: '#E5A50A', danger: '#C01C28', dim: '#9A9996',
    text: '#1C1C1C', codeBg: '#F6F5F4', codeFg: '#1C1C1C',
    inputBorder: 'blue',
    bannerGradient: ['#1C71D8', '#4A90D9', '#2EC27E'], // blue → light blue → green
  },
  // Aubergine dark, Ubuntu orange energy
  ubuntu: {
    primary: '#E95420', accent: '#AEA79F', success: '#38B44A',
    warning: '#EFB73E', danger: '#DF382C', dim: '#77767B',
    text: '#E8E8E8', codeBg: '#300A24', codeFg: '#FFFFFF',
    inputBorder: 'red',
    bannerGradient: ['#300A24', '#E95420', '#EFB73E'], // aubergine → orange → yellow
  },
  // GitHub-dark vibes with Arch cyan
  arch: {
    primary: '#1793D1', accent: '#4DC9F0', success: '#56D364',
    warning: '#E3B341', danger: '#F85149', dim: '#484F58',
    text: '#C9D1D9', codeBg: '#161B22', codeFg: '#C9D1D9',
    inputBorder: 'cyan',
    bannerGradient: ['#1793D1', '#4DC9F0', '#56D364'], // arch blue → cyan → green
  },
  // Warm retro amber on brown
  gruvbox: {
    primary: '#FABD2F', accent: '#FE8019', success: '#B8BB26',
    warning: '#FABD2F', danger: '#FB4934', dim: '#928374',
    text: '#EBDBB2', codeBg: '#282828', codeFg: '#EBDBB2',
    inputBorder: 'yellow',
    bannerGradient: ['#FB4934', '#FABD2F', '#B8BB26'], // red → amber → green
  },
  // Cool fjord blues, quiet and precise
  nord: {
    primary: '#88C0D0', accent: '#81A1C1', success: '#A3BE8C',
    warning: '#EBCB8B', danger: '#BF616A', dim: '#4C566A',
    text: '#ECEFF4', codeBg: '#2E3440', codeFg: '#ECEFF4',
    inputBorder: 'cyan',
    bannerGradient: ['#81A1C1', '#88C0D0', '#A3BE8C'], // steel blue → frost → sage
  },
  // Editor-style palette modelled after the user's reference screenshot:
  // lavender bullets, pink keywords, cyan types, gold strings/numbers,
  // peach function calls, gray italic comments. Splits syntax colours from
  // UI palette via the optional syn* slots so `+` markers can stay green
  // while strings get their own gold instead of also being green.
  code: {
    primary: '#B1B9F9',     // lavender bullets
    accent: '#FF6B80',      // pink/coral — UI accents (errors, etc)
    success: '#4EBA65',     // bright green — `+` markers, success
    warning: '#FFC107',     // amber — UI warnings
    danger: '#FF5555',      // red
    dim: '#6B7280',         // muted gray
    text: '#E8E8E8',        // off-white body text
    codeBg: '#0A0F30',      // deep navy — blue:green ratio ~5:1 so terminals
                            // with iffy 24-bit support don't quantize this
                            // into a teal slot. Stays muted (low total
                            // luminance) so it doesn't shout.
    codeFg: '#E8E8E8',
    inputBorder: 'cyan',
    bannerGradient: ['#B1B9F9', '#FF6B80', '#4EBA65'],
    // Syntax overrides — these decouple code colours from UI palette.
    synKeyword: '#FF6B80',  // const, return, if, =>
    synFunc:    '#D77757',  // .map(), .padStart(), function calls
    synString:  '#E8C547',  // 'foo', "bar", template strings
    synNumber:  '#E8C547',  // 60, 100, 140, regex literals
    synType:    '#88C0D0',  // String, Number, custom types
    synComment: '#6B7280',  // // line comments, /* block */
  },
};

function active(): Palette {
  const s = loadSettings();
  return PALETTES[s.theme] || PALETTES.default;
}

/** All registered theme names — used by /theme validation so the slash
 *  command stays in sync with the palette registry automatically. */
export function themeNames(): string[] { return Object.keys(PALETTES); }

// Getter-style exports so colours update after `/restart` when settings reload.
export function primary(s: string): string { return chalk.hex(active().primary)(s); }
export function accent(s: string): string { return chalk.hex(active().accent)(s); }
export function success(s: string): string { return chalk.hex(active().success)(s); }
export function warning(s: string): string { return chalk.hex(active().warning)(s); }
export function danger(s: string): string { return chalk.hex(active().danger)(s); }
export function dim(s: string): string { return chalk.hex(active().dim)(s); }
export function text(s: string): string { return chalk.hex(active().text)(s); }
export function codespan(s: string): string {
  const p = active();
  return chalk.bgHex(p.codeBg).hex(p.codeFg)(s);
}

/**
 * Map of `/color` keywords → Ink-compatible colour names. Ink understands
 * its own basic palette ('red', 'blue', …) plus hex strings; we only use
 * named colours here so the input border looks right whether the terminal
 * is 256-colour or truecolor.
 */
const CHAT_COLOR_PALETTE: Record<string, string> = {
  red: 'red',
  blue: 'blue',
  green: 'green',
  yellow: 'yellow',
  // Ink doesn't ship a `purple` alias — `magenta` is the canonical name.
  purple: 'magenta',
  // Ink has no `orange`; #FF8800 reads close to orange in 256-colour terminals.
  orange: '#FFA500',
  // Ink has no `pink`; bright magenta is the closest named slot.
  pink: '#FF69B4',
  cyan: 'cyan',
  magenta: 'magenta',
  white: 'white',
  gray: 'gray',
};

export function chatColorNames(): string[] {
  return ['default', ...Object.keys(CHAT_COLOR_PALETTE)];
}

/**
 * Ink Text colour prop for the chat input border + bar accents.
 * Honours the user's `/color` override when set; falls back to the active
 * theme's `inputBorder` slot otherwise.
 */
export function inputBorderColor(): string {
  const s = loadSettings();
  const override = (s.chatColor || 'default').toLowerCase();
  if (override !== 'default' && CHAT_COLOR_PALETTE[override]) {
    return CHAT_COLOR_PALETTE[override];
  }
  return active().inputBorder;
}

// Hex accessors for components that build their own chalk chains.
export function colors(): Palette { return { ...active() }; }
