import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sessionInfo, sessionsIn, transcriptPath } from './claude.mjs';
const exec = promisify(execFile);
export const support = path.join(os.homedir(), 'Library/Application Support/orca');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function hookRecords() {
  const file = path.join(support, 'agent-hooks/last-status.db');
  const { stdout } = await exec('/usr/bin/sqlite3', ['-readonly', file, "SELECT value FROM rows WHERE json_extract(value, '$.providerSession.id') IS NOT NULL;"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split('\n').filter(Boolean).map(JSON.parse);
}

export async function processMatches(record, run = exec) {
  const p = record.agentPresence?.process;
  if (p?.platform !== 'darwin' || !Number.isInteger(p.pid) || p.pid <= 0 || !p.startTime) return false;
  try {
    // Orca records lstart in UTC, independent of the Mac's display timezone.
    const { stdout } = await run('/bin/ps', ['-p', String(p.pid), '-o', 'lstart='], { timeout: 3000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
    const normalize = s => String(s).trim().replace(/\s+/g, ' ');
    return normalize(stdout) === normalize(p.startTime);
  } catch { return false; }
}

export function matchingTerminals(session, terminals, records) {
  return terminals.filter(t => {
    if (t.executionHostId !== 'local' || !t.connected || !t.writable || t.agentIdentity !== 'claude' || t.worktreePath !== session.path) return false;
    return records.some(r => r.paneKey === `${t.tabId}:${t.leafId}` && r.providerSession?.id === session.sessionId && r.providerSession?.cwd === session.path && r.agentPresence?.sessionOwner === true && r.agentPresence?.session === session.sessionId);
  });
}

export async function models() {
  const file = path.join(support, 'agent-model-catalog.db');
  let entries;
  if (fs.existsSync(file)) {
    const { stdout } = await exec('/usr/bin/sqlite3', ['-readonly', file, 'SELECT value FROM rows ORDER BY seq;'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    entries = stdout.split('\n').filter(Boolean).map(JSON.parse);
  } else entries = JSON.parse(fs.readFileSync(path.join(support, 'agent-model-catalog.json'), 'utf8')).entries;
  const latest = entries.filter(e => e.agent === 'claude' && e.discovered?.models?.length).sort((a, b) => b.discovered.at - a.discovered.at)[0];
  if (!latest) throw new Error('Orca 中没有可用的 Claude 模型，请先在桌面加载模型列表');
  return latest.discovered.models.map(m => ({ id: m.id, label: m.label || m.id, efforts: (m.efforts || []).map(e => e.value) }));
}

export class Orca {
  constructor(bin, { records = hookRecords, run = exec, verifyProcess = processMatches } = {}) { this.bin = bin; this.records = records; this.run = run; this.verifyProcess = verifyProcess; }
  async call(args, timeout = 15000) {
    let output;
    try { output = await this.run(this.bin, [...args, '--environment', 'local', '--json'], { timeout, maxBuffer: 12 * 1024 * 1024 }); }
    catch (e) {
      let data;
      try { data = JSON.parse(e.stdout); } catch {}
      const error = new Error(data?.error?.message || `Orca ${args.slice(0, 2).join(' ')} 查询/执行失败，结果未知（未自动重试）`);
      error.code = data?.error?.code || e.code;
      error.data = data?.error?.data;
      throw error;
    }
    const data = JSON.parse(output.stdout);
    if (!data.ok) { const e = new Error(data.error?.message || 'Orca 请求失败'); e.code = data.error?.code; e.data = data.error?.data; throw e; }
    return data.result;
  }
  async terminals() {
    const r = await this.call(['terminal', 'list']);
    if (r.truncated || r.hostScope?.omittedHostIds?.includes('local') || !Array.isArray(r.terminals)) throw new Error('终端列表不完整，保留现有绑定');
    return r.terminals;
  }
  async repos() { return (await this.call(['repo', 'list'])).repos.filter(r => r.kind === 'git'); }
  async catalog() { return { repos: await this.repos(), models: await models() }; }
  async snapshot() {
    const terminals = await this.terminals();
    const candidates = (await this.records()).filter(r => terminals.some(t => t.executionHostId === 'local' && t.connected && t.agentIdentity === 'claude' && r.paneKey === `${t.tabId}:${t.leafId}`));
    const live = await Promise.all(candidates.map(r => this.verifyProcess(r)));
    return { terminals, records: candidates.filter((_, i) => live[i]) };
  }
  async liveSessions() {
    const { terminals, records } = await this.snapshot();
    const out = new Map();
    for (const r of records) {
      const session = { sessionId: r.providerSession?.id, path: r.providerSession?.cwd };
      if (!session.sessionId || !session.path) continue;
      const matches = matchingTerminals(session, terminals, records);
      if (matches.length !== 1) continue;
      const t = matches[0];
      const info = sessionInfo(transcriptPath(session.path, session.sessionId));
      out.set(session.sessionId, { ...session, terminal: t.handle, title: info?.title || info?.lastPrompt?.slice(0, 100) || r.payload?.conversationName || r.payload?.prompt?.slice(0, 100) || t.title || path.basename(session.path), paneKey: r.paneKey });
    }
    return [...out.values()];
  }
  async sessionCatalog() {
    // Discovery is broader than dispatch: keep unavailable/unsupported entries visible.
    const warnings = [];
    const [live, agentsResult, worktreeResult] = await Promise.all([
      this.liveSessions().catch(() => { warnings.push('暂时无法验证运行终端；请稍后刷新。'); return []; }),
      this.call(['agent', 'list']).catch(() => { warnings.push('Orca 会话列表查询失败，当前结果可能不完整。'); return { agents: [] }; }),
      this.call(['worktree', 'list', '--limit', '10000']).catch(() => { warnings.push('工作树列表查询失败，历史记录可能不完整。'); return { worktrees: [] }; }),
    ]);
    let worktrees = worktreeResult;
    if (worktrees.truncated && Number.isSafeInteger(worktrees.totalCount) && worktrees.totalCount > 10000) {
      worktrees = await this.call(['worktree', 'list', '--limit', String(worktrees.totalCount)]);
    }
    if (worktrees.truncated || agentsResult.truncated) warnings.push('Orca 返回的列表有截断，当前结果可能不完整。');
    if (agentsResult.hostScope?.omittedHostIds?.length || worktrees.hostScope?.omittedHostIds?.length) warnings.push('本列表仅覆盖本机；其他主机的会话未加载。');
    const localWorktrees = (worktrees.worktrees || []).filter(w => (w.hostId || w.executionHostId || 'local') === 'local');
    const paths = new Map(localWorktrees.map(w => [w.id || w.worktreeId, w.path]));
    const current = new Map(live.map(s => [`session:${s.sessionId}`, { ...s, key: `session:${s.sessionId}`, available: true, category: 'terminal', updatedAt: sessionInfo(transcriptPath(s.path, s.sessionId))?.mtime || 0 }]));
    for (const a of agentsResult.agents || []) {
      if (a.hostId !== 'local') continue;
      const match = live.find(s => s.paneKey === a.paneKey);
      if (match) {
        const row = current.get(`session:${match.sessionId}`);
        row.title = a.title || row.title; row.updatedAt = a.updatedAt || row.updatedAt;
        continue;
      }
      const key = `orca:${a.orcaSessionId || a.paneKey}`;
      current.set(key, { key, orcaSessionId: a.orcaSessionId, title: a.title || a.workspace || '未命名会话', path: paths.get(a.worktreeId) || a.workspace, available: false, category: a.kind, updatedAt: a.updatedAt || 0,
        reason: a.agent !== 'claude' ? `${a.agent || '此模型'} 暂不支持接入` : a.kind === 'chat' ? 'Orca 原生聊天，暂不支持直接接入' : '未确认可用的 Claude 终端；请在 Orca 恢复原会话后刷新' });
    }
    const history = [];
    for (const cwd of new Set([...localWorktrees.map(w => w.path), ...live.map(s => s.path)].filter(Boolean))) {
      for (const info of sessionsIn(cwd, Infinity)) {
        const active = live.find(s => s.sessionId === info.id && s.path === cwd);
        history.push({ ...(active || {}), key: `session:${info.id}`, sessionId: info.id, path: cwd,
          title: info.title || info.lastPrompt?.slice(0, 100) || active?.title || `Claude 会话 ${info.id.slice(0, 8)}`,
          available: !!active, category: 'history', updatedAt: info.mtime,
          reason: active ? undefined : info.entrypoint === 'sdk-ts' ? '原生聊天记录；请先在 Orca 的 Claude 终端恢复再刷新' : '历史记录；请先在 Orca 恢复原会话后刷新' });
      }
    }
    return { current: [...current.values()].sort((a, b) => Number(b.available) - Number(a.available) || b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)), history: history.sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)), warnings };
  }
  async resolve(session) {
    const { terminals, records } = await this.snapshot();
    const matches = matchingTerminals(session, terminals, records);
    if (matches.length !== 1) throw new Error(matches.length ? '同一会话有多个运行终端，请在 Orca 中保留一个后重试' : '无法确认这个 Claude 会话的运行终端；请在 Orca 中恢复原会话后重试');
    const t = matches[0];
    // A second observation at the send boundary prevents dispatch to a stale shell.
    const current = (await this.call(['terminal', 'show', '--terminal', t.handle])).terminal;
    if (!matchingTerminals(session, [current], records).length) throw new Error('终端状态发生变化，本次消息未发送');
    session.terminal = current.handle;
    return current;
  }
  async send(session, text) {
    const t = await this.resolve(session);
    return this.call(['terminal', 'send', '--terminal', t.handle, '--text', text, '--enter', '--wait-submit', '15'], 30000);
  }
  async screen(session) {
    const t = await this.resolve(session);
    const r = await this.call(['terminal', 'read', '--terminal', t.handle, '--screen']);
    return { lines: r.terminal.tail || [], waiting: !!t.agentWait };
  }
  async key(session, key) {
    const keys = { enter: '\r', esc: '\x1b', up: '\x1b[A', down: '\x1b[B', tab: '\t' };
    const text = keys[key] || (/^[1-9]$/.test(key) ? key : null);
    if (!text) throw new Error('不支持的按键');
    const t = await this.resolve(session);
    return this.call(['terminal', 'send', '--terminal', t.handle, '--text', text]);
  }
  async create({ repo, name, model, effort }) {
    const args = ['worktree', 'create', '--repo', `id:${repo}`, '--name', name, '--no-parent', '--agent', 'claude', '--surface', 'terminal', '--model', model];
    if (effort) args.push('--effort', effort);
    const result = await this.call(args, 180000);
    const handle = result.launch?.outcome?.kind === 'terminal' ? result.launch.outcome.handle : result.agentTerminalHandle;
    if (!handle) throw new Error('工作树已创建，但未获得终端句柄。请在 Orca 检查并使用“接入已有会话”，不要重复新建');
    // Only bind the exact pane Orca created, never the newest transcript in a directory.
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      const sessions = await this.liveSessions();
      const found = sessions.find(s => s.terminal === handle);
      if (found) return found;
    }
    throw new Error('工作树已创建，Claude 尚未就绪。请在 Orca 完成启动后使用“接入已有会话”，本次未发送提示词');
  }
}
