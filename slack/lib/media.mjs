import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export function safeDownloadUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== 'files.slack.com' || u.username || u.password || (u.port && u.port !== '443')) throw new Error('文件下载地址不是 Slack 私有文件域名');
  return u;
}
export async function downloadFile(client, token, home, fileId, maxBytes = 20 * 1024 * 1024) {
  const { file } = await client.files.info({ file: fileId });
  if (!file || file.size > maxBytes || file.is_external) throw new Error('仅支持不超过 20 MB 的 Slack 本地附件');
  const url = safeDownloadUrl(file.url_private_download || file.url_private);
  // Never forward the bot token to an arbitrary redirect target.
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`附件下载失败（HTTP ${response.status}）`);
  const dir = path.join(home, 'media'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = String(file.name || 'attachment').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 100);
  const output = path.join(dir, `${crypto.randomUUID()}-${name}`);
  let count = 0;
  const limit = new Transform({ transform(chunk, encoding, cb) { count += chunk.length; cb(count > maxBytes ? new Error('附件超过 20 MB') : null, chunk); } });
  try { await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(output, { flags: 'wx', mode: 0o600 })); }
  catch (e) { fs.rmSync(output, { force: true }); throw e; }
  return output;
}
