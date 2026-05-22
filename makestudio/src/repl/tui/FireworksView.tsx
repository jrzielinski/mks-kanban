/**
 * FireworksView — fullscreen ASCII fireworks easter egg.
 *
 * Same rendering technique as MatrixView / FireView: bypass Ink, paint
 * via direct stdout writes inside the alt-screen buffer.
 *
 * Particle simulation:
 *   - Every LAUNCH_MS a "rocket" spawns at the bottom and rises with
 *     negative vy. After a random altitude (or when vy falls towards 0)
 *     it explodes into PARTICLE_COUNT particles with random radial
 *     velocity. Particles obey gravity, fade over time, and drop a
 *     dim trail glyph behind them.
 *   - Up to MAX_FIREWORKS active at once. Older fireworks self-prune
 *     when all their particles fall off-screen or fade to black.
 *
 * ESC / Enter / Ctrl+C closes.
 */
import * as React from 'react';
import { Box, useInput, useStdin } from 'ink';

const FRAME_MS = 50;
const LAUNCH_MS = 800;
const MAX_FIREWORKS = 5;
const PARTICLE_COUNT = 40;
const GRAVITY = 0.06;
const PARTICLE_LIFE = 60;          // frames
const ROCKET_GLYPH = '|';
const TRAIL_GLYPH = '.';

// 256-colour palettes — each firework picks one at launch.
const PALETTES: number[][] = [
  [196, 202, 208, 214, 220, 226],   // red → yellow
  [21, 27, 33, 39, 45, 51, 87],     // deep blue → cyan
  [201, 165, 129, 93, 57],          // pink → magenta → purple
  [46, 82, 118, 154, 190, 226],     // green → yellow
  [231, 230, 229, 228, 227, 226],   // white → pale yellow
  [196, 199, 202, 205, 208, 211],   // red → pink → orange
];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  glyph: string;
  trail: Array<{ x: number; y: number; age: number }>;
}

interface Rocket {
  x: number;
  y: number;
  vy: number;
  targetY: number;
  exploded: boolean;
  particles: Particle[];
  palette: number[];
  trailFrames: Array<{ x: number; y: number; frame: number }>;
}

const PARTICLE_GLYPHS = ['*', '+', '·', '°', '✦', '✧', 'o', '.'];
function pickGlyph(): string { return PARTICLE_GLYPHS[Math.floor(Math.random() * PARTICLE_GLYPHS.length)]; }
function pickPalette(): number[] { return PALETTES[Math.floor(Math.random() * PALETTES.length)]; }

function newRocket(cols: number, rows: number): Rocket {
  // Launch from a random column near the centre 80% of the screen.
  const margin = Math.floor(cols * 0.1);
  const x = margin + Math.floor(Math.random() * (cols - margin * 2));
  // Explode somewhere in the upper third of the screen.
  const targetY = 2 + Math.floor(Math.random() * Math.max(1, rows / 3));
  return {
    x,
    y: rows - 1,
    vy: -1.0 - Math.random() * 0.6,
    targetY,
    exploded: false,
    particles: [],
    palette: pickPalette(),
    trailFrames: [],
  };
}

function explode(r: Rocket): void {
  r.exploded = true;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const angle = (i / PARTICLE_COUNT) * Math.PI * 2 + Math.random() * 0.2;
    const speed = 0.6 + Math.random() * 1.0;
    r.particles.push({
      x: r.x,
      y: r.y,
      vx: Math.cos(angle) * speed * 1.8,    // x-direction faster: terminal cells are taller than wide
      vy: Math.sin(angle) * speed,
      age: 0,
      glyph: pickGlyph(),
      trail: [],
    });
  }
}

