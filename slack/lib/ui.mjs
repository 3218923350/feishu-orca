export const plain = text => ({ type: 'plain_text', text: String(text).slice(0, 150), emoji: true });
export const escape = text => String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const section = text => ({ type: 'section', text: { type: 'mrkdwn', text: String(text).slice(0, 3000) || '…' } });
export const button = (action, label, value = action) => ({ type: 'button', action_id: action, text: plain(label), value });
export const actions = elements => ({ type: 'actions', elements });
export const context = text => ({ type: 'context', elements: [{ type: 'mrkdwn', text: String(text).slice(0, 2000) }] });
export const option = (label, value) => ({ text: { type: 'plain_text', text: String(label).slice(0, 75) }, value: String(value) });
export function controlPanel(layout = 'thread') {
  return [section(`*MAC-hand · Slack*\n用 Slack 继续本机 Orca 中的 Claude 会话。${layout === 'channel' ? '每个会话一个独立私有频道。' : '一个会话对应一个线程。'}`), actions([button('new', '新建会话'), button('list', '接入已有会话'), button('refresh', '刷新项目和模型')]), context(`${layout === 'channel' ? '在会话频道里' : '在会话线程里'}直接回复。只有配置的主人可以操作。`)];
}
export const SESSION_PAGE_SIZE = 8;
export function sessionListView(snapshot, mode = 'all', requestedPage = 0) {
  const items = mode === 'history' ? snapshot.history : mode === 'live' ? snapshot.current.filter(s => s.available) : snapshot.current;
  const pages = Math.max(1, Math.ceil(items.length / SESSION_PAGE_SIZE));
  const page = Math.max(0, Math.min(pages - 1, Number.isSafeInteger(requestedPage) ? requestedPage : 0));
  const label = { all: '全部 Orca 会话', live: '当前可接入', history: 'Claude 历史记录' }[mode] || '全部 Orca 会话';
  const blocks = [section(`*${label}* · 共 ${items.length} 条 · 第 ${page + 1}/${pages} 页`), actions([button('list_all', '全部会话'), button('list_live', '仅可接入'), button('list_history', '历史记录'), button('list_refresh', '刷新', JSON.stringify({ mode }))])];
  if (snapshot.warnings?.length) blocks.push(context(snapshot.warnings.map(escape).join('\n')));
  for (const s of items.slice(page * SESSION_PAGE_SIZE, (page + 1) * SESSION_PAGE_SIZE)) {
    blocks.push(section(`*${escape((s.title || '未命名会话').slice(0, 200))}*\n${escape(s.path || '')}\n${s.available ? '🟢 可接入' : `⚪ ${escape(s.reason || '暂不能确认会话状态')}`}`));
    if (s.available) blocks.push(actions([button('attach', '接入 / 打开聊天', s.key)]));
  }
  if (!items.length) blocks.push(section('此分类暂无会话。可以切换分类，或在 Orca 中打开原会话后刷新。'));
  const nav = [];
  if (page > 0) nav.push(button('list_prev', '上一页', JSON.stringify({ mode, page: page - 1 })));
  if (page + 1 < pages) nav.push(button('list_next', '下一页', JSON.stringify({ mode, page: page + 1 })));
  if (nav.length) blocks.push(actions(nav));
  blocks.push(context('只列本机 Orca 中的会话；历史记录按最近活动排序。不能接入的会话会保留在列表并说明原因。'));
  return { type: 'modal', title: plain('Orca 会话'), close: plain('关闭'), blocks };
}
export function sessionCard(s) {
  return [section(`*${escape(s.title || 'Claude 会话')}*\n${escape(s.path)}\n${s.paused ? '⏸ 已暂停 Slack 同步' : s.layout === 'channel' ? '💬 直接在这个频道发消息即可继续会话' : '💬 在这个线程里回复即可继续会话'}`), actions([button('prompt', '发指令', s.id), button('screen', '看终端', s.id), button('stop', '中断', s.id), button('keys', '回答 / 按键', s.id), button(s.paused ? 'resume' : 'pause', s.paused ? '恢复同步' : '暂停同步', s.id)])];
}
const input = (id, label, element, optional = false) => ({ type: 'input', block_id: id, label: plain(label), optional, element: { ...element, action_id: id } });
export function newModal(catalog) {
  const efforts = [...new Set(catalog.models.flatMap(m => m.efforts))];
  return { type: 'modal', callback_id: 'create_session', title: plain('新建 Orca 会话'), submit: plain('新建'), close: plain('取消'), blocks: [
    input('repo', '项目', { type: 'static_select', options: catalog.repos.slice(0, 100).map(r => option(r.displayName || r.name || r.path, r.id)) }),
    input('model', 'Claude 模型', { type: 'static_select', options: catalog.models.slice(0, 100).map(m => option(`${m.id} · ${m.label}`, m.id)) }),
    ...(efforts.length ? [input('effort', '思考强度（留空使用默认）', { type: 'static_select', options: efforts.map(e => option(e, e)) }, true)] : []),
    input('name', '工作树名（字母、数字、短横线）', { type: 'plain_text_input', max_length: 50 }, true),
    input('prompt', '第一句话', { type: 'plain_text_input', multiline: true, max_length: 3000 }, true),
  ] };
}
export function valueOf(view, key) { const x = view.state.values[key]?.[key]; return x?.selected_option?.value || x?.value || ''; }
export function validateNew(view, catalog) {
  const fields = Object.fromEntries(['repo', 'model', 'effort', 'name', 'prompt'].map(k => [k, valueOf(view, k)]));
  const errors = {};
  if (!catalog.repos.some(r => r.id === fields.repo)) errors.repo = '项目已变化，请刷新后重试';
  const model = catalog.models.find(m => m.id === fields.model);
  if (!model) errors.model = '模型不可用，请刷新后重试';
  if (fields.effort && !model?.efforts.includes(fields.effort)) errors.effort = '这个模型不支持该思考强度，请留空或换一个';
  if (fields.name && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$/.test(fields.name)) errors.name = '使用字母、数字、短横线或下划线';
  return { fields, errors };
}
export function waitingCard(s, parsed) {
  return [section(`🙋 *等你在终端中回答*\n${escape(parsed.question || '请查看当前终端，再选择按键。')}`), ...chunkText(parsed.screen, 2400).slice(0, 2).map(x => section('```' + escape(x).replace(/```/g, '｀｀｀') + '```')), actions([button('keys', '回答 / 按键', s.id), button('screen', '刷新终端', s.id)])];
}
export function keyModal(s) {
  return { type: 'modal', callback_id: 'key_session', private_metadata: s.id, title: plain('终端按键'), submit: plain('发送按键'), close: plain('取消'), blocks: [section('只发送你选择的一个按键。选择数字后，如终端要求确认，再单独发送 Enter。'), input('key', '按键', { type: 'static_select', options: ['enter', 'esc', 'up', 'down', 'tab', ...Array.from({ length: 9 }, (_, i) => String(i + 1))].map(k => option(k, k)) })] };
}
export function promptModal(s) {
  return { type: 'modal', callback_id: 'send_session', private_metadata: s.id, title: plain('发送给 Claude'), submit: plain('发送'), close: plain('取消'), blocks: [input('prompt', '消息或 Claude 命令（如 /compact、/clear）', { type: 'plain_text_input', multiline: true, max_length: 3000 })] };
}
export function chunkText(text, size = 2700) {
  const chunks = [];
  let rest = String(text || '');
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    if (/[\uD800-\uDBFF]/.test(rest[cut - 1])) cut--;
    chunks.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  if (rest || !chunks.length) chunks.push(rest);
  return chunks;
}
export function renderTurn(turn) {
  const status = { running: '⏳ 处理中', done: '✅ 完成', interrupted: '⏹ 已中断' }[turn.status] || '⏳ 处理中';
  const text = [turn.prompt ? `你${turn.source === 'computer' ? '（电脑上）' : ''}：${turn.prompt}` : '', ...turn.blocks.map(b => b.kind === 'tool' ? `› ${b.name}${b.error ? '（工具报错）' : ''}` : b.text)].filter(Boolean).join('\n\n');
  // Escape first so Slack never parses assistant-provided @here/@channel links.
  return chunkText(escape(text || '等待模型输出…')).map((chunk, i) => ({ text: `${status}${i ? ` · 续 ${i + 1}` : ''}`, blocks: [context(`${status} · ${turn.source === 'computer' ? '电脑上' : 'Slack'}${i ? ` · 续 ${i + 1}` : ''}`), section(chunk)] }));
}
