import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import * as path from 'path';

// Electron loads the renderer via file://, which doesn't support CORS.
// Vite adds crossorigin="..." to script/link tags for module integrity checks,
// but those attributes cause Chromium to reject the resources on file://.
// This plugin strips crossorigin from the generated index.html.
const removeElectronCrossorigin = {
  name: 'remove-crossorigin',
  transformIndexHtml(html: string) {
    return html
      .replace(/<script([^>]*) crossorigin([^>]*)>/g, '<script$1$2>')
      .replace(/<link([^>]*) crossorigin([^>]*)\/?>/g, '<link$1$2>');
  },
};

export default defineConfig({
  root: path.join(__dirname, 'renderer'),
  plugins: [react(), removeElectronCrossorigin],
  base: './',
  build: {
    outDir: path.join(__dirname, 'dist', 'renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.join(__dirname, 'renderer'),
      '@shared': path.join(__dirname, 'src', 'repl', 'ipc'),
      '@agent': path.join(__dirname, 'src', 'repl'),
    },
  },
  server: {
    port: 3002,
    strictPort: true,
  },
  css: {
    postcss: path.join(__dirname, 'postcss.config.cjs'),
  },
});
