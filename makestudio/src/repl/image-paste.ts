import { swallow } from '../utils/log';
/**
 * image-paste.ts — read images from the system clipboard + detect dragged
 * image paths in user input. Port of Claude Code's clipboard-image pipeline
 * (hooks/usePasteHandler.ts + utils/clipboard).
 *
 * Three ingress paths:
 *   1. Explicit: user types `/paste` — we try to read an image from the OS
 *      clipboard via platform tools.
 *   2. Dragged file: the user drops an image onto the terminal; most shells
 *      surface that as a quoted file path in the input line. We detect
 *      strings that resolve to existing image files.
 *   3. Bracketed paste of base64 data — some terminals (iTerm) emit PNG
 *      data-URLs directly. The `@image:<data-uri>` prefix marker is honoured
 *      as a fallback for explicit inline paste.
 *
 * Output shape for all three: a saved PNG file in
 * `~/.makestudio/attachments/img-<ts>.png` plus a token string the caller
 * swaps into the message text: `[Image #N] file://...`.
 * `attachments.ts` already tracks this numbering scheme for text pastes;
 * we extend the same registry with a `mime: 'image/png'|'image/jpeg'` field.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

// Ephemeral: tmpdir so long-running users don't accumulate GB of pasted
// screenshots in $HOME. On macOS/Linux/Windows the OS reclaims tmpdir on
// its own schedule; we also sweep files older than 24h on each ensureDir()
// as belt-and-suspenders.
const ATTACH_DIR = path.join(os.tmpdir(), 'makestudio-images');
const ATTACH_TTL_MS = 24 * 60 * 60 * 1000;
export const IMAGE_PLACEHOLDER_RX = /\[Image #(\d+)\]/g;

// Track paste id counter here (independent of text attachments registry —
// images render as API content blocks, not paste references).
let imageCounter = 0;
let attachedImages: Array<{ id: number; path: string; mime: string; bytes: number }> = [];

function ensureDir() {
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  // Opportunistic cleanup — cheap enough to run every paste.
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(ATTACH_DIR)) {
      const p = path.join(ATTACH_DIR, name);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > ATTACH_TTL_MS) fs.unlinkSync(p);
      } catch (err) { swallow(err); }
    }
  } catch (err) { swallow(err); }
}

export interface AttachedImage {
  id: number;
  path: string;
  mime: string;
  bytes: number;
}

export function listAttachedImages(): AttachedImage[] { return [...attachedImages]; }
export function clearAttachedImages(): void { attachedImages = []; imageCounter = 0; }

/**
 * Save a raw image buffer as an attachment. Returns the token to insert
 * into the user message. Callers render it as a fenced link so the model
 * sees an explicit image reference.
 */
export function attachImageBuffer(buf: Buffer, mime: string = 'image/png'): AttachedImage {
  ensureDir();
  imageCounter++;
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/gif' ? 'gif' : mime === 'image/webp' ? 'webp' : 'png';
  const file = path.join(ATTACH_DIR, `img-${Date.now()}-${imageCounter}.${ext}`);
  fs.writeFileSync(file, buf);
  const rec: AttachedImage = { id: imageCounter, path: file, mime, bytes: buf.length };
  attachedImages.push(rec);
  return rec;
}

/**
 * Copy an existing image file into the attachments dir (canonical location
 * so it survives across sessions + paths relocate). Returns the attachment.
 * Used when the user drags a file into the terminal — the original may
 * disappear if they clean up ~/Downloads; copying now anchors it.
 */
export function attachImageFile(srcPath: string): AttachedImage | null {
  try {
    const abs = path.resolve(srcPath);
    if (!fs.existsSync(abs)) return null;
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return null;
    const ext = path.extname(abs).toLowerCase().slice(1);
    const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
      : ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : ext === 'png' ? 'image/png'
      : null;
    if (!mime) return null;
    // Cap at 10MB — larger images need resizing, which the backend/provider
    // does during upload. Just refuse outright so the user fixes it upstream.
    if (stat.size > 10 * 1024 * 1024) return null;
    const buf = fs.readFileSync(abs);
    return attachImageBuffer(buf, mime);
  } catch { return null; }
}

/**
 * Read an image from the OS clipboard, if any. Returns the saved attachment
 * or null when: (a) clipboard has no image, (b) helper tool missing, (c) IO
 * fails. Platform tools:
 *
 *   macOS   — `pngpaste` (brew install pngpaste). Prints PNG bytes to stdout.
 *             macOS's `pbpaste` does not handle binary clipboard content.
 *   Linux   — `xclip -selection clipboard -t image/png -o` (X11) or
 *             `wl-paste -t image/png` (Wayland).
 *   Windows — PowerShell `Get-Clipboard -Format Image` + save to a temp
 *             PNG file (piping binary through stdout is brittle on Win).
 *
 * Non-fatal if the helper is missing — the function just returns null and
 * the caller renders a helpful install hint.
 */
