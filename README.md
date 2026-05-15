# MKS Kanban

Kanban standalone. One codebase, two builds:

- **Web** — Postgres-backed, multi-user. One Docker container serves UI + API on a single port.
- **Desktop** — Electron app that **embeds the backend** as a child process.
  Each board is its own portable `.sqlite` file in a managed library; zero
  infra on the user's machine.

```
mks-kanban/
├── backend/    NestJS (Postgres web · SQLite desktop) — JWT auth + serves the React app
├── frontend/   Vite + React — SPA, talks to /api/v1 same-origin
├── desktop/    Electron — forks the backend, manages the board library
├── Dockerfile  multi-stage: builds frontend + backend → single runtime image
└── docker-compose.yml  kanban + postgres
```

## Quick start (web — single container)

```bash
cp backend/.env.example .env             # set JWT_SECRET, POSTGRES_PASSWORD
docker compose up --build
# → http://localhost:3100  (UI + API + WebSocket on one port)
```

First boot seeds an admin (`admin@kanban.local` / `admin123`). Override with
`SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` in the env. **Change the
default password.**

## Quick start (web — local dev, two ports)

```bash
npm run install:all                      # backend + frontend + desktop
npm run dev:backend                      # nest start --watch on :3100
npm run dev:frontend                     # vite on :3022 (proxies /api to :3100)
```

You'll need Postgres reachable at `DATABASE_URL` (or switch with `DB_DRIVER=sqlite`
for a fully local single-file run — same code path, just no shared DB).

## Quick start (desktop)

```bash
cd desktop
bash scripts/pack-kanban.sh              # builds frontend + backend, rebuilds
                                         # native modules for Electron, packs
                                         # platform installer into ../bin/
```

For an unpackaged run:

```bash
npm run install:all
cd desktop && npm run dev                # builds everything then launches Electron
```

The Electron shell:

1. Picks (or creates) an active board file under `<userData>/boards/<id>.sqlite`.
2. Forks the NestJS backend (via `ELECTRON_RUN_AS_NODE`) pointed at that file.
3. Polls `/api/v1/health`, then auto-logs in as the per-installation admin.
4. Loads `http://127.0.0.1:<random-port>/` — the backend serves the React app.

## Board library (desktop)

Each board is one independent `.sqlite` file. The library lives at
`<userData>/library.json` and exposes IPC handlers:

- `boardLibrary:list` / `:active` — read the registry
- `boardLibrary:create(name)` — new managed file under `<userData>/boards/`
- `boardLibrary:open(id)` — restart backend pointed at the file, re-login
- `boardLibrary:import()` — open `.sqlite` from anywhere (Dropbox, USB…)
- `boardLibrary:rename` / `:remove` — registry ops

Only one board is open at a time — cross-board features (workspaces,
"move card to board", inter-board links) are export/import operations in
this build.

## Configuration

Everything is in `backend/.env` — see `backend/.env.example`.

| Env | Purpose |
|---|---|
| `DB_DRIVER` | `postgres` (web) or `sqlite` (desktop) — default `postgres` |
| `DATABASE_URL` | Postgres connection (when `DB_DRIVER=postgres`) |
| `DATABASE_PATH` | Path to the SQLite file (when `DB_DRIVER=sqlite`) |
| `JWT_SECRET` | Random hex, signs JWTs |
| `SEED_ADMIN_EMAIL` / `_PASSWORD` | First-time admin (auto-seeded if users table is empty) |
| `FRONTEND_DIST` | Override path to the built React app (defaults to `../frontend/dist`) |
| `PORT` | Backend port (default 3100) |
| `SMTP_*`, `MAIL_FROM` | Optional mailer — unset = sends are dry-run-logged |

## Release

Push a tag `kanban-v*` to trigger the GitHub Actions release workflow.
