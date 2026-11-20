import path from 'node:path';
import crypto from 'node:crypto';
import { authorized, redact } from './config.mjs';
import { downloadFile } from './media.mjs';
import { controlPanel, newModal, validateNew, keyModal, promptModal, sessionListView, valueOf, section, actions, button, escape, chunkText, plain } from './ui.mjs';

export function registerSlack(app, engine, { log = () => {} } = {}) {
  const { config, state, orca } = engine;
  let catalog = { repos: [], models: [] };
  const lists = new Map(); // Each open modal owns a stable snapshot; another window cannot replace it.
  const allowed = (body, user) => authorized(config, user || body.user_id || body.user?.id || body.event?.user, body.team_id || body.team?.id || body.team);
  const errorText = e => redact([e?.message || e, ...(e?.data?.response_metadata?.messages || [])].join('\n')).slice(0, 1800);
  const safe = fn => async args => { try { await fn(args); } catch (e) { log('slack-handler', errorText(e)); } };
  async function sessionLink(s, client) {
    const fallback = `https://app.slack.com/client/${config.teamId}/${s.channel}`;
    if (s.layout === 'channel') return fallback;
    try { return (await client.chat.getPermalink({ channel: s.channel, message_ts: s.thread })).permalink || fallback; }
    catch (e) { log('session-link', errorText(e)); return fallback; }
  }
  async function notifyError(s, e) { await engine.post(s, `⚠️ ${errorText(e)}`).catch(err => log('error-notification', errorText(err))); }
  async function openNew(body, client) {
    // Trigger IDs expire in 3s: open immediately, fetch Orca AFTER the modal exists.
    const { view } = await client.views.open({ trigger_id: body.trigger_id, view: { type: 'modal', title: plain('新建 Orca 会话'), close: plain('关闭'), blocks: [section('正在加载项目和模型…')] } });
    try {
      catalog = await orca.catalog();
      if (!catalog.repos.length || !catalog.models.length) throw new Error('请先在 Orca 中添加项目并加载 Claude 模型');
      await client.views.update({ view_id: view.id, view: newModal(catalog) });
    } catch (e) { await client.views.update({ view_id: view.id, view: { type: 'modal', title: plain('暂时无法新建'), close: plain('关闭'), blocks: [section(escape(errorText(e)))] } }); }
  }
  async function showList(body, client) {
    const { view } = await client.views.open({ trigger_id: body.trigger_id, view: { type: 'modal', title: plain('Orca 会话'), close: plain('关闭'), blocks: [section('正在查找本机运行中的 Claude 会话…')] } });
    try {
      const snapshot = structuredClone(await orca.sessionCatalog());
      for (const [id, list] of lists) if (Date.now() - list.at > 30 * 60_000) lists.delete(id);
      lists.set(view.id, { ...snapshot, at: Date.now() });
      await client.views.update({ view_id: view.id, view: sessionListView(snapshot) });
    } catch (e) { await client.views.update({ view_id: view.id, view: { type: 'modal', title: plain('Orca 会话'), close: plain('关闭'), blocks: [section(escape(errorText(e)))] } }); }
  }
  app.command('/orca', safe(async ({ ack, body, respond }) => {
    await ack();
    if (!allowed(body)) return respond({ text: '此应用只允许配置的主人操作。', response_type: 'ephemeral' });
    await respond({ text: 'MAC-hand 控制台', blocks: controlPanel(config.sessionLayout), response_type: 'ephemeral' });
  }));
  app.action(/^list_(next|prev|all|live|history|refresh)$/, safe(async ({ ack, body, action, client }) => {
    await ack(); if (!allowed(body)) return;
    const id = body.view?.id;
    let snapshot = lists.get(id);
    const command = action.action_id.slice(5);
    let params = {};
    if (['next', 'prev', 'refresh'].includes(command)) { try { params = JSON.parse(action.value); } catch {} }
    const mode = ['all', 'live', 'history'].includes(command) ? command : ['all', 'live', 'history'].includes(params.mode) ? params.mode : 'all';
    try {
      if (command === 'refresh' || !snapshot || Date.now() - snapshot.at > 30 * 60_000) {
        snapshot = { ...structuredClone(await orca.sessionCatalog()), at: Date.now() };
        lists.set(id, snapshot);
      }
      await client.views.update({ view_id: id, view: sessionListView(snapshot, mode, command === 'refresh' ? 0 : params.page || 0) });
    } catch (e) { log('session-list', errorText(e)); }
  }));
  app.event('app_home_opened', safe(async ({ body, event, client }) => {
    if (!allowed(body, event.user)) return;
    const blocks = controlPanel(config.sessionLayout);
    for (const s of engine.sessions.slice(-15).reverse()) {
      const link = await sessionLink(s, client);
      blocks.push(section(`<${link}|${escape(s.title)}> ${s.paused ? '· 已暂停' : ''}`));
    }
    const pending = Object.values(state.data.jobs).filter(j => j.status === 'started' || j.status === 'uncertain');
    if (pending.length) blocks.push(section(`⚠️ 有 ${pending.length} 次新建操作结果未确认。请先在 Orca 检查并接入已有会话，避免重复创建。`));
    await client.views.publish({ user_id: event.user, view: { type: 'home', blocks } });
  }));
  app.action(/^(new|list|refresh)$/, safe(async ({ ack, body, action, client }) => {
    await ack(); if (!allowed(body)) return;
    if (action.action_id === 'list') return showList(body, client);
    return openNew(body, client);
  }));
  app.action('attach', safe(async ({ ack, body, action, client }) => {
    await ack(); if (!allowed(body)) return;
    let stage = '查找会话';
    try {
      await engine.queue.run('attach', async () => {
        const snapshot = lists.get(body.view.id);
        const live = snapshot && [...snapshot.current, ...snapshot.history].find(s => s.key === action.value && s.available);
        if (!live) throw new Error('会话列表已过期，请关闭后重新打开');
        stage = '创建会话卡片';
        const s = await engine.attach(live);
        stage = '获取会话链接';
        const permalink = await sessionLink(s, client);
        stage = '更新接入弹窗';
        await client.views.update({ view_id: body.view.id, view: { type: 'modal', title: plain('已接入'), close: plain('完成'), blocks: [section(`已绑定同一个 Claude 会话。\n<${permalink}|打开独立聊天 / 会话>`)] } });
      });
    } catch (e) { log('attach-failed', stage, errorText(e)); await client.views.update({ view_id: body.view.id, view: { type: 'modal', title: plain('暂未接入'), close: plain('关闭'), blocks: [section(escape(`${stage}：${errorText(e)}`))] } }); }
  }));
  app.view('create_session', safe(async ({ ack, body, view, client }) => {
    if (!allowed(body)) return ack({ response_action: 'clear' });
    const { fields, errors } = validateNew(view, catalog);
    if (Object.keys(errors).length) return ack({ response_action: 'errors', errors });
    await ack();
    await engine.queue.run('create', async () => {
      if (state.data.jobs[view.id]) return;
      const job = state.data.jobs[view.id] = { status: 'started', at: Date.now(), name: fields.name || `slack-${crypto.randomBytes(4).toString('hex')}` };
      state.save();
      let s;
      try {
        const live = await orca.create({ ...fields, name: job.name });
        s = await engine.attach(live); job.sessionId = s.id; job.status = 'created'; state.save();
        if (fields.prompt) await engine.send(s, fields.prompt, `first:${view.id}`);
      } catch (e) {
        if (job.status !== 'created') job.status = 'uncertain'; state.save();
        if (s) await notifyError(s, e);
        else await client.chat.postMessage({ channel: config.channelId, text: `⚠️ 新建 ${job.name} 未完成：${errorText(e)}。请先检查 Orca，再接入已有会话。`, parse: 'none' });
      }
    });
  }));
  app.action(/^(prompt|screen|stop|keys|pause|resume)$/, safe(async ({ ack, body, action, client }) => {
    await ack(); if (!allowed(body)) return;
    const s = engine.session(action.value);
    try {
      if (action.action_id === 'keys') return await client.views.open({ trigger_id: body.trigger_id, view: keyModal(s) });
      if (action.action_id === 'prompt') return await client.views.open({ trigger_id: body.trigger_id, view: promptModal(s) });
      if (action.action_id === 'screen') {
        const { lines } = await orca.screen(s);
        for (const part of chunkText(escape(lines.join('\n')).replace(/```/g, '｀｀｀'), 2600)) await engine.post(s, '终端画面', [section('```' + part + '```')]);
        return;
      }
      await engine.control(s, action.action_id, `action:${s.id}:${action.action_ts}`);
    } catch (e) { await notifyError(s, e); }
  }));
  app.view('send_session', safe(async ({ ack, body, view }) => {
    await ack(); if (!allowed(body)) return;
    const s = engine.session(view.private_metadata);
    try { await engine.send(s, valueOf(view, 'prompt'), `prompt:${view.id}`); } catch (e) { await notifyError(s, e); }
  }));
  app.view('key_session', safe(async ({ ack, body, view }) => {
    await ack(); if (!allowed(body)) return;
    const s = engine.session(view.private_metadata);
    try { await engine.control(s, valueOf(view, 'key'), `key:${view.id}`); } catch (e) { await notifyError(s, e); }
  }));
  app.event('message', safe(async ({ body, event, client }) => {
    if (!allowed(body, event.user) || event.bot_id || (event.subtype && event.subtype !== 'file_share')) return;
    const s = engine.byThread(event.channel, event.thread_ts);
    if (!s) {
      if (event.channel_type === 'im' && !event.thread_ts) await client.chat.postMessage({ channel: event.channel, text: 'MAC-hand 控制台', blocks: controlPanel(config.sessionLayout) });
      return;
    }
    const id = `message:${body.event_id || event.client_msg_id || `${event.channel}:${event.ts}`}`;
    if (state.data.receipts[id]) return;
    try {
      const files = [];
      for (const f of (event.files || []).slice(0, 5)) files.push(await downloadFile(client, config.botToken, config.home, f.id));
      const text = String(event.text || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const prompt = [text, ...files.map(f => `附件（本地文件）：${f}`)].filter(Boolean).join('\n\n');
      if (!prompt) return;
      // All terminal input here is the configured human's explicit Slack input.
      await engine.send(s, prompt, id);
    } catch (e) { await notifyError(s, e); }
  }));
  app.error(async error => log('slack-error', errorText(error)));
  return { allowed };
}
