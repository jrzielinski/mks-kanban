import { swallow } from '../utils/log';
/**
 * plugin-manager.ts
 *
 * Discovers, loads, and manages the lifecycle of MakeStudio plugins.
 * Supports three plugin sources:
 *   1. npm — installed via `npm install` into ~/.makestudio/plugins/node_modules/
 *   2. local — symlinked or copied directory
 *   3. git — cloned from a git URL (future)
 *
 * Plugins are tracked in ~/.makestudio/plugins.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawn } from 'child_process';
import {
  MakeStudioPlugin,
  PluginManifest,
  PluginsConfig,
  PluginContext,
  PluginLogger,
} from './plugin-types';
import { pluginRegistry } from './plugin-registry';
import { logInfo, logSuccess, logError, logWarning } from '../ui/terminal';
import { builtinPlugins } from '../plugins';

const MAKESTUDIO_HOME = path.join(os.homedir(), '.makestudio');
const PLUGINS_DIR = path.join(MAKESTUDIO_HOME, 'plugins');
const PLUGINS_JSON = path.join(MAKESTUDIO_HOME, 'plugins.json');
const AGENT_VERSION = '0.1.132';

// ── Plugin Config Persistence ───────────────────────────────────

function readPluginsConfig(): PluginsConfig {
  try {
    if (fs.existsSync(PLUGINS_JSON)) {
      return JSON.parse(fs.readFileSync(PLUGINS_JSON, 'utf8'));
    }
  } catch (err: any) {
    logWarning(`[plugins] Failed to read plugins.json: ${err.message}`);
  }
  return { plugins: [] };
}

function writePluginsConfig(config: PluginsConfig): void {
  fs.mkdirSync(MAKESTUDIO_HOME, { recursive: true });
  fs.writeFileSync(PLUGINS_JSON, JSON.stringify(config, null, 2), 'utf8');
}

// ── Plugin Context Factory ──────────────────────────────────────

function createPluginContext(): PluginContext {
  const logger: PluginLogger = {
    info: (msg: string) => logInfo(`[plugin] ${msg}`),
    success: (msg: string) => logSuccess(`[plugin] ${msg}`),
    warning: (msg: string) => logWarning(`[plugin] ${msg}`),
    error: (msg: string) => logError(`[plugin] ${msg}`),
  };

  let config: Record<string, any> = {};
  try {
    const configPath = path.join(MAKESTUDIO_HOME, 'config.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      // Strip sensitive fields
      const { token, refreshToken, ...safe } = raw;
      config = safe;
    }
  } catch (err) { swallow(err); }

  return {
    agentVersion: AGENT_VERSION,
    homeDir: MAKESTUDIO_HOME,
    config,
    logger,
  };
}

// ── Module Loading ──────────────────────────────────────────────

function loadPluginModule(pluginPath: string): MakeStudioPlugin | null {
  try {
    // Try to require the plugin — supports both CJS and ESM (via .default)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(pluginPath);
    const plugin: MakeStudioPlugin = mod.default || mod;

    if (!plugin.name || !plugin.version) {
      logError(`[plugins] Invalid plugin at ${pluginPath}: missing name or version`);
      return null;
    }

    return plugin;
  } catch (err: any) {
    logError(`[plugins] Failed to load plugin at ${pluginPath}: ${err.message}`);
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Load all enabled plugins: built-in plugins first, then external (from plugins.json).
 * Called once at agent startup.
 *
 * Built-in plugins use their enabledByDefault flag unless overridden in plugins.json.
 */
export async function loadAllPlugins(): Promise<number> {
  const config = readPluginsConfig();
  const ctx = createPluginContext();
  let loaded = 0;

  // ── 1. Load built-in plugins ──────────────────────────────────
  for (const { plugin, enabledByDefault } of builtinPlugins) {
    // Check if user has explicitly disabled/enabled this built-in in plugins.json
    const override = config.plugins.find(p => p.name === plugin.name && p.source === 'builtin');
    const isEnabled = override ? override.enabled : enabledByDefault;

    if (!isEnabled) continue;

    // Run onLoad lifecycle
    if (plugin.onLoad) {
      try {
        await plugin.onLoad(ctx);
      } catch (err: any) {
        logError(`[plugins] ${plugin.name}.onLoad() failed: ${err.message}`);
        continue;
      }
    }

    pluginRegistry.register(plugin);
    loaded++;
  }

  // ── 2. Load external plugins (npm, local, git) ────────────────
  for (const manifest of config.plugins) {
    // Skip built-in overrides (already handled above)
    if (manifest.source === 'builtin') continue;

    if (!manifest.enabled) continue;

    // Skip if a built-in with the same name is already loaded
    if (pluginRegistry.has(manifest.name)) continue;

    if (!fs.existsSync(manifest.path)) {
      logWarning(`[plugins] Plugin path not found: ${manifest.path} (${manifest.name})`);
      continue;
    }

    const plugin = loadPluginModule(manifest.path);
    if (!plugin) continue;

    // Run onLoad lifecycle
    if (plugin.onLoad) {
      try {
        await plugin.onLoad(ctx);
      } catch (err: any) {
        logError(`[plugins] ${plugin.name}.onLoad() failed: ${err.message}`);
        continue;
      }
    }

    pluginRegistry.register(plugin);
    loaded++;
  }

  return loaded;
}