export function FireworksView({ onClose }: { onClose: () => void }): React.ReactElement {
  useInput((input, key) => {
    if (key.escape || key.return || (key.ctrl && input === 'c')) onClose();
  });
  useStdin();

  React.useEffect(() => {
    const out = process.stdout;
    const cols = out.columns || 80;
    const rows = out.rows || 24;
    const drawRows = Math.max(1, rows - 1);

    const fireworks: Rocket[] = [];
    let launchTimer = 0;

    // Frame buffer reused per tick — { glyph, palette-idx } per cell.
    const fb: Array<{ ch: string; col: number } | null> = new Array(cols * drawRows).fill(null);

    const HOME = '\x1b[H';
    const RST = '\x1b[0m';

    const id = setInterval(() => {
      // ── Launch ──────────────────────────────────────────────
      launchTimer += FRAME_MS;
      if (launchTimer >= LAUNCH_MS && fireworks.length < MAX_FIREWORKS) {
        launchTimer = 0;
        fireworks.push(newRocket(cols, drawRows));
      }

      // ── Update ──────────────────────────────────────────────
      for (const r of fireworks) {
        if (!r.exploded) {
          // Rocket rising
          r.trailFrames.push({ x: r.x, y: r.y, frame: 0 });
          r.y += r.vy;
          // Slow down as we approach apex
          r.vy += 0.02;
          if (r.y <= r.targetY || r.vy >= 0) explode(r);
        } else {
          // Particles
          for (const p of r.particles) {
            // Trail trail (bounded length)
            if (p.age % 2 === 0) p.trail.push({ x: p.x, y: p.y, age: 0 });
            if (p.trail.length > 4) p.trail.shift();
            p.x += p.vx;
            p.y += p.vy;
            p.vy += GRAVITY;
            p.age += 1;
            for (const t of p.trail) t.age += 1;
          }
          // Prune dead particles
          r.particles = r.particles.filter(p =>
            p.age < PARTICLE_LIFE && p.y < drawRows && p.x >= 0 && p.x < cols);
        }
        // Trail age for rocket trail dots
        for (const t of r.trailFrames) t.frame += 1;
        r.trailFrames = r.trailFrames.filter(t => t.frame < 8);
      }
      // Prune dead fireworks
      for (let i = fireworks.length - 1; i >= 0; i--) {
        const r = fireworks[i];
        if (r.exploded && r.particles.length === 0) fireworks.splice(i, 1);
      }

      // ── Render ──────────────────────────────────────────────
      fb.fill(null);
      for (const r of fireworks) {
        // Rocket trail (dim white)
        for (const t of r.trailFrames) {
          const ix = Math.floor(t.x);
          const iy = Math.floor(t.y);
          if (iy >= 0 && iy < drawRows && ix >= 0 && ix < cols) {
            fb[iy * cols + ix] = { ch: TRAIL_GLYPH, col: 244 - t.frame * 4 };
          }
        }
        if (!r.exploded) {
          const ix = Math.floor(r.x);
          const iy = Math.floor(r.y);
          if (iy >= 0 && iy < drawRows && ix >= 0 && ix < cols) {
            fb[iy * cols + ix] = { ch: ROCKET_GLYPH, col: 231 };
          }
        } else {
          for (const p of r.particles) {
            // Particle trail (older = dimmer palette index)
            for (const t of p.trail) {
              const ix = Math.floor(t.x);
              const iy = Math.floor(t.y);
              if (iy >= 0 && iy < drawRows && ix >= 0 && ix < cols) {
                const palIdx = Math.max(0, Math.min(r.palette.length - 1, r.palette.length - 1 - Math.floor(t.age / 3)));
                fb[iy * cols + ix] = { ch: '·', col: r.palette[palIdx] };
              }
            }
            // Particle head — palette colour shifts darker with age
            const lifeRatio = p.age / PARTICLE_LIFE;
            const palIdx = Math.max(0, Math.min(r.palette.length - 1, Math.floor((1 - lifeRatio) * (r.palette.length - 1))));
            const ix = Math.floor(p.x);
            const iy = Math.floor(p.y);
            if (iy >= 0 && iy < drawRows && ix >= 0 && ix < cols) {
              fb[iy * cols + ix] = { ch: p.glyph, col: r.palette[palIdx] };
            }
          }
        }
      }

      // Compose into a single string and emit one write.
      let frame = HOME;
      for (let y = 0; y < drawRows; y++) {
        let line = '';
        let lastColour = -1;
        for (let x = 0; x < cols; x++) {
          const cell = fb[y * cols + x];
          if (!cell) {
            if (lastColour !== 0) { line += RST; lastColour = 0; }
            line += ' ';
            continue;
          }
          if (cell.col !== lastColour) {
            line += `\x1b[38;5;${cell.col}m`;
            lastColour = cell.col;
          }
          line += cell.ch;
        }
        frame += line + RST + '\x1b[K\n';
      }
      frame += '\x1b[2;90m  ESC / Enter / Ctrl+C to wrap up the show\x1b[0m\x1b[K';
      out.write(frame);
    }, FRAME_MS);

    return () => {
      clearInterval(id);
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const inst = (global as any).__makestudio_inkInstance;
        inst?.clear?.();
      } catch { /* */ }
      out.write('\x1b[?1049l');
    };
  }, []);

  return <Box />;
}