export function readClipboardImage(): { ok: true; attached: AttachedImage } | { ok: false; reason: string } {
  ensureDir();
  const platform = os.platform();

  if (platform === 'darwin') {
    // Fast path: pngpaste if present (pipes PNG bytes to stdout, no temp file).
    const r = spawnSync('pngpaste', ['-'], { timeout: 5_000, maxBuffer: 20 * 1024 * 1024 });
    if (!r.error && r.status === 0 && r.stdout && r.stdout.length > 0) {
      return { ok: true, attached: attachImageBuffer(r.stdout, 'image/png') };
    }
    // Fallback: AppleScript with «class PNGf». Works on stock macOS without
    // any brew install — writes the clipboard image to a temp file, we read
    // it back. Slower (~200ms vs ~20ms for pngpaste) but zero dependencies.
    const tmp = path.join(os.tmpdir(), `mak-clip-${Date.now()}.png`);
    const script =
      `try\n` +
      `  set theImage to (the clipboard as «class PNGf»)\n` +
      `  set theFile to (open for access (POSIX file "${tmp}") with write permission)\n` +
      `  write theImage to theFile\n` +
      `  close access theFile\n` +
      `  return "ok"\n` +
      `on error errMsg\n` +
      `  return "err: " & errMsg\n` +
      `end try`;
    const osa = spawnSync('osascript', ['-e', script], { timeout: 10_000 });
    if (osa.status === 0 && /^ok/.test(String(osa.stdout || '').trim())) {
      try {
        const buf = fs.readFileSync(tmp);
        try { fs.unlinkSync(tmp); } catch (err) { swallow(err); }
        if (buf.length > 0) return { ok: true, attached: attachImageBuffer(buf, 'image/png') };
      } catch (err) { swallow(err); }
    }
    return { ok: false, reason: 'no image on clipboard (try Cmd+Ctrl+Shift+4 to capture to clipboard, then /paste)' };
  }

  if (platform === 'linux') {
    // Try Wayland first (newer), fall back to X11.
    const wl = spawnSync('wl-paste', ['-t', 'image/png'], { timeout: 5_000, maxBuffer: 20 * 1024 * 1024 });
    if (!wl.error && wl.status === 0 && wl.stdout?.length > 0) {
      return { ok: true, attached: attachImageBuffer(wl.stdout, 'image/png') };
    }
    const xc = spawnSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { timeout: 5_000, maxBuffer: 20 * 1024 * 1024 });
    if (!xc.error && xc.status === 0 && xc.stdout?.length > 0) {
      return { ok: true, attached: attachImageBuffer(xc.stdout, 'image/png') };
    }
    return { ok: false, reason: 'no image on clipboard (install `wl-clipboard` or `xclip` to enable)' };
  }

  if (platform === 'win32') {
    // PowerShell can save the clipboard image to a file. We ask it to write
    // to a temp path then read back — avoids binary-over-stdin-encoding
    // problems on Windows cmd.
    const tmp = path.join(os.tmpdir(), `mak-clip-${Date.now()}.png`);
    const ps = spawnSync('powershell', [
      '-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; ` +
      `$img = [Windows.Forms.Clipboard]::GetImage(); ` +
      `if ($img -ne $null) { $img.Save('${tmp.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png); exit 0 } else { exit 1 }`,
    ], { timeout: 10_000 });
    if (ps.status !== 0) return { ok: false, reason: 'no image on clipboard' };
    try {
      const buf = fs.readFileSync(tmp);
      try { fs.unlinkSync(tmp); } catch (err) { swallow(err); }
      return { ok: true, attached: attachImageBuffer(buf, 'image/png') };
    } catch (e: any) {
      return { ok: false, reason: `PowerShell saved file but read failed: ${e.message}` };
    }
  }

  return { ok: false, reason: `unsupported platform: ${platform}` };
}

/**
 * Scan free-form text for dragged image paths — the terminal quotes them
 * when the user drops a file onto the input line. We detect:
 *   - Quoted or unquoted paths ending in .png/.jpg/.jpeg/.gif/.webp
 *   - Paths on macOS Desktop (drag source for screenshots)
 *   - Windows C:\... paths with image extensions
 *
 * Returns the modified text (paths replaced with [Image #N] markers) plus
 * the list of attachments. Caller appends the attachments to the
 * outgoing message as content blocks.
 */
export function detectImagePathsInText(input: string): { text: string; attached: AttachedImage[] } {
  const attached: AttachedImage[] = [];
  // Matches:
  //   'file with spaces/shot.png'
  //   /Users/foo/Desktop/Screenshot 2026-04-21 at 10.32.41.png
  //   C:\Users\foo\Pictures\sample.jpg
  //   ~/Downloads/foo.gif
  const rx = /(?:'([^']+\.(?:png|jpe?g|gif|webp))'|"([^"]+\.(?:png|jpe?g|gif|webp))"|(\S*\/[^\s]+\.(?:png|jpe?g|gif|webp))|([A-Za-z]:\\[^\n]+?\.(?:png|jpe?g|gif|webp)))(?=$|[\s,.?!:;])/gi;
  let out = input;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = rx.exec(input)) !== null) {
    const raw = m[1] || m[2] || m[3] || m[4];
    if (!raw) continue;
    let p = raw;
    if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
    if (seen.has(p)) continue;
    seen.add(p);
    const att = attachImageFile(p);
    if (!att) continue;
    attached.push(att);
    // Replace the raw match inline with the marker (no nested quotes)
    out = out.split(raw).join(`[Image #${att.id}]`);
  }
  return { text: out, attached };
}

/**
 * Convert a list of attachments into the content-block array an Anthropic/
 * OpenAI-compatible message expects. Reads the files back + base64-encodes
 * on the way out. Caller appends to the user message's `content` array.
 */
export function imagesToContentBlocks(attached: AttachedImage[]): any[] {
  const blocks: any[] = [];
  for (const a of attached) {
    try {
      const buf = fs.readFileSync(a.path);
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: a.mime, data: buf.toString('base64') },
      });
    } catch (err) { swallow(err); }
  }
  return blocks;
}