/**
 * Unload all plugins — run onUnload lifecycle and clear registry.
 * Called on agent shutdown.
 */
export async function unloadAllPlugins(): Promise<void> {
  for (const plugin of pluginRegistry.getAll()) {
    if (plugin.onUnload) {
      try {
        await plugin.onUnload();
      } catch (err: any) {
        logError(`[plugins] ${plugin.name}.onUnload() failed: ${err.message}`);
      }
    }
  }
  pluginRegistry.clear();
}

/**
 * Install a plugin from npm, local path, or git URL.
 */
export async function installPlugin(source: string): Promise<PluginManifest | null> {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });

  const config = readPluginsConfig();

  // Detect source type
  const isLocal = fs.existsSync(source);
  const isGit = source.startsWith('git+') || source.endsWith('.git');
  const sourceType: PluginManifest['source'] = isLocal ? 'local' : isGit ? 'git' : 'npm';

  let pluginPath: string;
  let pluginName: string;
  let pluginVersion: string;

  if (isLocal) {
    // Local plugin — resolve absolute path
    const absPath = path.resolve(source);

    // Try to load it to get name/version
    const plugin = loadPluginModule(absPath);
    if (!plugin) {
      logError(`[plugins] Failed to load local plugin from ${absPath}`);
      return null;
    }

    pluginName = plugin.name;
    pluginVersion = plugin.version;

    // Copy to plugins directory
    const destDir = path.join(PLUGINS_DIR, pluginName);
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }

    // If source is a directory, copy it
    if (fs.statSync(absPath).isDirectory()) {
      copyDirSync(absPath, destDir);
      pluginPath = destDir;
    } else {
      // Single file plugin
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(absPath, path.join(destDir, 'index.js'));
      pluginPath = path.join(destDir, 'index.js');
    }
  } else {
    // npm install into plugins directory
    logInfo(`[plugins] Installing ${source} via npm...`);

    // Ensure package.json exists in plugins dir
    const pkgJsonPath = path.join(PLUGINS_DIR, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      fs.writeFileSync(pkgJsonPath, JSON.stringify({ name: 'makestudio-plugins', private: true, dependencies: {} }, null, 2), 'utf8');
    }

    try {
      execSync(`npm install ${source} --save`, {
        cwd: PLUGINS_DIR,
        stdio: 'pipe',
        timeout: 120_000,
      });
    } catch (err: any) {
      logError(`[plugins] npm install failed: ${err.message}`);
      return null;
    }

    // Resolve the installed package name
    const packageName = source.startsWith('@')
      ? source.split('@').slice(0, 2).join('@') // @scope/pkg@version → @scope/pkg
      : source.replace(/@.*$/, '');              // pkg@version → pkg

    pluginPath = path.join(PLUGINS_DIR, 'node_modules', packageName);

    const plugin = loadPluginModule(pluginPath);
    if (!plugin) {
      logError(`[plugins] Installed package is not a valid MakeStudio plugin`);
      return null;
    }

    pluginName = plugin.name;
    pluginVersion = plugin.version;
  }

  // Remove existing manifest entry if re-installing
  config.plugins = config.plugins.filter(p => p.name !== pluginName);

  const manifest: PluginManifest = {
    name: pluginName,
    version: pluginVersion,
    source: sourceType,
    path: pluginPath,
    enabled: true,
    installedAt: new Date().toISOString(),
  };

  config.plugins.push(manifest);
  writePluginsConfig(config);

  logSuccess(`[plugins] Installed ${pluginName}@${pluginVersion} (${sourceType})`);
  return manifest;
}

