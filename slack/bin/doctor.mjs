import fs from 'node:fs';
import path from 'node:path';
import bolt from '@slack/bolt';
import { loadConfig, redact } from '../lib/config.mjs';
import { Orca } from '../lib/orca.mjs';

const localOnly = process.argv.includes('--local');
const c = loadConfig({ optional: true });
let failures = 0;
async function check(name, fn) {
  try { console.log(`✓ ${name}: ${await fn()}`); }
  catch (e) { failures++; console.log(`✗ ${name}: ${redact(e.message)}`); }
}
await check('Node.js', async () => { if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 22 或以上'); return process.version; });
const orca = new Orca(c.orca);
await check('Orca 项目和模型', async () => { const x = await orca.catalog(); return `${x.repos.length} 个项目，${x.models.length} 个 Claude 模型`; });
await check('会话身份识别', async () => `${(await orca.liveSessions()).length} 个可验证的运行中 Claude 会话`);
await check('本地状态', async () => { const p = path.join(c.home, 'state.json'); if (fs.existsSync(p)) { const s = JSON.parse(fs.readFileSync(p, 'utf8')); return `${Object.keys(s.sessions).length} 个 Slack 线程`; } return '尚未创建（首次启动时创建）'; });
if (localOnly) console.log('— 已跳过 Slack 授权与连接检查（--local）');
else {
  await check('Slack 配置', async () => { loadConfig(); return '必要字段齐全（不显示 Token）'; });
  if (c.botToken && c.appToken) {
    const app = new bolt.App({ token: c.botToken, appToken: c.appToken, socketMode: true, logLevel: 'error' });
    await check('Slack Workspace', async () => { const r = await app.client.auth.test(); if (r.team_id !== c.teamId) throw new Error('Workspace 不匹配'); return r.team; });
    await check('会话频道', async () => { const r = await app.client.conversations.info({ channel: c.channelId }); if (!r.channel?.is_member) throw new Error('机器人尚未加入频道'); return r.channel.is_private ? '私有频道，机器人已加入' : '公开频道，机器人已加入'; });
    await check('Socket Mode', async () => { try { await app.start(); return '连接成功'; } finally { await app.stop(); } });
  }
}
process.exitCode = failures ? 1 : 0;
