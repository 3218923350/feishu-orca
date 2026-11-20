import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const defaultHome = path.join(os.homedir(), 'Library/Application Support/slack-orca');
export function loadConfig({ optional = false } = {}) {
  const home = process.env.SLACK_ORCA_HOME || defaultHome;
  const file = path.join(home, 'config.json');
  let raw = {};
  if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const config = {
    home, file,
    botToken: process.env.SLACK_BOT_TOKEN || raw.bot_token,
    appToken: process.env.SLACK_APP_TOKEN || raw.app_token,
    teamId: process.env.SLACK_TEAM_ID || raw.team_id,
    ownerId: process.env.SLACK_OWNER_ID || raw.owner_id,
    channelId: process.env.SLACK_CHANNEL_ID || raw.channel_id,
    sessionLayout: raw.session_layout === 'channel' ? 'channel' : 'thread',
    orca: raw.orca || '/usr/local/bin/orca',
    pollMs: 2000, renderMs: 4000,
  };
  if (!optional) {
    for (const key of ['botToken', 'appToken', 'teamId', 'ownerId', 'channelId']) {
      if (!config[key]) throw new Error(`缺少 ${key}：先运行 npm run setup`);
    }
    if (!/^xoxb-/.test(config.botToken) || !/^xapp-/.test(config.appToken)) throw new Error('需要 Bot Token（xoxb-）和 App Token（xapp-）');
  }
  return config;
}

export function authorized(config, user, team) {
  return !!user && user === config.ownerId && !!team && team === config.teamId;
}

export function redact(value) {
  return String(value).replace(/xox[baprs]-[A-Za-z0-9-]+|xapp-[A-Za-z0-9-]+/g, '<REDACTED>');
}
