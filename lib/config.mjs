// 配置：$FEISHU_ORCA_HOME/config.json（默认 ~/.feishu-orca），由 bin/setup.mjs 生成
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const orcaHome = (env = process.env) => path.resolve(env.FEISHU_ORCA_HOME || path.join(os.homedir(), '.feishu-orca'));

// 找可执行文件：配置里写了就用配置的，否则按 PATH 找
export function which(name, extra = []) {
  for (const dir of [...(process.env.PATH || '').split(':'), ...extra]) {
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

// App Secret：config 里的 app_secret → 环境变量 → lark-channel-bridge 的加密库（装过它的话）
function secretOf(c, env) {
  if (c.app_secret) return c.app_secret;
  if (env.FEISHU_ORCA_APP_SECRET) return env.FEISHU_ORCA_APP_SECRET;
  const getter = path.join(os.homedir(), '.lark-channel/secrets-getter');
  if (fs.existsSync(getter)) {
    try {
      const out = execFileSync(getter, { input: JSON.stringify({ protocolVersion: 1, provider: 'bridge', ids: [`app-${c.app_id}`] }), stdio: ['pipe', 'pipe', 'ignore'] });
      const v = JSON.parse(out).values?.[`app-${c.app_id}`];
      if (v) return v;
    } catch {}
  }
  return null;
}

export function loadConfig(env = process.env) {
  const home = orcaHome(env), file = path.join(home, 'config.json');
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`读不了 ${file}（${e.message}）。先跑 node bin/setup.mjs`); }
  for (const k of ['app_id', 'owner_open_id']) if (typeof c[k] !== 'string' || !c[k]) throw new Error(`${file} 缺 ${k}。先跑 node bin/setup.mjs`);
  const secret = secretOf(c, env);
  if (!secret) throw new Error(`找不到 ${c.app_id} 的 App Secret：在 ${file} 里写 app_secret，或设环境变量 FEISHU_ORCA_APP_SECRET`);
  const orcaBin = '/Applications/Orca.app/Contents/Resources/bin';
  const bin = (k, name, extra) => c[k] || which(name, extra);
  const cfg = {
    home, appId: c.app_id, secret, owner: c.owner_open_id,
    larkCli: bin('lark_cli', 'lark-cli'),
    orca: bin('orca', 'orca', [orcaBin]),
    claude: bin('claude', 'claude', [path.join(os.homedir(), '.local/bin')]),
    larkCliConfigDir: c.lark_cli_config_dir ? c.lark_cli_config_dir.replace(/^~(?=\/|$)/, os.homedir()) : null,
    docUrl: c.doc_url || null,
  };
  for (const [k, name] of [['larkCli', 'lark-cli'], ['orca', 'orca'], ['claude', 'claude']]) if (!cfg[k]) throw new Error(`找不到 ${name}：装好它，或在 ${file} 里写它的路径`);
  return cfg;
}
