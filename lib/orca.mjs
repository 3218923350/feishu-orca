// Orca CLI：项目、模型、工作树、终端
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './run.mjs';

const SUPPORT = path.join(os.homedir(), 'Library/Application Support/orca');

export function orca(bin = '/Applications/Orca.app/Contents/Resources/bin/orca') {
  async function call(args, { timeout = 120_000 } = {}) {
    const r = await run(bin, [...args, '--json'], { timeout });
    let j;
    try { j = JSON.parse(r.out); } catch { throw new Error(`orca ${args.slice(0, 2).join(' ')}: ${(r.err || r.out).trim().slice(0, 300) || `exit ${r.code}`}`); }
    if (!j.ok) { const e = new Error(`orca ${args.slice(0, 2).join(' ')}: ${j.error?.message || 'failed'}`); e.code = j.error?.code; throw e; }
    return j.result;
  }

  return {
    call,
    async repos() {
      const { repos } = await call(['repo', 'list']);
      return repos.filter((r) => r.kind === 'git').map((r) => ({ id: r.id, name: r.displayName, path: r.path }));
    },
    async worktrees() {
      const { worktrees } = await call(['worktree', 'list']);
      return worktrees.filter((w) => !w.isArchived);
    },
    // 跟在 Orca 里点「新建工作树」一样：建工作树并在终端里起 agent。
    // --no-parent：不加的话 Orca 会把调用者所在的工作树（服务跑在本仓库目录）记成父级，侧边栏里全挂到本仓库下面
    async createWorktree({ repoId, name, agent, model, effort, prompt }) {
      const args = ['worktree', 'create', '--repo', `id:${repoId}`, '--name', name, '--agent', agent, '--surface', 'terminal', '--no-parent'];
      if (model) args.push('--model', model);
      if (model && effort) args.push('--effort', effort);
      if (prompt) args.push('--prompt', prompt);
      const r = await call(args, { timeout: 300_000 });
      return { worktree: r.worktree, terminal: r.launch?.outcome?.kind === 'terminal' ? r.launch.outcome.handle : null };
    },
    removeWorktree: (id) => call(['worktree', 'rm', '--worktree', `id:${id}`, '--force'], { timeout: 180_000 }),
    async terminals() { return (await call(['terminal', 'list'])).terminals; },
    async terminal(handle) {
      try { return (await call(['terminal', 'show', '--terminal', handle])).terminal; } catch (e) { if (/not.?found|unknown|no such|invalid/i.test(e.message + e.code)) return null; throw e; }
    },
    async screen(handle) { return (await call(['terminal', 'read', '--terminal', handle])).terminal.tail; },
    async createTerminal({ worktreePath, title, command }) {
      const r = await call(['terminal', 'create', '--worktree', `path:${worktreePath}`, '--title', title, '--command', command]);
      return r.terminal.handle;
    },
    // 发一条提示词给终端里的 agent（多行会整段粘贴后回车）
    prompt: (handle, text) => call(['terminal', 'send', '--terminal', handle, '--text', text, '--enter', '--wait-submit', '15'], { timeout: 60_000 }),
    keys: (handle, text) => call(['terminal', 'send', '--terminal', handle, '--text', text]),
    closeTerminal: (handle) => call(['terminal', 'close', '--terminal', handle, '--tab']).catch(() => {}),
    focus: (handle) => call(['terminal', 'focus', '--terminal', handle]).catch(() => {}),
  };
}

// Orca 发现的模型列表：每个 agent 取最后一条（最新）
export function modelCatalog(file = path.join(SUPPORT, 'agent-model-catalog.json')) {
  const out = {};
  try {
    const at = {};
    for (const e of JSON.parse(fs.readFileSync(file, 'utf8')).entries) {
      const models = e.discovered?.models, t = e.discovered?.at || 0;
      if (!models?.length || t < (at[e.agent] ?? -1)) continue;
      at[e.agent] = t;
      // 别名（opus / sonnet…）是真正的选项，label 是它现在解析到的模型
      out[e.agent] = models.map((m) => ({ id: m.id, label: m.label && m.label !== m.id ? `${m.id}（${m.label}）` : m.id, isDefault: !!m.isDefault, efforts: (m.efforts || []).map((x) => x.value), defaultEffort: m.defaultEffort }));
    }
  } catch {}
  return out;
}

// Orca 起 claude 时带的插件（让 Orca 认出这是 agent、知道它在等输入），取最新的那份
export function agentViewPlugin(dir = path.join(SUPPORT, 'claude-agent-view')) {
  try {
    return fs.readdirSync(dir).map((d) => path.join(dir, d, 'orca-agent-view')).filter((p) => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  } catch { return null; }
}

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
