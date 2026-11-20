import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../lib/config.mjs';

if (process.platform !== 'darwin') throw new Error('此安装器仅支持 macOS；其他系统可使用 npm start');
const config = loadConfig();
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dest = path.join(config.home, 'app');
const label = 'com.slack-orca';
const domain = `gui/${process.getuid()}`;
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Install outside Documents/iCloud, which previously evicted MAC-hand runtime files.
if (source !== dest) {
  if (fs.existsSync(dest)) fs.cpSync(dest, `${dest}.backup-${Date.now()}`, { recursive: true, filter: p => !p.split(path.sep).includes('node_modules') });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(source, dest, { recursive: true, filter: p => !p.split(path.sep).some(x => ['node_modules', '.git', '.code-review-graph'].includes(x)) });
  const npm = path.join(path.dirname(process.execPath), 'npm');
  execFileSync(npm, ['ci', '--omit=dev'], { cwd: dest, stdio: 'inherit' });
}
fs.mkdirSync(path.dirname(plist), { recursive: true });
fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(dest, 'bridge.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(dest)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(path.join(config.home, 'launchd.out.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(config.home, 'launchd.err.log'))}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(os.homedir())}</string><key>SLACK_ORCA_HOME</key><string>${xml(config.home)}</string><key>PATH</key><string>${xml(`${path.dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string></dict>
</dict></plist>\n`, { mode: 0o600 });
try { execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' }); } catch {}
execFileSync('launchctl', ['bootstrap', domain, plist], { stdio: 'inherit' });
console.log(`已安装 ${label}\n运行目录：${dest}\n日志：${path.join(config.home, 'bridge.log')}`);
