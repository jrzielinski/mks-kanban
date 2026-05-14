# MKS Kanban

Kanban standalone — web app, Electron desktop, and NestJS backend.

## Structure

```
mks-kanban/
├── backend/    NestJS API (port 3100) — JWT shared with MakeStudio
├── frontend/   Vite + React web app (port 3022)
└── desktop/    Electron wrapper consuming frontend/dist
```

## Quick start

### Backend
```bash
cd backend
cp .env.example .env   # fill in DATABASE_URL and JWT_SECRET
npm install
npm run migration:run
npm run start:dev
```

### Frontend
```bash
cd frontend
npm install
npm run dev            # http://localhost:3022
```

### Desktop (dev)
```bash
cd frontend && npm run build   # build renderer first
cd ../desktop && npm install
npx tsc -p tsconfig.json       # compile main process
npx electron --no-sandbox .
```

### Release
Push a tag `kanban-v*` to trigger the GitHub Actions release workflow.
