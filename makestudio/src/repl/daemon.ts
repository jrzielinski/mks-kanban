import { swallow } from '../utils/log';
/**
 * Launchd/systemd daemon installation for scheduled tasks.
 *
 * macOS: ~/Library/LaunchAgents/com.makestudio.scheduled-run.plist
 * Linux: ~/.config/systemd/user/makestudio-scheduled-run.{service,timer}
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const SERVICE_NAME = 'com.makestudio.scheduled-run';

function getMakestudioBinary(): string {
  // Try to find makestudio in PATH
  try {
    return execSync('which makestudio', { shell: '/bin/sh' }).toString().trim();
  } catch {
    // Fallback: our dist path
    return path.join(os.homedir(), '.nvm', 'versions', 'node', process.version, 'bin', 'makestudio');
  }
}

export function installDaemon(): { ok: boolean; message: string } {
  const bin = getMakestudioBinary();
  if (!fs.existsSync(bin)) {
    return { ok: false, message: `makestudio binary nao encontrado em ${bin}` };
  }

  if (process.platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_NAME}.plist`);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bin}</string>
        <string>scheduled-run</string>
    </array>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${path.join(os.homedir(), '.makestudio', 'daemon.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(os.homedir(), '.makestudio', 'daemon.log')}</string>
</dict>
</plist>
`;
    try {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, plist, 'utf8');
      // Load it
      execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`, { shell: '/bin/sh' });
      execSync(`launchctl load "${plistPath}"`, { shell: '/bin/sh' });
      return { ok: true, message: `Daemon instalado. Roda a cada 60s. Plist: ${plistPath}` };
    } catch (err: any) {
      return { ok: false, message: err.message };
    }
  }

  if (process.platform === 'linux') {
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    const service = `[Unit]
Description=MakeStudio scheduled tasks

[Service]
Type=oneshot
ExecStart=${bin} scheduled-run
StandardOutput=append:${path.join(os.homedir(), '.makestudio', 'daemon.log')}
StandardError=append:${path.join(os.homedir(), '.makestudio', 'daemon.log')}
`;
    const timer = `[Unit]
Description=MakeStudio scheduled tasks (every minute)

[Timer]
OnCalendar=*:0/1
Persistent=true

[Install]
WantedBy=timers.target
`;
    try {
      fs.writeFileSync(path.join(unitDir, 'makestudio-scheduled-run.service'), service);
      fs.writeFileSync(path.join(unitDir, 'makestudio-scheduled-run.timer'), timer);
      execSync('systemctl --user daemon-reload', { shell: '/bin/sh' });
      execSync('systemctl --user enable --now makestudio-scheduled-run.timer', { shell: '/bin/sh' });
      return { ok: true, message: 'Daemon systemd instalado (user timer, a cada minuto).' };
    } catch (err: any) {
      return { ok: false, message: err.message };
    }
  }

  return { ok: false, message: `Plataforma ${process.platform} nao suportada (so macOS e Linux).` };
}

export function uninstallDaemon(): { ok: boolean; message: string } {
  if (process.platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_NAME}.plist`);
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`, { shell: '/bin/sh' });
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
      return { ok: true, message: 'Daemon removido.' };
    } catch (err: any) {
      return { ok: false, message: err.message };
    }
  }
  if (process.platform === 'linux') {
    try {
      execSync('systemctl --user disable --now makestudio-scheduled-run.timer 2>/dev/null || true', { shell: '/bin/sh' });
      const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
      for (const f of ['makestudio-scheduled-run.service', 'makestudio-scheduled-run.timer']) {
        const p = path.join(unitDir, f);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      execSync('systemctl --user daemon-reload', { shell: '/bin/sh' });
      return { ok: true, message: 'Daemon systemd removido.' };
    } catch (err: any) {
      return { ok: false, message: err.message };
    }
  }
  return { ok: false, message: `Plataforma ${process.platform} nao suportada.` };
}

export function daemonStatus(): { installed: boolean; running: boolean; message: string } {
  if (process.platform === 'darwin') {
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_NAME}.plist`);
    const installed = fs.existsSync(plistPath);
    let running = false;
    try {
      const out = execSync(`launchctl list | grep ${SERVICE_NAME} || true`, { shell: '/bin/sh' }).toString();
      running = out.includes(SERVICE_NAME);
    } catch (err) { swallow(err); }
    return { installed, running, message: installed ? (running ? 'Instalado e ativo' : 'Instalado mas parado') : 'Nao instalado' };
  }
  if (process.platform === 'linux') {
    let installed = false;
    let running = false;
    try {
      const out = execSync('systemctl --user is-enabled makestudio-scheduled-run.timer 2>/dev/null || echo no', { shell: '/bin/sh' }).toString().trim();
      installed = out === 'enabled';
      const active = execSync('systemctl --user is-active makestudio-scheduled-run.timer 2>/dev/null || echo no', { shell: '/bin/sh' }).toString().trim();
      running = active === 'active';
    } catch (err) { swallow(err); }
    return { installed, running, message: installed ? (running ? 'Instalado e ativo' : 'Instalado mas parado') : 'Nao instalado' };
  }
  return { installed: false, running: false, message: `Plataforma ${process.platform} nao suportada.` };
}
