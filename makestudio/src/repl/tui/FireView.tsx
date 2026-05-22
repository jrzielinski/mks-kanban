/**
 * FireView — fullscreen ASCII fire easter egg.
 *
 * Same technique as MatrixView: bypass Ink for rendering, paint via
 * direct stdout writes inside the terminal's alt-screen buffer.
 *
 * Algorithm: classic "Doom-style" fire simulation. A 2D heat grid where
 * the bottom row is the heat source (random hot values). Each row above
 * cools by averaging from the row below (with random horizontal jitter
 * for the rising / dancing look). Heat values map to ASCII glyphs +
 * 256-color ANSI palette.
 *
 * ESC / Enter / Ctrl+C closes.
 */
import * as React from 'react';
import { Box, useInput, useStdin } from 'ink';

const FRAME_MS = 110;

// Calm fireplace tuning — matches the asciiart.eu/animations/ascii-fire
// "Wall of Fire" preview: thin chars, mostly deep red, lots of black
// gaps in the bed, occasional yellow/white flame tips.
const FIRE_HEIGHT_RATIO = 0.32;
const EMBER_SPAWN_PROB = 0.30;
const EMBER_MAX = 18;

// Thin glyph ramp — no solid blocks. Sparse on the cool end so we
// see the dark background through the flames. The ramp is read
// left=cool → right=hot.
const GLYPHS = [' ', ' ', ' ', '.', '`', '\'', '"', ',', '-', '+', '=', '*', 'x', 'X', '#', '%'];

// 256-colour palette: heavy weighting on the deep-red / dark-red band
// (≈70% of cells should land here), small middle range, rare highlights.
// Index 0 means "show as dark space" (no colour change emitted).
const PALETTE = [
  52, 52, 88, 88, 88,            // very dark red (most embers)
  124, 124, 160, 160, 166,       // red → red-orange
  166, 172, 202, 208,            // dark orange → orange
  214, 220, 226,                 // amber → yellow (rare)
  228, 231,                      // white-ish (rarest, only at peak)
];

