import { defineConfig, loadEnv, Plugin } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { resolve } from 'path';

/**
 * Rewrites every non-asset request to `kanban-app.html` so React Router
 * handles navigation inside the kanban product. Mirrors the same pattern
 * used by `vite.flow-only.config.ts` for the flow product.
 */
function kanbanAppFallbackPlugin(): Plugin {
  return {
    name: 'kanban-app-spa-fallback',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url || '/';
        const skip =
          url.startsWith('/@') ||
          url.startsWith('/node_modules') ||
          url.startsWith('/__vite') ||
          url.startsWith('/src/') ||
          url.startsWith('/api') ||
          url.startsWith('/socket.io') ||
          url.startsWith('/components.json') ||
          /\.[a-zA-Z0-9]+(?:\?|$)/.test(url);
        if (!skip) {
          req.url = '/index.html';
        }
        next();
      });
    },
  };
}

/**
 * MakeStudio Kanban — slim renderer build.
 *
 * Builds ONLY the kanban product: boards list (KanbanBoardsPage) +
 * board canvas (KanbanBoardPage) + their immediate dependencies.
 * Does NOT mount Flow Builder, Business Apps, Dark Factory, or other
 * makestudio surfaces.
 *
 * Entry: `kanban-app.html` → `src/kanban-app/main.tsx` → `KanbanApp`.
 * Output: `dist-kanban-app/` — consumed by electron-builder as
 *   extraResources so the packaged Electron app can load it via file://.
 *
 * `base: './'` in production makes all asset paths relative, which is
 * required for correct resolution under `file://` in the packaged app.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Dev proxy target — the local NestJS backend by default. Override with
  // VITE_API_URL only when you really need to point at a remote API.
  const apiUrl = env.VITE_API_URL || 'http://localhost:3100';
  const isProd = mode === 'production';
  // Base path: '/' for the web build (backend serves it from root) and
  // './' for Electron (loaded via file://). Override with VITE_BASE.
  const base = env.VITE_BASE || (isProd ? '/' : '/');
  return {
    base,
    plugins: [react(), kanbanAppFallbackPlugin()],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    server: {
      port: 3022,
      strictPort: true,
      host: '0.0.0.0',
      proxy: {
        '/api': { target: apiUrl, changeOrigin: true, secure: false },
        '/socket.io': { target: apiUrl, changeOrigin: true, ws: true, secure: false },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
  };
});
