// Claude Code 会话记录（~/.claude/projects/<目录>/<session>.jsonl）：找会话、增量读、解析成事件
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROJECTS = path.join(os.homedir(), '.claude/projects');
export const projectDir = (cwd) => path.join(PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
export const transcriptPath = (cwd, id) => path.join(projectDir(cwd), `${id}.jsonl`);

function head(file, bytes = 65536) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(bytes); const n = fs.readSync(fd, b, 0, bytes, 0); return b.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
}
function tail(file, bytes = 262144) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes), b = Buffer.alloc(size - start);
    fs.readSync(fd, b, 0, b.length, start);
    return b.toString('utf8');
  } finally { fs.closeSync(fd); }
}
const lines = (s) => s.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// 会话的元信息：入口（cli=终端 / sdk-ts=Orca 聊天 / sdk-cli=claude -p 的旁路，不算）、标题、最后一句
export function sessionInfo(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const id = path.basename(file, '.jsonl');
  const h = lines(head(file));
  const entrypoint = h.find((d) => d.entrypoint)?.entrypoint;
  const t = lines(tail(file));
  let title = '', lastPrompt = '';
  for (const d of t) {
    if (d.type === 'ai-title' && d.aiTitle) title = d.aiTitle;
    if (d.type === 'custom-title' && d.customTitle) title = d.customTitle;
    if (d.type === 'last-prompt' && d.lastPrompt) lastPrompt = d.lastPrompt;
  }
  return { id, file, entrypoint, title, lastPrompt, mtime: st.mtimeMs, created: st.birthtimeMs, size: st.size };
}

// 某个目录下的真会话（终端或 Orca 聊天开的），新的在前
export function sessionsIn(cwd, limit = 20) {
  const dir = projectDir(cwd);
  let files; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); } catch { return []; }
  const byTime = files.map((f) => { try { return [f, fs.statSync(f).mtimeMs]; } catch { return null; } }).filter(Boolean).sort((a, b) => b[1] - a[1]);
  const out = [];
  for (const [f] of byTime) { // 只打开最新的几个：一个目录里常有几百个 claude -p 的旁路文件
    const s = sessionInfo(f);
    if (s && (s.entrypoint === 'cli' || s.entrypoint === 'sdk-ts')) out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

// 某时刻之后在这个目录里新出现的终端会话（新建工作树、/clear 之后）
export function newestSince(cwd, sinceMs, except) {
  return sessionsIn(cwd).find((s) => s.entrypoint === 'cli' && s.mtime >= sinceMs && s.id !== except) || null;
}

// 增量读：只返回完整的行；文件被换掉（变短）就从头读
export function readNew(file, offset) {
  let st; try { st = fs.statSync(file); } catch { return { offset, entries: [] }; }
  if (st.size < offset) offset = 0;
  if (st.size === offset) return { offset, entries: [] };
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(st.size - offset);
    fs.readSync(fd, b, 0, b.length, offset);
    const last = b.lastIndexOf(0x0a);
    if (last < 0) return { offset, entries: [] };
    return { offset: offset + last + 1, entries: lines(b.subarray(0, last).toString('utf8')) };
  } finally { fs.closeSync(fd); }
}

const SYS_TAGS = /^<(local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-stdout|bash-stderr)>/;
const textOf = (c) => typeof c === 'string' ? c : (c || []).map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[图片]' : '')).filter(Boolean).join('\n');

// 一行记录 → 事件：prompt（用户说了一句）/ text / tool / result / end（这一轮结束）/ interrupted
export function events(d) {
  if (d.isSidechain) return [];
  // 模型忙的时候说的话：Claude Code 先排队，到下一个工具调用的间隙塞进这一轮（queued_command）
  if (d.type === 'attachment' && d.attachment?.type === 'queued_command') {
    const text = String(d.attachment.prompt || '').trim();
    return text && !text.startsWith('<task-notification>') ? [{ kind: 'steer', text }] : [];
  }
  if (d.type === 'system' && d.subtype === 'turn_duration') return [{ kind: 'end', durationMs: d.durationMs }];
  if (d.type === 'assistant') {
    const out = [];
    for (const b of d.message?.content || []) {
      if (b.type === 'text' && b.text.trim()) out.push({ kind: 'text', text: b.text, error: !!d.isApiErrorMessage });
      if (b.type === 'tool_use') out.push({ kind: 'tool', id: b.id, name: b.name, input: b.input || {} });
    }
    return out;
  }
  if (d.type !== 'user' || d.isMeta || d.isCompactSummary) return [];
  const c = d.message?.content;
  if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) {
    return c.filter((b) => b.type === 'tool_result').map((b) => ({ kind: 'result', id: b.tool_use_id, error: !!b.is_error, text: textOf(b.content) }));
  }
  const text = textOf(c).trim();
  if (!text) return [];
  if (/^\[Request interrupted by user/.test(text)) return [{ kind: 'interrupted' }];
  const cmd = text.match(/<command-name>(.*?)<\/command-name>/s);
  if (cmd) { const args = text.match(/<command-args>(.*?)<\/command-args>/s)?.[1]?.trim(); return [{ kind: 'command', text: `${cmd[1].trim()}${args ? ` ${args}` : ''}` }]; }
  if (SYS_TAGS.test(text)) return [];
  if (/^<task-notification>/.test(text)) { const sum = text.match(/<summary>(.*?)<\/summary>/s)?.[1]?.trim(); return [{ kind: 'notification', text: sum || '后台任务有结果了' }]; }
  const bash = text.match(/^<bash-input>(.*?)<\/bash-input>/s);
  if (bash) return [{ kind: 'command', text: `! ${bash[1].trim()}` }];
  return [{ kind: 'prompt', text }];
}