/**
 * Remove (uninstall) a plugin by name.
 */
export function removePlugin(name: string): boolean {
  const config = readPluginsConfig();
  const manifest = config.plugins.find(p => p.name === name);

  if (!manifest) {
    logError(`[plugins] Plugin "${name}" not found`);
    return false;
  }

  // Unregister from runtime
  pluginRegistry.unregister(name);

  // Remove files if in plugins directory
  if (manifest.source === 'local' || manifest.source === 'git') {
    const pluginDir = path.dirname(manifest.path);
    if (pluginDir.startsWith(PLUGINS_DIR) && fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
  } else if (manifest.source === 'npm') {
    try {
      execSync(`npm uninstall ${name}`, {
        cwd: PLUGINS_DIR,
        stdio: 'pipe',
        timeout: 60_000,
      });
    } catch {
      logWarning(`[plugins] npm uninstall failed — removing manifest only`);
    }
  }

  // Remove from config
  config.plugins = config.plugins.filter(p => p.name !== name);
  writePluginsConfig(config);

  logSuccess(`[plugins] Removed ${name}`);
  return true;
}

/**
 * List all plugins — built-in + external.
 */
export function listPlugins(): PluginManifest[] {
  const config = readPluginsConfig();
  const result: PluginManifest[] = [];

  // Built-in plugins
  for (const { plugin, enabledByDefault } of builtinPlugins) {
    const override = config.plugins.find(p => p.name === plugin.name && p.source === 'builtin');
    result.push({
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      source: 'builtin',
      path: 'builtin',
      enabled: override ? override.enabled : enabledByDefault,
      installedAt: 'built-in',
    });
  }

  // External plugins
  for (const manifest of config.plugins) {
    if (manifest.source === 'builtin') continue;
    result.push(manifest);
  }

  return result;
}

/**
 * Enable or disable a plugin by name.
 * For built-in plugins, creates an override entry in plugins.json.
 */
export function togglePlugin(name: string, enabled: boolean): boolean {
  const config = readPluginsConfig();
  const manifest = config.plugins.find(p => p.name === name);

  if (manifest) {
    // External or existing override — update in place
    manifest.enabled = enabled;
    writePluginsConfig(config);
    logInfo(`[plugins] ${name} is now ${enabled ? 'enabled' : 'disabled'}`);
    return true;
  }

  // Check if it's a built-in plugin
  const isBuiltin = builtinPlugins.some(b => b.plugin.name === name);
  if (isBuiltin) {
    // Create an override entry for the built-in
    config.plugins.push({
      name,
      version: '1.0.0',
      source: 'builtin',
      path: 'builtin',
      enabled,
      installedAt: new Date().toISOString(),
    });
    writePluginsConfig(config);
    logInfo(`[plugins] Built-in "${name}" is now ${enabled ? 'enabled' : 'disabled'}`);
    return true;
  }

  logError(`[plugins] Plugin "${name}" not found`);
  return false;
}

// ── Helpers ─────────────────────────────────────────────────────

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── Phase 12: Async install com progress streaming ────────────────────

export interface InstallProgressEvent {
  phase: 'start' | 'install' | 'load' | 'done' | 'error';
  source: string;
  line?: string;
  manifest?: PluginManifest;
  error?: string;
}

export type InstallProgressCallback = (event: InstallProgressEvent) => void;

/**
 * Async equivalent of installPlugin — npm install runs in a `spawn` instead
 * of execSync so the Electron main thread isn't blocked for up to 2 minutes.
 * Progress lines are forwarded via the callback so the renderer can show a
 * live install log. Local + git sources still copy synchronously (cheap).
 */
export async function installPluginAsync(
  source: string,
  onProgress?: InstallProgressCallback,
): Promise<PluginManifest | null> {
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  const config = readPluginsConfig();
  // Flag-injection guard: argv array protege contra shell injection mas npm
  // ainda interpreta tokens iniciados com `-` como flag (ex: `--registry=evil`).
  // Permitimos só specifiers normais: pacote npm, scope/pkg, git URL, ou path.
  if (typeof source !== 'string' || !source.trim() || source.trim().startsWith('-')) {
    const emitEarly = (e: InstallProgressEvent): void => { try { onProgress?.(e); } catch (err) { swallow(err); } };
    emitEarly({ phase: 'error', source, error: 'source inválido (não pode começar com `-`)' });
    return null;
  }
  const isLocal = fs.existsSync(source);
  const isGit = source.startsWith('git+') || source.endsWith('.git');
  const sourceType: PluginManifest['source'] = isLocal ? 'local' : isGit ? 'git' : 'npm';
  const emit = (e: InstallProgressEvent): void => { try { onProgress?.(e); } catch (err) { swallow(err); } };
  emit({ phase: 'start', source });

  let pluginPath: string;
  let pluginName: string;
  let pluginVersion: string;

  if (isLocal) {
    const absPath = path.resolve(source);
    const plugin = loadPluginModule(absPath);
    if (!plugin) {
      emit({ phase: 'error', source, error: `Failed to load local plugin from ${absPath}` });
      return null;
    }
    pluginName = plugin.name;
    pluginVersion = plugin.version;
    const destDir = path.join(PLUGINS_DIR, pluginName);
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
    if (fs.statSync(absPath).isDirectory()) {
      copyDirSync(absPath, destDir);
      pluginPath = destDir;
    } else {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(absPath, path.join(destDir, 'index.js'));
      pluginPath = path.join(destDir, 'index.js');
    }
  } else {
    emit({ phase: 'install', source, line: `installing ${source} via npm...` });
    const pkgJsonPath = path.join(PLUGINS_DIR, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      fs.writeFileSync(pkgJsonPath, JSON.stringify({ name: 'makestudio-plugins', private: true, dependencies: {} }, null, 2), 'utf8');
    }
    // execFile with argv list (not shell) — defends against injection in `source`.
    const code: number = await new Promise((resolve) => {
      const proc = spawn('npm', ['install', source, '--save'], {
        cwd: PLUGINS_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGTERM'); } catch (err) { swallow(err); } }, 120_000);
      timer.unref?.();
      proc.stdout?.on('data', (b: Buffer) => emit({ phase: 'install', source, line: b.toString('utf8') }));
      proc.stderr?.on('data', (b: Buffer) => emit({ phase: 'install', source, line: b.toString('utf8') }));
      proc.on('error', (err) => {
        clearTimeout(timer);
        emit({ phase: 'error', source, error: err.message });
        resolve(1);
      });
      proc.on('exit', (c) => {
        clearTimeout(timer);
        resolve(timedOut ? 124 : (c ?? 0));
      });
    });
    if (code !== 0) {
      emit({ phase: 'error', source, error: `npm install exit ${code}` });
      return null;
    }
    // Resolver o nome real do pacote: pra git URLs / aliases isso não é
    // simplesmente strip de "@version". Lemos a `dependencies` atualizada do
    // package.json do dir e tomamos a entrada que ainda não estava antes.
    let packageName: string;
    try {
      const pkgRaw = fs.readFileSync(pkgJsonPath, 'utf8');
      const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string> };
      const deps = pkg.dependencies ?? {};
      // Pra npm specifiers tipo `@scope/pkg@1.2.3` ou `pkg@latest`, nome vem
      // antes do `@`. Pra git URLs, npm registra a entry com o nome da
      // package.json do repo — usamos a chave que aparece em `deps` agora.
      const inferred = source.startsWith('@')
        ? source.split('@').slice(0, 2).join('@')
        : source.replace(/@.*$/, '');
      if (deps[inferred]) {
        packageName = inferred;
      } else {
        // Fallback: pega a única chave nova (geralmente git URLs).
        const keys = Object.keys(deps);
        packageName = keys[keys.length - 1] ?? inferred;
      }
    } catch {
      packageName = source.startsWith('@')
        ? source.split('@').slice(0, 2).join('@')
        : source.replace(/@.*$/, '');
    }
    pluginPath = path.join(PLUGINS_DIR, 'node_modules', packageName);
    emit({ phase: 'load', source, line: `loading from ${pluginPath}` });
    const plugin = loadPluginModule(pluginPath);
    if (!plugin) {
      emit({ phase: 'error', source, error: 'Installed package is not a valid MakeStudio plugin' });
      return null;
    }
    pluginName = plugin.name;
    pluginVersion = plugin.version;
  }

  config.plugins = config.plugins.filter((p) => p.name !== pluginName);
  const manifest: PluginManifest = {
    name: pluginName,
    version: pluginVersion,
    source: sourceType,
    path: pluginPath,
    enabled: true,
    installedAt: new Date().toISOString(),
  };
  config.plugins.push(manifest);
  writePluginsConfig(config);
  emit({ phase: 'done', source, manifest });
  return manifest;
}
