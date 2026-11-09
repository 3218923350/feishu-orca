// 控制台、会话列表、群里置顶的会话卡、等你操作、看终端
import { buttons, dur, splitText } from './render.mjs';

const pt = (content) => ({ tag: 'plain_text', content });
const md = (content, extra = {}) => ({ tag: 'markdown', content, ...extra });
const opt = (label, value) => ({ text: pt(label), value });
const card = (header, elements, summary) => ({ schema: '2.0', config: { update_multi: true, ...(summary ? { summary: { content: summary } } : {}) }, header, body: { elements } });
const head = (title, template = 'indigo', subtitle) => ({ title: pt(title), template, ...(subtitle ? { subtitle: pt(subtitle) } : {}) });
export const chatLink = (chatId) => `https://applink.feishu.cn/client/chat/open?openChatId=${chatId}`;
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? '刚刚' : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`; };
const EFFORT = { '': '默认', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };

// 私聊里的控制台：选项目、模型 → 新建工作树 + 群
export function consoleCard({ repos, models, last = {}, docUrl }) {
  const modelOpts = models.map((m) => opt(`${m.agentLabel} · ${m.label}`, `${m.agent}:${m.id}`));
  const repoOpts = repos.map((r) => opt(r.name, r.id));
  const sel = (name, placeholder, options, initial) => ({ tag: 'select_static', name, placeholder: pt(placeholder), options, width: 'fill', ...(initial && options.some((o) => o.value === initial) ? { initial_option: initial } : {}) });
  return card(head('Orca · 新会话', 'indigo', '选项目和模型，建一个工作树，模型在里面跑；会话在一个新群里'), [
    { tag: 'form', name: 'new', elements: [
      { tag: 'column_set', horizontal_spacing: '8px', columns: [
        { tag: 'column', width: 'weighted', weight: 3, elements: [sel('repo', '项目', repoOpts, last.repo)] },
        { tag: 'column', width: 'weighted', weight: 3, elements: [sel('model', '模型', modelOpts, last.model)] },
        { tag: 'column', width: 'weighted', weight: 2, elements: [sel('effort', '思考强度', Object.entries(EFFORT).map(([v, l]) => opt(l, v || 'default')), last.effort || 'default')] },
      ] },
      { tag: 'input', name: 'name', placeholder: pt('工作树名（可空，自动起名）'), max_length: 60 },
      { tag: 'input', name: 'first', placeholder: pt('第一句话（可空；长内容建好后在群里发，或者把消息转发进去）'), input_type: 'multiline_text', rows: 3, auto_resize: true, max_length: 1000 },
      { tag: 'button', name: 'create', text: pt('新建会话'), type: 'primary_filled', width: 'fill', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { fo: 'create' } }] },
    ] },
    { tag: 'column_set', flex_mode: 'flow', horizontal_spacing: '8px', columns: [
      ...buttons([['📋 Orca 里的会话', { fo: 'list', page: 0 }], ['🔄 刷新项目和模型', { fo: 'console' }]]).columns,
      ...(docUrl ? [{ tag: 'column', width: 'auto', elements: [{ tag: 'button', text: pt('📖 使用说明'), size: 'small', behaviors: [{ type: 'open_url', default_url: docUrl }] }] }] : []),
    ] },
  ], 'Orca 控制台');
}

export function creatingCard({ repo, model, name, first }) {
  return card(head(`⏳ 正在新建 ${repo}/${name}`, 'blue'), [md(`模型：${model}${first ? `\n第一句：${first.slice(0, 200)}` : ''}`)]);
}
export function createdCard({ repo, model, name, chatId, path }) {
  return card(head(`✅ 已新建 ${repo}/${name}`, 'green'), [md(`模型：${model}\n工作树：\`${path}\``),
    { tag: 'button', text: pt('进入会话群'), type: 'primary', behaviors: [{ type: 'open_url', default_url: chatLink(chatId) }] }]);
}
export function failedCard(title, err) {
  return card(head(`❌ ${title}`, 'red'), [md(`\`\`\`\n${String(err).slice(0, 1500)}\n\`\`\``)]);
}

// Orca 里的会话：终端和 Orca 聊天开的 Claude 会话，最近的在前
export function listCard(items, page, pages) {
  const rows = items.flatMap((s) => [{
    tag: 'column_set', horizontal_spacing: '8px', columns: [
      { tag: 'column', width: 'weighted', weight: 5, vertical_align: 'center', elements: [md(`**${esc(s.title || s.lastPrompt || '（无标题）').slice(0, 50)}**\n<font color='grey'>${s.repo} · ${s.worktree} · ${ago(s.mtime)} · ${s.live ? '🟢 终端在跑' : s.entrypoint === 'sdk-ts' ? 'Orca 聊天' : '终端已关'}${s.chatId ? ' · 已在飞书' : ''}</font>`)] },
      { tag: 'column', width: 'auto', vertical_align: 'center', elements: [s.chatId
        ? { tag: 'button', text: pt('进群'), size: 'small', behaviors: [{ type: 'open_url', default_url: chatLink(s.chatId) }] }
        : { tag: 'button', text: pt('接着聊'), size: 'small', type: 'primary', behaviors: [{ type: 'callback', value: { fo: 'attach', id: s.id, cwd: s.cwd } }] }] },
    ] }, { tag: 'hr' }]);
  rows.pop();
  const nav = [];
  if (page > 0) nav.push(['上一页', { fo: 'list', page: page - 1 }]);
  if (page < pages - 1) nav.push(['下一页', { fo: 'list', page: page + 1 }]);
  nav.push(['🔄 刷新', { fo: 'list', page }]);
  return card(head(`📋 Orca 里的会话（${page + 1}/${pages}）`, 'indigo', '点「接着聊」建个群续上这个会话；Orca 聊天开的会话会在终端里续上，电脑上那个聊天标签别同时用'), [...(rows.length ? rows : [md('没有找到会话')]), buttons(nav)]);
}

