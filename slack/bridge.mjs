import fs from 'node:fs';
import path from 'node:path';
import bolt from '@slack/bolt';
import { loadConfig, redact } from './lib/config.mjs';
import { openState, lockProcess } from './lib/state.mjs';
import { Orca } from './lib/orca.mjs';
import { Engine } from './lib/engine.mjs';
import { registerSlack } from './lib/slack.mjs';

const config = loadConfig();
const unlock = lockProcess(config.home);
process.once('exit', unlock);
const log = (...parts) => {
  const line = `${new Date().toISOString()} ${parts.map(redact).join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(config.home, 'bridge.log'), line + '\n', { mode: 0o600 });
};
const logger = { debug() {}, info: (...a) => log('slack', ...a), warn: (...a) => log('slack-warn', ...a), error: (...a) => log('slack-error', ...a), setLevel() {}, getLevel: () => 'info', setName() {} };
const app = new bolt.App({ token: config.botToken, appToken: config.appToken, socketMode: true, logger });
const auth = await app.client.auth.test();
if (auth.team_id !== config.teamId) throw new Error('Bot Token 所属 Workspace 与配置不一致');
const state = openState(path.join(config.home, 'state.json'));
const engine = new Engine({ state, orca: new Orca(config.orca), slack: app.client, config, log });
registerSlack(app, engine, { log });
await app.start();
log('started', `${engine.sessions.length} sessions`);
const timer = setInterval(() => engine.tick().catch(e => log('tick-error', e.message)), config.pollMs);
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (stopping) return; stopping = true;
  clearInterval(timer); await app.stop(); state.save(); unlock(); process.exit(0);
});
