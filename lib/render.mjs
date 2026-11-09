// 一轮对话 → 若干张卡片：模型正文原样全文展示，工具调用折叠；一张放不下就续一张
const MAX_CHARS = 12000; // 飞书卡片按解析后的复杂度限长（错误码 200860），按字数和行数保守切
const MAX_LINES = 280;

const size = (s) => ({ chars: s.length, lines: s.split('\n').length });

// 长正文按行切成几段；代码块被切开时两边各自补上 ``` 保持完整
export function splitText(text, maxChars = MAX_CHARS, maxLines = MAX_LINES) {
  const out = [];
  let cur = [], chars = 0, fence = null;
  const flush = () => {
    if (!cur.length) return;
    let s = cur.join('\n');
    if (fence) s += '\n```';
    out.push(s);
    cur = fence ? [fence] : []; chars = cur.join('\n').length;
  };
  for (const raw of text.split('\n')) {
    for (let line = raw; ;) { // 超长单行硬切
      const piece = line.slice(0, maxChars - 50);
      if (cur.length && (chars + piece.length + 1 > maxChars || cur.length + 1 > maxLines)) flush();
      cur.push(piece); chars += piece.length + 1;
      const m = piece.match(/^\s*(```+|~~~+)(.*)$/);
      if (m && line === raw) fence = fence ? null : `${m[1]}${m[2]}`;
      line = line.slice(piece.length);
      if (!line) break;
    }
  }
  if (cur.length) { const s = cur.join('\n'); out.push(fence ? `${s}\n\`\`\`` : s); }
  return out;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const one = (s, n = 80) => clip(String(s || '').replace(/\s+/g, ' ').trim(), n);
const code = (s) => `\`${String(s).replace(/`/g, 'ˋ')}\``;

export function toolSummary(t) {
  const i = t.input || {};
  switch (t.name) {
    case 'Bash': return i.description ? `${one(i.description, 40)} ${code(one(i.command, 60))}` : code(one(i.command));
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return code(one(i.file_path || i.notebook_path, 90));
    case 'Grep': return `${code(one(i.pattern, 50))}${i.path ? ` in ${code(one(i.path, 50))}` : ''}`;
    case 'Glob': return code(one(i.pattern));
    case 'WebFetch': return one(i.url);
    case 'WebSearch': return code(one(i.query));
    case 'Agent': case 'Task': return one(i.description || i.subagent_type);
    case 'Skill': return code(one(i.skill));
    case 'TodoWrite': return `${(i.todos || []).filter((x) => x.status === 'completed').length}/${(i.todos || []).length} 项`;
    case 'AskUserQuestion': return one((i.questions || []).map((q) => q.question).join(' / '));
    default: return one(i.command || i.file_path || i.path || i.query || i.description || i.prompt || '');
  }
}

const ICON = { running: '⏳', ok: '✅', error: '❌' };
function toolPanel(tools, live) {
  const failed = tools.filter((t) => t.status === 'error').length;
  const last = tools[tools.length - 1];
  const title = live && last.status === 'running'
    ? `⏳ **正在** ${last.name} ${toolSummary(last)}${tools.length > 1 ? `（第 ${tools.length} 个工具）` : ''}`
    : `🔧 **${tools.length} 个工具调用**${failed ? `（${failed} 个失败）` : ''} · ${[...new Set(tools.map((t) => t.name))].slice(0, 4).join('、')}`;
  const shown = tools.slice(-40);
  const lines = shown.map((t) => {
    let l = `${ICON[t.status] || '⏳'} **${t.name}** ${toolSummary(t)}`;
    if (t.name === 'TodoWrite') l += '\n' + (t.input.todos || []).map((x) => `  ${x.status === 'completed' ? '☑' : x.status === 'in_progress' ? '▶' : '☐'} ${one(x.content, 60)}`).join('\n');
    if (t.name === 'AskUserQuestion' && t.result) l += `\n  ↳ ${one(t.result, 200)}`;
    if (t.status === 'error' && t.result) l += `\n\`\`\`\n${clip(t.result.trim(), 600)}\n\`\`\``;
    return l;
  });
  if (tools.length > shown.length) lines.unshift(`…前面还有 ${tools.length - shown.length} 个`);
  return {
    tag: 'collapsible_panel', expanded: false,
    header: { title: { tag: 'markdown', content: title }, icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' }, icon_position: 'right', icon_expanded_angle: -180 },
    border: { color: failed ? 'red' : 'grey', corner_radius: '5px' }, padding: '4px 8px 4px 8px',
    elements: [{ tag: 'markdown', content: lines.join('\n'), text_size: 'notation' }],
  };
}

// 一轮的内容 → 单元：每段正文（太长的切开）一个，每组连续工具调用一个
export function units(turn, live, maxChars = MAX_CHARS) {
  const out = [];
  if (turn.source === 'computer' && turn.prompt) {
    for (const [i, s] of splitText(turn.prompt, 3000, 60).entries()) out.push({ el: { tag: 'markdown', content: `${i ? '' : '💻 **电脑上说：**\n'}${s.split('\n').map((l) => `> ${l}`).join('\n')}` }, ...size(s) });
  }
  if (turn.source === 'system') out.push({ el: { tag: 'markdown', content: `🔔 **后台任务：** ${one(turn.prompt, 300)}`, text_size: 'notation' }, chars: 300, lines: 2 });
  if (turn.source === 'first' && turn.prompt) out.push({ el: { tag: 'markdown', content: `📝 **第一句：** ${one(turn.prompt, 300)}`, text_size: 'notation' }, chars: 300, lines: 2 });
  turn.blocks.forEach((b, i) => {
    if (b.type === 'steer') { const s = `${b.source === 'computer' ? '💻 **电脑上插话：**' : '💬 **你插话：**'} ${b.text}`; out.push({ el: { tag: 'markdown', content: s.split('\n').map((l) => `> ${l}`).join('\n') }, ...size(s) }); return; }
    if (b.type === 'tools') { const el = toolPanel(b.tools, live && i === turn.blocks.length - 1); out.push({ el, chars: Math.min(8000, b.tools.length * 120), lines: Math.min(120, b.tools.length * 2) }); return; }
    for (const s of splitText(b.text, maxChars, Math.round(maxChars / 40))) out.push({ el: { tag: 'markdown', content: b.error ? `⚠️ ${s}` : s }, ...size(s) });
  });
  return out;
}

// 从 from 开始，这张卡能装下几个单元（至少一个）
export function fit(us, from, maxChars = MAX_CHARS, maxLines = Math.round(maxChars / 40)) {
  let chars = 0, lines = 0, n = 0;
  for (let i = from; i < us.length; i++) {
    chars += us[i].chars; lines += us[i].lines;
    if (n && (chars > maxChars || lines > maxLines)) break;
    n++;
  }
  return n;
}

const STATUS = {
  running: { title: '⏳ 处理中', template: 'blue' },
  done: { title: '✅ 完成', template: 'green' },
  interrupted: { title: '⏹ 已中断', template: 'grey' },
  error: { title: '⚠️ 终端断了', template: 'red' },
};

export const dur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`; };

// 第 k 张卡：第一张带标题，最后一张（还在跑时）带状态和按钮
export function turnCard(turn, k, els, { last, chatId }) {
  const st = STATUS[turn.status] || STATUS.running;
  const live = turn.status === 'running';
  const elements = [...els];
  if (!elements.length) elements.push({ tag: 'markdown', content: live ? '…' : '（没有文字回复）', text_size: 'notation' });
  if (last) {
    const took = dur((turn.endedAt || Date.now()) - turn.startedAt);
    const note = live ? `⏳ 已经 ${took}` : turn.status === 'done' ? `用时 ${took}` : turn.status === 'interrupted' ? `中断前跑了 ${took}` : (turn.note || '');
    elements.push({ tag: 'markdown', content: note, text_size: 'notation', text_color: 'grey' });
    if (live) elements.push(buttons([['⏹ 中断', { fo: 'esc', chat: chatId }, 'danger'], ['🖥 看终端', { fo: 'screen', chat: chatId }, 'default']]));
  }
  const card = { schema: '2.0', config: { update_multi: true, summary: { content: k === 0 ? `${st.title} ${one(turn.prompt, 30)}` : '（续）' } }, body: { elements } };
  if (k === 0) card.header = { title: { tag: 'plain_text', content: st.title }, template: st.template, ...(turn.source === 'computer' ? { text_tag_list: [{ tag: 'text_tag', text: { tag: 'plain_text', content: '电脑上' }, color: 'violet' }] } : {}) };
  else card.header = { title: { tag: 'plain_text', content: `（续 ${k + 1}）` }, template: st.template };
  return card;
}

export function buttons(list) {
  return { tag: 'column_set', flex_mode: 'flow', horizontal_spacing: '8px', columns: list.map(([text, value, type = 'default', confirm]) => ({
    tag: 'column', width: 'auto',
    elements: [{ tag: 'button', text: { tag: 'plain_text', content: text }, type, size: 'small', behaviors: [{ type: 'callback', value }], ...(confirm ? { confirm: { title: { tag: 'plain_text', content: confirm[0] }, text: { tag: 'plain_text', content: confirm[1] } } } : {}) }],
  })) };
}
