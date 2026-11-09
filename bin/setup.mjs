#!/usr/bin/env node
// 安装引导：建（或绑定）一个飞书机器人应用，写 ~/.feishu-orca/config.json，给 lark-cli 配好收事件用的目录
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { registerApp } from '@larksuite/channel';
import { orcaHome, which } from '../lib/config.mjs';
import { feishu } from '../lib/feishu.mjs';
import { run } from '../lib/run.mjs';

// 机器人要的权限、事件、回调（扫码新建时预填到确认页）
export const SCOPES = [
  'im:message', 'im:message:send_as_bot', 'im:message.group_msg', 'im:message.p2p_msg:readonly', 'im:message:update',
  'im:message.reactions:write_only', 'im:message.pins:write_only', 'im:resource',
  'im:chat:create', 'im:chat:update', 'im:chat:delete', 'im:chat:read',
  'cardkit:card:write', 'contact:user.base:readonly',
];
const EVENTS = ['im.message.receive_v1'];
const CALLBACKS = ['card.action.trigger'];

const home = orcaHome();
const file = path.join(home, 'config.json');
const rl = readline.createInterface({ input: process.stdin });
const lines = rl[Symbol.asyncIterator](); // 按行顺序读：输入是管道喂进来的也不会丢
const ask = async (q, def = '') => { process.stdout.write(def ? `${q}（默认 ${def}）：` : `${q}：`); const { value } = await lines.next(); return String(value ?? '').trim() || def; };
const ok = (s) => console.log(`✅ ${s}`);
const die = (s) => { console.error(`❌ ${s}`); process.exit(1); };

// 1. 依赖
if (Number(process.versions.node.split('.')[0]) < 20) die(`Node 要 20 以上，现在是 ${process.version}`);
const bins = { 'lark-cli': which('lark-cli'), orca: which('orca', ['/Applications/Orca.app/Contents/Resources/bin']), claude: which('claude', [path.join(process.env.HOME, '.local/bin')]) };
for (const [k, v] of Object.entries(bins)) v ? ok(`${k}：${v}`) : die(`找不到 ${k}（lark-cli：npm i -g @larksuite/cli；orca：装 Orca 桌面版；claude：装 Claude Code）`);
if (fs.existsSync(file) && (await ask(`${file} 已经有了，覆盖吗？y/N`, 'N')).toLowerCase() !== 'y') process.exit(0);

// 2. 机器人应用
let appId, secret, owner;
const mode = await ask('1 扫码新建一个机器人（推荐）  2 用已有的应用', '1');
if (mode === '1') {
  const r = await registerApp({
    appPreset: { name: 'Orca', desc: '{user} 的 Orca：在飞书里开工作树、和终端里的模型对话' },
    addons: { scopes: { tenant: SCOPES }, events: { items: { tenant: EVENTS } }, callbacks: { items: CALLBACKS } },
    createOnly: true,
    onQRCodeReady: async ({ url }) => {
      console.log(`\n用飞书 App 扫下面的二维码（或在已登录飞书的浏览器里打开链接），按页面提示创建机器人：\n${url}\n`);
      const q = await run(bins['lark-cli'], ['auth', 'qrcode', url, '--ascii']);
      if (q.code === 0) console.log(q.out);
    },
    onStatusChange: ({ status }) => status === 'polling' || console.log(`…${status}`),
  });
  appId = r.client_id; secret = r.client_secret; owner = r.user_info?.open_id;
  ok(`机器人已创建：${appId}`);
} else {
  appId = await ask('App ID（cli_ 开头）');
  secret = await ask('App Secret');
  if (!/^cli_/.test(appId) || !secret) die('App ID / App Secret 不对');
}

// 3. 校验凭据，查权限缺不缺
const f = feishu({ appId, secret });
try { await f.api('GET', '/bot/v3/info'); ok('凭据可用'); } catch (e) { die(`凭据不可用：${e.message}`); }
try {
  const have = new Set(((await f.api('GET', `/application/v6/applications/${appId}`, { query: { lang: 'zh_cn' } })).app?.scopes || []).map((s) => s.scope));
  const missing = SCOPES.filter((s) => !have.has(s) && !(s.startsWith('im:chat:') && have.has('im:chat')));
  if (missing.length) console.log(`⚠️  还缺这些权限，到开放平台开通（自建应用开通后要发布版本）：\n   ${missing.join('\n   ')}\n   https://open.feishu.cn/app/${appId}/auth`);
  else ok('权限齐了');
} catch { console.log('（查不了这个应用开了哪些权限，按 docs/feishu-app.md 自己核对一下）'); }

// 4. lark-cli 收事件：单独一个配置目录，不动你默认的 lark-cli 配置
const larkDir = path.join(home, 'lark-cli');
fs.mkdirSync(home, { recursive: true });
const env = { ...process.env, LARKSUITE_CLI_CONFIG_DIR: larkDir };
const init = await run(bins['lark-cli'], ['config', 'init', '--app-id', appId, '--app-secret-stdin', '--brand', 'feishu'], { env, input: secret });
if (init.code !== 0) die(`lark-cli 配置失败：${(init.err || init.out).slice(-300)}`);
ok(`lark-cli 已绑定这个应用（${larkDir}）`);

// 5. 主人：只认这个人的消息和按钮。扫码新建的已经知道是谁；已有应用就等你私聊它一句
if (!owner) {
  console.log('\n现在用飞书私聊这个机器人，随便发一句话（5 分钟内）……');
  const r = await run(bins['lark-cli'], ['event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--max-events', '1', '--timeout', '5m'], { env, timeout: 330_000 });
  try { owner = JSON.parse(r.out.trim().split('\n').pop()).sender_id; } catch {}
  if (!owner && /another (event bus|consumer)/.test(r.err)) die('这个应用的事件已经有别的进程在收（比如已经在跑的 feishu-orca 服务或别的机器人程序），先停掉它再跑一次。');
  if (!owner) die(`没收到消息。确认机器人订阅了 im.message.receive_v1（长连接）、开了 im:message.p2p_msg:readonly 权限，再跑一次。\n${(r.err || '').slice(-300)}`);
}
ok(`主人：${owner}`);

// 6. 写配置
fs.writeFileSync(file, `${JSON.stringify({ app_id: appId, app_secret: secret, owner_open_id: owner, lark_cli_config_dir: larkDir }, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(file, 0o600);
ok(`配置写好了：${file}`);
console.log('\n下一步：./install.sh 装成常驻服务，然后在飞书里私聊机器人发一句话，会出新建会话的卡片。');
rl.close();
