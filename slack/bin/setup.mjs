import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import bolt from '@slack/bolt';
import { loadConfig, redact } from '../lib/config.mjs';

if (!process.stdin.isTTY) throw new Error('请在本机交互终端运行 npm run setup，Token 将隐藏输入');
let muted = false;
const output = new Writable({ write(chunk, encoding, cb) { if (!muted) process.stdout.write(chunk, encoding); cb(); } });
const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
async function ask(label, secret = false) {
  process.stdout.write(label + ': '); muted = secret;
  try { return (await rl.question('')).trim(); }
  finally { muted = false; if (secret) process.stdout.write('\n'); }
}
const c = loadConfig({ optional: true });
const draftFile = path.join(c.home, 'setup-draft.json');
let draft = fs.existsSync(draftFile) ? JSON.parse(fs.readFileSync(draftFile, 'utf8')) : {};
function saveDraft(patch) {
  draft = { ...draft, ...patch };
  fs.mkdirSync(c.home, { recursive: true, mode: 0o700 });
  const tmp = draftFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(draft, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, draftFile);
}
async function askId(key, label, pattern) {
  let value = draft[key] || (key === 'owner_id' ? c.ownerId : c.channelId);
  if (process.argv.includes('--ids')) value = '';
  while (!value || !pattern.test(value)) {
    value = await ask(label);
    if (!pattern.test(value)) console.log('ID 格式不正确，请重新输入；已输入的 Token 会保留。');
  }
  saveDraft({ [key]: value });
  return value;
}
try {
  console.log('先在 https://api.slack.com/apps 用 slack-manifest.json 创建应用并安装到 Workspace。');
  console.log('创建带 connections:write 的 App-Level Token；把机器人加入专用频道（建议私有频道）。');
  let botToken = draft.bot_token || c.botToken;
  let appToken = draft.app_token || c.appToken;
  if (process.argv.includes('--tokens')) { botToken = null; appToken = null; }
  if (!botToken) botToken = await ask('Bot User OAuth Token（xoxb-，隐藏输入）', true);
  if (!botToken.startsWith('xoxb-')) throw new Error('Bot Token 应以 xoxb- 开头');
  saveDraft({ bot_token: botToken });
  if (!appToken) appToken = await ask('App-Level Token（xapp-，隐藏输入）', true);
  if (!appToken.startsWith('xapp-')) throw new Error('App-Level Token 应以 xapp- 开头');
  saveDraft({ app_token: appToken });
  console.log('两个 Token 已保存在本机，后续填写失败或退出也不需要重复输入。');
  const ownerId = await askId('owner_id', '你的 Slack 成员 ID（个人资料 → ⋯ → Copy member ID）', /^[UW][A-Z0-9]+$/);
  const channelId = await askId('channel_id', '专用频道 ID（频道详情底部）', /^[CG][A-Z0-9]+$/);
  const app = new bolt.App({ token: botToken, appToken, socketMode: true, logLevel: 'error' });
  const auth = await app.client.auth.test();
  const channel = (await app.client.conversations.info({ channel: channelId })).channel;
  if (!channel?.is_member) throw new Error('请先在专用频道执行 /invite @MAC-hand，再运行 setup');
  // Open and close the socket without registering message handlers: validates both tokens, sends no messages.
  await app.start(); await app.stop();
  fs.mkdirSync(c.home, { recursive: true, mode: 0o700 });
  if (fs.existsSync(c.file)) fs.copyFileSync(c.file, `${c.file}.backup-${Date.now()}`);
  fs.writeFileSync(c.file, JSON.stringify({ bot_token: botToken, app_token: appToken, team_id: auth.team_id, owner_id: ownerId, channel_id: channelId, session_layout: c.sessionLayout, orca: c.orca }, null, 2), { mode: 0o600 });
  fs.chmodSync(c.file, 0o600);
  fs.rmSync(draftFile, { force: true });
  console.log(`配置已保存：${c.file}\n下一步：npm run doctor && ./install.sh`);
} catch (e) {
  console.error(redact(e.message));
  console.log('已输入的配置保留在本机。重填 ID：npm run setup -- --ids；重填 Token：npm run setup -- --tokens');
  process.exitCode = 1;
}
finally { rl.close(); }
