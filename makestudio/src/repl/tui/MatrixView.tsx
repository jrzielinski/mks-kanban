/**
 * MatrixView — fullscreen Matrix-rain easter egg.
 *
 * Bypasses Ink for the actual rendering: useEffect installs a setInterval
 * that writes ANSI directly to stdout. Avoids React reconciliation +
 * log-update repaints which were causing flicker. The component itself
 * renders nothing visible — Ink just sees an empty <Box> while we paint
 * the alt-screen buffer underneath.
 *
 * Press ESC / Enter / Ctrl+C to leave.
 */
import * as React from 'react';
import { Box, useInput, useStdin } from 'ink';

const FRAME_MS = 80;

const CHARS = (() => {
  const out: string[] = [];
  // Half-width Katakana for the iconic look.
  for (let c = 0xff66; c <= 0xff9d; c++) out.push(String.fromCharCode(c));
  for (let c = 0x30; c <= 0x39; c++) out.push(String.fromCharCode(c));
  for (let c = 0x41; c <= 0x5a; c++) out.push(String.fromCharCode(c));
  for (const s of '+-*<>?/={}[]|') out.push(s);
  return out;
})();
function pick(): string { return CHARS[Math.floor(Math.random() * CHARS.length)]; }

interface Drop { y: number; len: number; speed: number; ticks: number; glyphs: string[] }
function newDrop(rows: number): Drop {
  return {
    y: -Math.floor(Math.random() * rows),
    len: 6 + Math.floor(Math.random() * Math.max(1, Math.floor(rows / 2))),
    speed: 1 + Math.floor(Math.random() * 3),
    ticks: 0,
    glyphs: [],
  };
}

export function MatrixView({ onClose }: { onClose: () => void }): React.ReactElement {
  // Capture stdin so Ink keeps raw mode while we own the screen — without
  // this, ESC may not be delivered.
  useInput((input, key) => {
    if (key.escape || key.return || (key.ctrl && input === 'c')) onClose();
  });

  // Force Ink not to render anything in this tree by holding stdin reference.
  useStdin();

  React.useEffect(() => {
    const out = process.stdout;
    const cols = out.columns || 80;
    const rows = out.rows || 24;
    // Alt-screen entry happens in the slash-command handler — by the
    // time this useEffect runs, Ink has already committed the empty
    // tree and we're already inside alt-screen. We just need to make
    // sure the buffer is clean (slash-handler did `\\x1b[2J\\x1b[H`).

    const drops: Drop[] = Array.from({ length: cols }, () => newDrop(rows));
    const drawRows = Math.max(1, rows - 1);

    // ANSI colour stops (head→tail).
    const HEAD = '\x1b[97m';
    const BODY = '\x1b[92m';
    const TAIL = '\x1b[32m';
    const DIM  = '\x1b[2;32m';
    const RST  = '\x1b[0m';
    const HOME = '\x1b[H';

    // Render frame buffer line-by-line. We move the cursor home, then write
    // each row. Terminal scrolls only at the very bottom — using cursor
    // positioning per line avoids that.
    const id = setInterval(() => {
      // Advance drops.
      for (const d of drops) {
        d.ticks += 1;
        if (d.ticks < d.speed) continue;
        d.ticks = 0;
        d.y += 1;
        d.glyphs.unshift(pick());
        if (d.glyphs.length > d.len) d.glyphs.length = d.len;
        if (d.y - d.len > rows) Object.assign(d, newDrop(rows));
      }

      // Build the entire frame as one string then write once — single
      // syscall, no partial flush flicker.
      let frame = HOME;
      for (let r = 0; r < drawRows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
          const d = drops[c];
          const idx = d.y - r;
          if (idx < 0 || idx >= d.glyphs.length) {
            line += ' ';
            continue;
          }
          const ch = d.glyphs[idx] || ' ';
          let colour: string;
          if (idx === 0) colour = HEAD;
          else if (idx < 2) colour = BODY;
          else if (idx < d.len * 0.6) colour = TAIL;
          else colour = DIM;
          line += colour + ch;
        }
        // \x1b[K erases to end of line so leftover chars from the prev
        // frame don't bleed when our line is shorter than `cols`.
        frame += line + RST + '\x1b[K\n';
      }
      // Last row: wake-up hint, dimmed.
      frame += '\x1b[2;90m  ESC / Enter / Ctrl+C to wake up\x1b[0m\x1b[K';
      out.write(frame);
    }, FRAME_MS);

    return () => {
      clearInterval(id);
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const inst = (global as any).__makestudio_inkInstance;
        inst?.clear?.();
      } catch { /* */ }
      // Leave alt-screen ONLY — do NOT re-show the cursor (no `\x1b[?25h`).
      // Ink already manages cursor visibility for the InputBox; if we
      // re-enable the terminal cursor here, it shows up as a SECOND
      // blinking cursor on top of Ink's inverse-char fake cursor.
      out.write('\x1b[?1049l');
    };
  }, []);

  // Empty Ink tree — all painting happens via raw stdout writes above.
  return <Box />;
}