// 群里置顶的会话卡
export function sessionCard(s, { live }) {
  const lines = [`**项目**：${s.repo.name}　**分支**：\`${(s.worktree.branch || '').replace('refs/heads/', '')}\``, `**工作树**：\`${s.worktree.path}\``, `**模型**：${s.modelLabel}${s.effort ? ` · ${s.effort}` : ''}`, `**终端**：${s.closed ? '会话已结束（再说话会重新打开）' : live ? '🟢 在跑' : '未打开（说话时自动续上）'}`];
  if (s.sessionId) lines.push(`<font color='grey'>会话 ${s.sessionId}</font>`);
  return card(head(s.title || `${s.repo.name}/${s.worktree.name}`, s.closed ? 'grey' : 'indigo', '直接说话就是发给模型；转发的消息会等你补一句再发'), [
    md(lines.join('\n')),
    buttons([
      ['🖥 看终端', { fo: 'screen', chat: s.chatId }],
      ['⏹ 中断', { fo: 'esc', chat: s.chatId }],
      ['💻 在 Orca 里打开', { fo: 'focus', chat: s.chatId }],
      ['🔁 重开终端', { fo: 'restart', chat: s.chatId }, 'default', ['重开终端', '关掉现在的终端，新开一个续上同一个会话。正在跑的这一轮会断。']],
      ['结束会话', { fo: 'close', chat: s.chatId }, 'default', ['结束会话', '关掉终端，工作树保留；之后在群里说话会重新打开。']],
      ['🗑 删除工作树', { fo: 'remove', chat: s.chatId }, 'danger', ['删除工作树', `会删掉 ${s.worktree.path}（未提交的改动会丢），并关掉终端。确定？`]],
    ]),
  ], s.title || s.worktree.name);
}

// 终端在等你操作（选项、确认）
export function waitCard(chatId, { question, options, screen }, answered) {
  if (answered) return card(head('🙋 已回答', 'grey'), [md(`\`\`\`\n${screen.slice(-1500)}\n\`\`\``, { text_size: 'notation' }), md(answered, { text_size: 'notation' })]);
  const els = [md(question ? `**${esc(question)}**` : '终端在等你操作：')];
  if (options.length) {
    els.push(...options.map((o) => ({ tag: 'button', text: pt(`${o.n}. ${o.label}`.slice(0, 60)), width: 'fill', type: o.n === '1' ? 'primary' : 'default', behaviors: [{ type: 'callback', value: { fo: 'key', chat: chatId, k: o.n, label: o.label } }] })));
  }
  els.push({ tag: 'collapsible_panel', expanded: !options.length, header: { title: md('终端画面', { text_size: 'notation' }) }, elements: [md(`\`\`\`\n${screen.slice(-2500)}\n\`\`\``, { text_size: 'notation' })] });
  els.push({ tag: 'form', name: 'ans', elements: [
    { tag: 'input', name: 'text', placeholder: pt('自己写回答（也可以直接在群里说）'), input_type: 'multiline_text', rows: 1, auto_resize: true },
    { tag: 'column_set', flex_mode: 'flow', horizontal_spacing: '8px', columns: [
      { tag: 'column', width: 'auto', elements: [{ tag: 'button', name: 'send', text: pt('发送'), type: 'primary', size: 'small', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { fo: 'answer', chat: chatId } }] }] },
      ...[['回车', '\r'], ['Esc', '\x1b'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['Tab', '\t']].map(([l, k]) => ({ tag: 'column', width: 'auto', elements: [{ tag: 'button', text: pt(l), size: 'small', behaviors: [{ type: 'callback', value: { fo: 'raw', chat: chatId, k, label: l } }] }] })),
    ] },
  ] });
  return card(head('🙋 等你回答', 'orange'), els, '终端在等你回答');
}

export function screenCard(lines, note) {
  const text = lines.join('\n').trimEnd();
  return card(head('🖥 终端画面', 'grey', note), [md(`\`\`\`\n${splitText(text, 6000, 120).pop() || '（空）'}\n\`\`\``, { text_size: 'notation' })]);
}

// 接上已有会话时补最近几轮
export function historyCard(turns) {
  const els = turns.map((t) => md(`**${t.source === 'cli' ? '💻 ' : ''}你：** ${esc(t.prompt).slice(0, 600)}\n\n${(t.reply || '（没有文字回复）').slice(0, 3000)}`));
  return card(head('📜 最近几轮', 'grey', '之前的对话，后面接着聊'), els.length ? els : [md('（还没有对话）')]);
}

export function heldCard(chatId, n) {
  return card(head('📥 收到转发', 'wathet'), [md(`收到 ${n} 条转发/附件，接着说要它做什么，会一起发给模型。`), buttons([['直接发给模型', { fo: 'flush', chat: chatId }, 'primary'], ['不要了', { fo: 'drop', chat: chatId }]])]);
}

export const noticeCard = (text, template = 'grey') => card(undefined, [md(text, { text_size: 'notation' })], text.slice(0, 40));
export const esc = (s) => String(s || '').replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'));
export { dur };
