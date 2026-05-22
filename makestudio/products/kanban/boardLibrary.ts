/**
 * Board library — desktop's "vault" of independent SQLite board files.
 *
 * Each entry is one `.sqlite` file containing exactly one board's schema
 * (the file IS the board). The library is just a registry pointing at
 * those files; the actual data lives in each file.
 *
 *   <userData>/
 *     library.json          ← this registry
 *     desktop-secret.json   ← encrypted JWT_SECRET + admin creds
 *     boards/
 *       <uuid>.sqlite       ← default location for managed files
 *     <user-chosen path>.sqlite  ← files opened/imported from anywhere
 */
import { app } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface BoardLibraryEntry {
  id: string;
  name: string;
  filePath: string;
  lastOpened: string | null;
  createdAt: string;
}

interface LibraryFile {
  version: 1;
  boards: BoardLibraryEntry[];
  activeBoardId: string | null;
}

function libraryFile(): string {
  return path.join(app.getPath('userData'), 'library.json');
}

function defaultBoardsDir(): string {
  const dir = path.join(app.getPath('userData'), 'boards');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readLibrary(): LibraryFile {
  try {
    const raw = fs.readFileSync(libraryFile(), 'utf-8');
    const parsed = JSON.parse(raw) as LibraryFile;
    if (parsed.version === 1 && Array.isArray(parsed.boards)) return parsed;
  } catch {
    // missing / corrupt — start fresh
  }
  return { version: 1, boards: [], activeBoardId: null };
}

function writeLibrary(lib: LibraryFile): void {
  fs.writeFileSync(libraryFile(), JSON.stringify(lib, null, 2), { mode: 0o600 });
}

export function list(): BoardLibraryEntry[] {
  return readLibrary().boards.slice().sort((a, b) => {
    const aTs = a.lastOpened ? Date.parse(a.lastOpened) : 0;
    const bTs = b.lastOpened ? Date.parse(b.lastOpened) : 0;
    return bTs - aTs;
  });
}

export function getActive(): BoardLibraryEntry | null {
  const lib = readLibrary();
  if (!lib.activeBoardId) return null;
  return lib.boards.find((b) => b.id === lib.activeBoardId) ?? null;
}

export function setActive(id: string): BoardLibraryEntry | null {
  const lib = readLibrary();
  const entry = lib.boards.find((b) => b.id === id);
  if (!entry) return null;
  entry.lastOpened = new Date().toISOString();
  lib.activeBoardId = id;
  writeLibrary(lib);
  return entry;
}

/** Create a new managed .sqlite file under userData. The backend will
 *  populate its schema on first boot via TypeORM `synchronize`. */
export function create(name: string): BoardLibraryEntry {
  const lib = readLibrary();
  const id = crypto.randomUUID();
  const filePath = path.join(defaultBoardsDir(), `${id}.sqlite`);
  const entry: BoardLibraryEntry = {
    id,
    name: name.trim() || 'Novo board',
    filePath,
    lastOpened: null,
    createdAt: new Date().toISOString(),
  };
  lib.boards.push(entry);
  writeLibrary(lib);
  return entry;
}

/** Register an existing .sqlite file (e.g. opened from Dropbox). */
export function importFile(filePath: string, name?: string): BoardLibraryEntry {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const lib = readLibrary();
  const already = lib.boards.find((b) => b.filePath === filePath);
  if (already) return already;
  const entry: BoardLibraryEntry = {
    id: crypto.randomUUID(),
    name: name?.trim() || path.basename(filePath, path.extname(filePath)),
    filePath,
    lastOpened: null,
    createdAt: new Date().toISOString(),
  };
  lib.boards.push(entry);
  writeLibrary(lib);
  return entry;
}

export function rename(id: string, name: string): BoardLibraryEntry | null {
  const lib = readLibrary();
  const entry = lib.boards.find((b) => b.id === id);
  if (!entry) return null;
  entry.name = name.trim() || entry.name;
  writeLibrary(lib);
  return entry;
}

/** Drop from the library. `deleteFile` also unlinks the .sqlite — use
 *  with care; the user loses all data in that file. */
export function remove(id: string, deleteFile = false): boolean {
  const lib = readLibrary();
  const idx = lib.boards.findIndex((b) => b.id === id);
  if (idx === -1) return false;
  const [entry] = lib.boards.splice(idx, 1);
  if (lib.activeBoardId === id) lib.activeBoardId = null;
  writeLibrary(lib);
  if (deleteFile) {
    try {
      fs.unlinkSync(entry.filePath);
    } catch {
      // already gone — fine
    }
  }
  return true;
}