export function FireView({ onClose }: { onClose: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || key.return || (key.ctrl && input === 'c')) onClose();
  });
  useStdin();

  React.useEffect(() => {
    const out = process.stdout;
    const cols = out.columns || 80;
    const rows = out.rows || 24;
    const drawRows = Math.max(1, rows - 1);

    // Fire bed: only the bottom slice of the screen. Above is sky where
    // embers float. fireTop is the first row that holds heat values.
    const fireRows = Math.max(4, Math.floor(drawRows * FIRE_HEIGHT_RATIO));
    const fireTop = drawRows - fireRows;

    const HEAT_MAX = PALETTE.length - 1;
    const heat = new Uint8Array(fireRows * cols);

    // Seed bottom row with hot values; fire stabilises in a few frames.
    for (let x = 0; x < cols; x++) heat[(fireRows - 1) * cols + x] = 240;

    // Embers — one bright cell rising slowly out of the fire into the sky.
    interface Ember { x: number; y: number; vy: number; life: number; }
    const embers: Ember[] = [];

    const HOME = '\x1b[H';
    const RST = '\x1b[0m';

    // Per-column fuel pattern — some columns burn hot, some are gaps.
    // This is what produces the "spiky flames over a dark line" look
    // instead of a solid wall. Re-rolled occasionally for life.
    const fuel = new Uint8Array(cols);
    for (let x = 0; x < cols; x++) {
      const r = Math.random();
      fuel[x] = r < 0.55 ? 230 + Math.floor(Math.random() * 25)   // hot column
              : r < 0.75 ? 120 + Math.floor(Math.random() * 60)   // mid column
              : 0;                                                 // cold gap
    }
    let fuelTick = 0;
    const VISIBLE_THRESHOLD = 70;  // below this → render as black space

    const id = setInterval(() => {
      // ── 1) Slowly mutate the fuel pattern so flames migrate.
      fuelTick++;
      if (fuelTick % 6 === 0) {
        // Each tick, swap one column to a new random fuel value.
        const i = Math.floor(Math.random() * cols);
        const r = Math.random();
        fuel[i] = r < 0.55 ? 230 + Math.floor(Math.random() * 25)
               : r < 0.75 ? 120 + Math.floor(Math.random() * 60)
               : 0;
      }
      // ── 2) Refresh fuel row from the per-column fuel + jitter.
      for (let x = 0; x < cols; x++) {
        const base = fuel[x];
        const j = base > 0 ? base + Math.floor(Math.random() * 20) - 10 : 0;
        heat[(fireRows - 1) * cols + x] = Math.max(0, Math.min(255, j));
      }

      // ── 3) Propagate heat upward. Heavier cooling than before so
      //    flames die quickly and we get the spiky "tongue" shape
      //    instead of a uniform glow.
      for (let y = fireRows - 2; y >= 0; y--) {
        for (let x = 0; x < cols; x++) {
          const dx = Math.floor(Math.random() * 3) - 1;
          const sx = Math.max(0, Math.min(cols - 1, x + dx));
          const below = heat[(y + 1) * cols + sx];
          // 6..15 cool factor + extra cooling near top of bed.
          const heightFactor = Math.max(0, 6 - y);
          const cool = 6 + Math.floor(Math.random() * 9) + heightFactor;
          heat[y * cols + x] = Math.max(0, below - cool);
        }
      }

      // ── 3) Spawn embers from the top of the fire bed. They rise into
      //    the sky and fade.
      if (embers.length < EMBER_MAX && Math.random() < EMBER_SPAWN_PROB) {
        // Pick a column where the top of the bed is hot enough.
        for (let tries = 0; tries < 6; tries++) {
          const x = Math.floor(Math.random() * cols);
          if (heat[0 * cols + x] > 80) {
            embers.push({ x, y: fireTop - 0.5, vy: -0.20 - Math.random() * 0.20, life: 1 });
            break;
          }
        }
      }
      for (const e of embers) {
        e.y += e.vy;
        e.life -= 0.012;
        // Slight horizontal drift
        if (Math.random() < 0.25) e.x += Math.random() < 0.5 ? -1 : 1;
      }
      for (let i = embers.length - 1; i >= 0; i--) {
        const e = embers[i];
        if (e.life <= 0 || e.y < 0 || e.x < 0 || e.x >= cols) embers.splice(i, 1);
      }

      // ── 4) Paint frame in one write.
      let frame = HOME;
      // Sky rows: blank, possibly with embers.
      for (let y = 0; y < fireTop; y++) {
        let line = '';
        let lastColour = -1;
        // Build a row index of ember positions for this y
        const rowEmbers = embers.filter(e => Math.floor(e.y) === y);
        for (let x = 0; x < cols; x++) {
          const e = rowEmbers.find(em => Math.floor(em.x) === x);
          if (e) {
            // Map life 1→0 onto palette top range (white→amber→deep-red).
            const palIdx = Math.max(8, Math.min(PALETTE.length - 1, Math.floor(8 + e.life * (PALETTE.length - 8))));
            const colour = PALETTE[palIdx];
            if (colour !== lastColour) { line += `\x1b[38;5;${colour}m`; lastColour = colour; }
            line += '·';
            continue;
          }
          if (lastColour !== 0) { line += RST; lastColour = 0; }
          line += ' ';
        }
        frame += line + RST + '\x1b[K\n';
      }
      // Fire bed rows. Higher visibility threshold so dim cells render
      // as empty space → the spiky/sparse look from the reference.
      for (let y = 0; y < fireRows; y++) {
        let line = '';
        let lastColour = -1;
        for (let x = 0; x < cols; x++) {
          const h = heat[y * cols + x];
          if (h < VISIBLE_THRESHOLD) {
            if (lastColour !== 0) { line += RST; lastColour = 0; }
            line += ' ';
            continue;
          }
          // Map heat above threshold onto palette range. Subtract
          // threshold so the lowest visible cells use the darkest reds.
          const norm = (h - VISIBLE_THRESHOLD) / (255 - VISIBLE_THRESHOLD);
          const palIdx = Math.min(PALETTE.length - 1, Math.floor(norm * HEAT_MAX));
          const glyph = GLYPHS[Math.min(GLYPHS.length - 1, Math.floor(norm * (GLYPHS.length - 1)))];
          if (palIdx !== lastColour) {
            line += `\x1b[38;5;${PALETTE[palIdx]}m`;
            lastColour = palIdx;
          }
          line += glyph;
        }
        frame += line + RST + '\x1b[K\n';
      }
      frame += '\x1b[2;90m  ESC / Enter / Ctrl+C to put out the fire\x1b[0m\x1b[K';
      out.write(frame);
    }, FRAME_MS);

    return () => {
      clearInterval(id);
      // Reset Ink's log-update line counter WHILE STILL in alt-screen,
      // then leave so main-screen content is restored verbatim — same
      // pattern as MatrixView.
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const inst = (global as any).__makestudio_inkInstance;
        inst?.clear?.();
      } catch { /* */ }
      // Leave alt-screen only — Ink manages cursor visibility itself.
      out.write('\x1b[?1049l');
    };
  }, []);

  return <Box />;
}
