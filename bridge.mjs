#!/usr/bin/env node
// 飞书里的 Orca：私聊机器人选项目和模型 → 新建工作树和一个会话群；群里说话发给 Orca 终端里的模型，
// 模型的回复、电脑上在终端里的对话都同步回群。两边是同一个活着的会话。
import fs from 'node:fs';
import path from 'node:path';
import { feishu, sleep } from './lib/feishu.mjs';
import { loadConfig } from './lib/config.mjs';
import { agentViewPlugin, modelCatalog, orca as orcaCli, shq } from './lib/orca.mjs';
import { events, newestSince, readNew, sessionInfo, sessionsIn, transcriptPath } from './lib/claude.mjs';
import { fit, turnCard, units } from './lib/render.mjs';
import { consoleCard, createdCard, creatingCard, failedCard, heldCard, historyCard, listCard, noticeCard, screenCard, sessionCard, waitCard } from './lib/cards.mjs';
import { isPassive, toPrompt } from './lib/message.mjs';
import { parsePrompt, sameText, worktreeName } from './lib/util.mjs';
import { consume } from './lib/inbound.mjs';
import { store } from './lib/store.mjs';
import { run } from './lib/run.mjs';

const CFG = loadConfig();
const DIR = CFG.home;
fs.mkdirSync(DIR, { recursive: true });
const LARK_ENV = { ...process.env, ...(CFG.larkCliConfigDir ? { LARKSUITE_CLI_CONFIG_DIR: CFG.larkCliConfigDir } : {}) };
const f = feishu({ appId: CFG.appId, secret: CFG.secret });
const orca = orcaCli(CFG.orca);
const st = store(path.join(DIR, 'state.json'), { sessions: {}, seen: {}, cards: {}, last: {}, tags: {} });
const S = st.data.sessions; // 群 chat_id → 会话
const rt = new Map(); // 群 chat_id → 运行时（不落盘）

const LOG = path.join(DIR, 'bridge.log');
function log(...a) {
  const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  fs.appendFileSync(LOG, `${line}\n`);
}
const R = (chatId) => { if (!rt.has(chatId)) rt.set(chatId, { chain: Promise.resolve(), timer: null, buf: [], bufTimer: null, sending: false }); return rt.get(chatId); };
// 每个群里的事一件一件做（卡片 sequence 要有序，发消息不能交叉）
const serial = (chatId, fn) => { const r = R(chatId); const p = r.chain.then(fn).catch((e) => log('ERR', chatId, e.stack || e.message)); r.chain = p; return p; };

// ───────────── 卡片 ─────────────
async function newCard(chatId, card, replyTo) {
  const cardId = await f.createCard(card);
  const messageId = replyTo ? await f.replyCardId(replyTo, cardId).catch(() => f.sendCardId(chatId, cardId)) : await f.sendCardId(chatId, cardId);
  const ref = { cardId, messageId, seq: 1 };
  st.data.cards[messageId] = { cardId, seq: 1, at: Date.now() };
  st.save();
  return ref;
}
// 同一张卡的更新排队做（sequence 要递增）；撞了版本号（别处先更新过）就跳一段再试一次
const cardChains = new Map();
function setCard(ref, card) {
  const id = ref.cardId || st.data.cards[ref.messageId]?.cardId;
  const p = (cardChains.get(id) || Promise.resolve()).then(async () => {
    const c = st.data.cards[ref.messageId] || ref;
    for (let i = 0; ; i++) {
      c.seq = Math.max(c.seq || 1, ref.seq || 1) + (i ? 20 : 1); ref.seq = c.seq;
      try { await f.updateCard(id, card, c.seq); break; } catch (e) { if (e.code !== 300317 || i) throw e; }
    }
    st.save();
  });
  cardChains.set(id, p.catch(() => {}));
  return p;
}
const cardOf = (messageId) => (st.data.cards[messageId] ? { messageId, ...st.data.cards[messageId] } : null);
const notice = (chatId, text, replyTo) => newCard(chatId, noticeCard(text), replyTo).catch((e) => log('ERR notice', e.message));

// ───────────── 私聊控制台 ─────────────
async function catalog() {
  const repos = await orca.repos();
  const wts = await orca.worktrees().catch(() => []);
  const act = {};
  for (const w of wts) act[w.repoId] = Math.max(act[w.repoId] || 0, w.lastActivityAt || 0);
  repos.sort((a, b) => (act[b.id] || 0) - (act[a.id] || 0));
  const cat = modelCatalog();
  const models = (cat.claude || []).map((m) => ({ ...m, agent: 'claude', agentLabel: 'Claude' }));
  return { repos, models };
}
async function sendConsole(chatId) {
  const { repos, models } = await catalog();
  await newCard(chatId, consoleCard({ repos, models, last: st.data.last, docUrl: CFG.docUrl }));
}

const creating = new Set(); // 控制台卡上「新建」只认第一下
async function create(chatId, cardMsg, form) {
  if (creating.has(cardMsg)) return;
  creating.add(cardMsg);
  try { await createOnce(chatId, cardMsg, form); } finally { creating.delete(cardMsg); }
}
async function createOnce(chatId, cardMsg, form) {
  const early = cardOf(cardMsg);
  if (early) await setCard(early, creatingCard({ repo: '…', model: '…', name: worktreeName(form.name), first: String(form.first || '').trim() })).catch(() => {}); // 先给反馈，取项目列表可能要一会儿
  const { repos, models } = await catalog();
  const repo = repos.find((r) => r.id === form.repo);
  const model = models.find((m) => `${m.agent}:${m.id}` === form.model);
  const ref = cardOf(cardMsg);
  if (!repo || !model) { if (ref) await setCard(ref, consoleCard({ repos, models, last: { ...st.data.last, ...form }, docUrl: CFG.docUrl })); return notice(chatId, '先选项目和模型'); }
  const effort = form.effort && form.effort !== 'default' ? form.effort : '';
  const name = worktreeName(form.name);
  const first = String(form.first || '').trim();
  const label = `Claude · ${model.label}`;
  st.data.last = { repo: repo.id, model: form.model, effort: form.effort };
  if (ref) await setCard(ref, creatingCard({ repo: repo.name, model: label, name, first }));
  log('create', repo.name, name, model.id, effort);
  try {
    const { worktree, terminal } = await orca.createWorktree({ repoId: repo.id, name, agent: 'claude', model: model.id, effort, prompt: first || undefined });
    const wt = { id: worktree.id, path: worktree.path, name: worktree.displayName || name, branch: worktree.branch };
    const group = await f.createChat({ name: `${repo.name}/${wt.name}`.slice(0, 60), description: wt.path, users: [CFG.owner] }); // 机器人当群主：删除工作树时它才能解散群
    const s = S[group] = {
      chatId: group, agent: 'claude', repo: { id: repo.id, name: repo.name }, worktree: wt, model: model.id, modelLabel: label, effort,
      sessionId: null, offset: 0, terminal, createdAt: Date.now(), title: '', closed: false, sent: [], held: null, turn: null, wait: null,
    };
    if (first) s.sent.push({ text: first, msgIds: [], at: Date.now(), first: true });
    st.save();
    tagChat(s);
    await postHeader(s);
    if (ref) await setCard(ref, createdCard({ repo: repo.name, model: label, name: wt.name, chatId: group, path: wt.path }));
    await sendConsole(chatId);
  } catch (e) {
    log('ERR create', e.message);
    if (ref) await setCard(ref, failedCard(`新建 ${repo.name}/${name} 失败`, e.message));
  }
}

async function postHeader(s) {
  const ref = await newCard(s.chatId, sessionCard(s, { live: !!s.terminal }));
  s.header = ref;
  st.save();
  await f.pin(ref.messageId).catch((e) => log('ERR pin', e.message));
}
const refreshHeader = (s) => s.header && setCard(s.header, sessionCard(s, { live: !!s.terminal && !s.closed })).catch((e) => log('ERR header', e.message));

// Orca 里的会话列表
async function sessionList() {
  const [repos, wts, terms] = await Promise.all([orca.repos(), orca.worktrees(), orca.terminals().catch(() => [])]);
  const repoName = Object.fromEntries(repos.map((r) => [r.id, r.name]));
  const byFile = Object.fromEntries(Object.values(S).filter((s) => s.sessionId && !s.removed).map((s) => [`${s.worktree.path}|${s.sessionId}`, s.chatId]));
  const items = [];
  for (const w of wts) {
    const live = terms.filter((t) => t.worktreePath === w.path && t.agentIdentity === 'claude' && t.connected).length;
    const ss = sessionsIn(w.path, 5);
    ss.forEach((x, i) => items.push({ ...x, cwd: w.path, repo: repoName[w.repoId] || '?', worktree: w.displayName, live: live > 0 && i === 0 && x.entrypoint === 'cli', chatId: byFile[`${w.path}|${x.id}`] }));
  }
  return items.sort((a, b) => b.mtime - a.mtime);
}
async function showList(chatId, page, cardMsg) {
  const all = await sessionList();
  const per = 8, pages = Math.max(1, Math.ceil(Math.min(all.length, 80) / per));
  page = Math.min(Math.max(0, page), pages - 1);
  const card = listCard(all.slice(page * per, page * per + per), page, pages);
  const ref = cardMsg && cardOf(cardMsg);
  if (ref && ref.kind === 'list') return setCard(ref, card);
  const n = await newCard(chatId, card);
  st.data.cards[n.messageId].kind = 'list';
}

// 把 Orca 里已有的会话接到一个新群
async function attach(chatId, id, cwd) {
  const existing = Object.values(S).find((s) => s.sessionId === id && s.worktree.path === cwd && !s.removed);
  if (existing) return notice(chatId, `这个会话已经在群里了：${existing.title || existing.worktree.name}`);
  const [repos, wts, terms] = await Promise.all([orca.repos(), orca.worktrees(), orca.terminals().catch(() => [])]);
  const w = wts.find((x) => x.path === cwd);
  if (!w) return notice(chatId, `Orca 里找不到工作树 ${cwd}`);
  const repo = repos.find((r) => r.id === w.repoId) || { id: w.repoId, name: path.basename(cwd) };
  const file = transcriptPath(cwd, id);
  const info = sessionInfo(file);
  if (!info) return notice(chatId, '会话记录不见了');
  // 终端里正跑着的就是它（这个目录最新的终端会话、只有一个 claude 终端）才直接接上，否则说话时新开终端续上
  const live = terms.filter((t) => t.worktreePath === cwd && t.agentIdentity === 'claude' && t.connected);
  const newestCli = sessionsIn(cwd).find((x) => x.entrypoint === 'cli');
  const terminal = info.entrypoint === 'cli' && live.length === 1 && newestCli?.id === id ? live[0].handle : null;
  const title = info.title || info.lastPrompt?.slice(0, 30) || w.displayName;
  const group = await f.createChat({ name: `${repo.name} · ${title}`.slice(0, 60), description: cwd, users: [CFG.owner] }); // 机器人当群主：删除工作树时它才能解散群
  const s = S[group] = {
    chatId: group, agent: 'claude', repo: { id: repo.id, name: repo.name }, worktree: { id: w.id, path: cwd, name: w.displayName, branch: w.branch },
    model: null, modelLabel: info.entrypoint === 'sdk-ts' ? 'Claude（Orca 聊天开的会话，在终端里续上）' : 'Claude（终端会话）', effort: '',
    sessionId: id, offset: info.size, terminal, createdAt: Date.now(), title, closed: false, sent: [], held: null, turn: null, wait: null,
  };
  st.save();
  tagChat(s);
  await postHeader(s);
  await newCard(group, historyCard(history(file, 3)));
  await notice(chatId, `已接上「${title}」`);
  log('attach', cwd, id, terminal ? 'live' : 'resume-later');
}

// 最近几轮：你说的话 + 模型的文字回复
function history(file, n) {
  const turns = [];
  const { entries } = readNew(file, Math.max(0, fs.statSync(file).size - 3_000_000));
  for (const d of entries) {
    for (const e of events(d)) {
      if (e.kind === 'prompt') turns.push({ prompt: e.text, texts: [], source: d.entrypoint });
      else if (e.kind === 'text' && turns.length) turns[turns.length - 1].texts.push(e.text);
    }
  }
  return turns.slice(-n).map((t) => ({ ...t, reply: t.texts.join('\n\n') }));
}

// ───────────── 终端 ─────────────
const alive = (t) => t && t.connected && t.writable && t.agentIdentity === 'claude';
async function ensureTerminal(s) {
  if (s.terminal) {
    const t = await orca.terminal(s.terminal).catch(() => null);
    if (alive(t)) return s.terminal;
    if (t?.connected) await orca.closeTerminal(s.terminal); // agent 退出了，剩个 shell：别把话发进 shell 里
  }
  const plugin = agentViewPlugin();
  const cmd = [shq(CFG.claude), '--dangerously-skip-permissions', plugin ? `--plugin-dir ${shq(plugin)}` : '', s.sessionId ? `--resume ${s.sessionId}` : '', s.model ? `--model ${shq(s.model)}` : '', s.model && s.effort ? `--effort ${s.effort}` : ''].filter(Boolean).join(' ');
  const handle = await orca.createTerminal({ worktreePath: s.worktree.path, title: (s.title || s.worktree.name).slice(0, 30), command: cmd });
  for (let i = 0; i < 40; i++) { await sleep(1000); if (alive(await orca.terminal(handle).catch(() => null))) break; }
  await sleep(1500);
  s.terminal = handle;
  st.save();
  log('terminal', s.chatId, handle, s.sessionId || 'new');
  refreshHeader(s);
  return handle;
}

// ───────────── 发给模型 ─────────────
async function submit(s, text, msgIds) {
  if (s.removed) return notice(s.chatId, '这个会话的工作树已经删了。到私聊里新建一个会话。');
  if (s.closed) { s.closed = false; await f.updateChat(s.chatId, { name: groupName(s) }).catch(() => {}); refreshHeader(s); }
  await send(s, text, msgIds); // 模型正忙也直接发：Claude Code 会排队，在下一个工具调用的间隙读到（和在终端里插话一样）
}

async function send(s, text, msgIds) {
  const r = R(s.chatId);
  r.sending = true;
  try {
    const handle = await ensureTerminal(s);
    s.sent.push({ text, msgIds, at: Date.now() });
    st.save();
    const res = await orca.prompt(handle, text);
    const stages = res.send?.prompt?.stages || [];
    log('sent', s.chatId, stages.join(','), text.slice(0, 60).replace(/\n/g, ' '));
    for (const m of msgIds) f.react(m, 'Get').catch(() => {});
  } catch (e) {
    s.sent = s.sent.filter((x) => x.text !== text);
    log('ERR send', s.chatId, e.message);
    await notice(s.chatId, `❌ 没发进终端：${e.message.slice(0, 300)}`, msgIds[msgIds.length - 1]);
  } finally { r.sending = false; st.save(); }
}

// ───────────── 会话记录 → 群 ─────────────
function startTurn(s, { source, prompt, replyTo, msgIds }) {
  if (s.turn?.status === 'running') endTurn(s, 'done');
  s.turn = { source, prompt, replyTo, msgIds: msgIds || [], startedAt: Date.now(), status: 'running', blocks: [], cards: [], tools: {} };
  st.save();
}
function ensureTurn(s) { if (!s.turn || s.turn.status !== 'running') startTurn(s, { source: 'computer', prompt: '' }); return s.turn; }

function endTurn(s, status, note) {
  const t = s.turn;
  if (!t || t.status !== 'running') return;
  t.status = status; t.endedAt = Date.now(); if (note) t.note = note;
  for (const b of t.blocks) if (b.type === 'tools') for (const x of b.tools) if (x.status === 'running') x.status = status === 'done' ? 'ok' : 'error';
  if (status === 'done') for (const m of t.msgIds) f.react(m, 'DONE').catch(() => {});
  if (s.wait) closeWait(s, '这一轮已经结束');
  scheduleRender(s, true);
  st.save();
}

function onEvent(s, e, entry) {
  if (e.kind === 'prompt' || e.kind === 'command') {
    const i = s.sent.findIndex((x) => sameText(e.text, x.text));
    const sent = i >= 0 ? s.sent.splice(i, 1)[0] : null;
    if (e.kind === 'command') {
      if (!sent) notice(s.chatId, `💻 电脑上执行了 \`${e.text.slice(0, 200)}\``);
      if (/^\/?clear\b/.test(e.text)) s.expectNewFile = Date.now();
      return;
    }
    startTurn(s, sent ? { source: sent.first ? 'first' : 'feishu', prompt: e.text, replyTo: sent.msgIds[sent.msgIds.length - 1], msgIds: sent.msgIds } : { source: 'computer', prompt: e.text });
    scheduleRender(s);
    return;
  }
  if (e.kind === 'steer') {
    const i = s.sent.findIndex((x) => sameText(e.text, x.text));
    const sent = i >= 0 ? s.sent.splice(i, 1)[0] : null;
    const t = ensureTurn(s);
    t.blocks.push({ type: 'steer', text: e.text, source: sent ? 'feishu' : 'computer' });
    if (sent) t.msgIds.push(...sent.msgIds);
    scheduleRender(s);
    return;
  }
  if (e.kind === 'notification') { startTurn(s, { source: 'system', prompt: e.text }); scheduleRender(s); return; }
  if (e.kind === 'end') { if (s.turn?.status === 'running') endTurn(s, 'done'); return; }
  if (e.kind === 'interrupted') { if (s.turn?.status === 'running') endTurn(s, 'interrupted'); return; }
  const t = ensureTurn(s);
  const lastBlock = t.blocks[t.blocks.length - 1];
  if (e.kind === 'text') t.blocks.push({ type: 'text', text: e.text, error: e.error });
  else if (e.kind === 'tool') {
    const tool = { id: e.id, name: e.name, input: e.input, status: 'running' };
    if (lastBlock?.type === 'tools') lastBlock.tools.push(tool); else t.blocks.push({ type: 'tools', tools: [tool] });
  } else if (e.kind === 'result') {
    for (const b of t.blocks) if (b.type === 'tools') for (const x of b.tools) if (x.id === e.id) { x.status = e.error ? 'error' : 'ok'; x.result = e.text.slice(0, 2000); }
  }
  t.lastEventAt = Date.now();
  scheduleRender(s);
}

function scheduleRender(s, now = false) {
  const r = R(s.chatId);
  if (now) { clearTimeout(r.timer); r.timer = null; serial(s.chatId, () => render(s)); return; }
  if (r.timer) return;
  r.timer = setTimeout(() => { r.timer = null; serial(s.chatId, () => render(s)); }, 1200);
}

async function render(s) {
  const t = s.turn;
  if (!t) return;
  const live = t.status === 'running';
  const max = t.maxChars || 12000;
  const us = units(t, live, max);
  if (!t.cards.length) {
    if (!us.length && live && Date.now() - t.startedAt < 4000) return scheduleRender(s); // 刚开始还没内容，先等一下
    const ref = await newCard(s.chatId, turnCard(t, 0, us.slice(0, fit(us, 0, max)).map((u) => u.el), { last: true, chatId: s.chatId }), t.replyTo);
    t.cards.push({ ...ref, from: 0 });
  }
  const finished = !live && !t.rendered;
  try {
    for (let k = t.cards.length - 1; ; k++) {
      const c = t.cards[k];
      const n = fit(us, c.from, max);
      const to = c.from + n;
      if (to < us.length) { // 这张放满了：定稿，后面的放进下一张
        c.to = to;
        await setCard(c, turnCard(t, k, us.slice(c.from, to).map((u) => u.el), { last: false, chatId: s.chatId }));
        const ref = await newCard(s.chatId, turnCard(t, k + 1, [], { last: true, chatId: s.chatId }));
        t.cards.push({ ...ref, from: to });
        continue;
      }
      await setCard(c, turnCard(t, k, us.slice(c.from).map((u) => u.el), { last: true, chatId: s.chatId }));
      break;
    }
    if (finished && t.cards.length > 1) { // 第一张的标题跟着状态变
      const c = t.cards[0];
      await setCard(c, turnCard(t, 0, us.slice(0, c.to).map((u) => u.el), { last: false, chatId: s.chatId }));
    }
    if (finished) t.rendered = true;
  } catch (e) {
    if (e.code === 200860 && max > 1500) { t.maxChars = Math.floor(max / 2); log('card-too-big', s.chatId, t.maxChars); return scheduleRender(s, true); }
    throw e;
  } finally { st.save(); }
}

function pump(s) {
  if (s.removed) return;
  if (!s.sessionId) {
    const x = newestSince(s.worktree.path, s.createdAt - 10_000);
    if (!x) return;
    s.sessionId = x.id; s.offset = 0; st.save();
    log('session', s.chatId, x.id);
    refreshHeader(s);
  }
  const file = transcriptPath(s.worktree.path, s.sessionId);
  const { offset, entries } = readNew(file, s.offset);
  if (offset === s.offset) return;
  s.offset = offset;
  for (const d of entries) for (const e of events(d)) onEvent(s, e, d);
  st.save();
}

// /clear 之后终端换了新会话文件：只跟比我们这个文件「新建」得晚、又不属于别的群的文件；
// 是我们刚发的话所在的文件，或者这个工作树只有我们一个 claude 终端，才算是我们的
async function followNewFile(s, terms) {
  if (!s.sessionId || s.removed || s.closed) return;
  const mine = sessionInfo(transcriptPath(s.worktree.path, s.sessionId));
  if (!mine) return;
  const taken = new Set(Object.values(S).filter((o) => o !== s && !o.removed && o.worktree.path === s.worktree.path).map((o) => o.sessionId));
  const x = sessionsIn(s.worktree.path).find((c) => c.entrypoint === 'cli' && c.id !== s.sessionId && !taken.has(c.id) && c.created > mine.created && c.created > (s.switchedAt || 0));
  if (!x) return;
  const live = terms.filter((t) => t.worktreePath === s.worktree.path && t.agentIdentity === 'claude' && t.connected);
  const pending = s.sent.some((p) => history(x.file, 2).some((h) => sameText(h.prompt, p.text)));
  if (!pending && !(live.length === 1 && live[0].handle === s.terminal)) return;
  log('switch-session', s.chatId, s.sessionId, '→', x.id);
  if (s.turn?.status === 'running') endTurn(s, 'done');
  s.sessionId = x.id; s.switchedAt = Date.now();
  s.offset = x.size > 200_000 ? x.size : 0; // 已经很长的文件不回放历史
  st.save();
  notice(s.chatId, '💻 终端里开了新会话（比如 /clear），后面跟着新会话走');
  refreshHeader(s);
}

// ───────────── 终端在等你操作 ─────────────
async function checkWait(s) {
  const t = s.turn;
  if (!s.terminal || !t || t.status !== 'running' || Date.now() - (t.lastEventAt || t.startedAt) < 1500) return;
  const term = await orca.terminal(s.terminal).catch(() => null);
  if (!term) return;
  if (!term.connected) { endTurn(s, 'error', '终端被关了'); s.terminal = null; refreshHeader(s); return; }
  if (term.agentIdentity !== 'claude') { endTurn(s, 'error', 'agent 退出了'); return; }
  if (!term.agentWait) { if (s.wait) closeWait(s, s.wait.label || '已在终端里处理'); return; }
  const p = parsePrompt(await orca.screen(s.terminal));
  const hash = `${p.question}|${p.options.map((o) => o.label).join('|')}`;
  if (s.wait?.hash === hash) return;
  if (s.wait) { await setCard(s.wait.ref, waitCard(s.chatId, p)); s.wait = { ...s.wait, hash, prompt: p }; st.save(); return; }
  const ref = await newCard(s.chatId, waitCard(s.chatId, p), t.cards[t.cards.length - 1]?.messageId || t.replyTo);
  s.wait = { ref, hash, prompt: p };
  st.save();
}
function closeWait(s, label) {
  const w = s.wait;
  if (!w) return;
  s.wait = null; st.save();
  serial(s.chatId, () => setCard(w.ref, waitCard(s.chatId, w.prompt, label)));
}
async function answer(s, text) {
  const opts = s.wait?.prompt.options || [];
  const other = opts.find((o) => /type something|其他|other/i.test(o.label));
  if (other) { await orca.keys(s.terminal, other.n); await sleep(400); }
  await orca.keys(s.terminal, text.replace(/\s*\n\s*/g, ' ')); // 选择框里换行就是提交，压成一行
  await sleep(200);
  await orca.keys(s.terminal, '\r');
  if (s.wait) s.wait.label = `✏️ ${text.slice(0, 100)}`;
}

// ───────────── 收消息 ─────────────
async function onMessage(ev) {
  const id = ev.message_id;
  if (!id || st.data.seen[id]) return;
  st.data.seen[id] = Date.now(); st.save();
  if (ev.sender_type !== 'user' || ev.sender_id !== CFG.owner) return;
  if (ev.chat_type === 'p2p') {
    const text = String(ev.content || '').trim();
    if (/^(列表|会话|list|ls)$/i.test(text)) return showList(ev.chat_id, 0);
    return sendConsole(ev.chat_id);
  }
  const s = S[ev.chat_id];
  if (!s) return;
  const r = R(s.chatId);
  r.buf.push(ev);
  clearTimeout(r.bufTimer);
  r.bufTimer = setTimeout(() => { const batch = r.buf.splice(0); serial(s.chatId, () => onBatch(s, batch)); }, 1500); // 转发 + 补一句常常是连着来的
}

async function onBatch(s, batch) {
  const media = path.join(DIR, 'media', s.chatId);
  const items = [];
  for (const ev of batch) {
    try { items.push({ ...(await toPrompt(f, ev.message_id, media)), id: ev.message_id }); } catch (e) { log('ERR toPrompt', e.message); items.push({ text: String(ev.content || ''), type: ev.message_type, id: ev.message_id }); }
  }
  const one = items.length === 1 && items[0].type === 'text' ? items[0].text.trim() : null;
  if (one && /^\/(stop|esc|中断|停)$/i.test(one)) return esc(s);
  if (one && /^\/(screen|屏幕)$/i.test(one)) return screen(s);
  if (one && /^\/key\s+/i.test(one)) return keys(s, one.replace(/^\/key\s+/i, ''));
  const typed = items.filter((x) => !isPassive(x.type));
  if (s.wait && s.terminal && typed.length) { // 等你回答时说的话就是回答
    await answer(s, items.map((x) => x.text).join('\n\n'));
    for (const x of items) f.react(x.id, 'Get').catch(() => {});
    return;
  }
  if (!typed.length) { // 只有转发 / 附件：等一句再发
    s.held ||= { items: [] };
    s.held.items.push(...items);
    const card = heldCard(s.chatId, s.held.items.length);
    if (s.held.ref) await setCard(s.held.ref, card); else s.held.ref = await newCard(s.chatId, card, items[items.length - 1].id);
    st.save();
    return;
  }
  const all = [...(s.held?.items || []), ...items];
  await releaseHeld(s, '已和你的话一起发给模型');
  await submit(s, all.map((x) => x.text).join('\n\n'), all.map((x) => x.id));
}
async function releaseHeld(s, label) {
  const h = s.held;
  if (!h) return;
  s.held = null; st.save();
  if (h.ref) await setCard(h.ref, noticeCard(`📥 ${h.items.length} 条转发/附件：${label}`)).catch(() => {});
}

// ───────────── 按钮 ─────────────
async function onAction(ev) {
  if (!ev.event_id || st.data.seen[ev.event_id]) return;
  st.data.seen[ev.event_id] = Date.now(); st.save();
  if (ev.operator_id !== CFG.owner) return;
  let v = {}, form = {};
  try { v = JSON.parse(ev.action_value || '{}'); } catch {}
  try { form = JSON.parse(ev.form_value || '{}'); } catch {}
  if (!v.fo) return;
  log('action', v.fo, ev.chat_id);
  const chatId = ev.chat_id;
  if (v.fo === 'create') return create(chatId, ev.message_id, form);
  if (v.fo === 'console') { const ref = cardOf(ev.message_id); const { repos, models } = await catalog(); return ref ? setCard(ref, consoleCard({ repos, models, last: st.data.last, docUrl: CFG.docUrl })) : sendConsole(chatId); }
  if (v.fo === 'list') return showList(chatId, v.page || 0, ev.message_id);
  if (v.fo === 'attach') return attach(chatId, v.id, v.cwd);
  const s = S[v.chat || chatId];
  if (!s) return;
  return serial(s.chatId, async () => {
    switch (v.fo) {
      case 'esc': return esc(s);
      case 'screen': return screen(s);
      case 'focus': await orca.focus(await ensureTerminal(s)); return notice(s.chatId, '已在 Orca 里切到这个终端');
      case 'restart': if (s.terminal) await orca.closeTerminal(s.terminal); s.terminal = null; if (s.turn?.status === 'running') endTurn(s, 'interrupted'); await ensureTerminal(s); return notice(s.chatId, '🔁 终端重开了，续上原来的会话');
      case 'close': return closeSession(s, false);
      case 'remove': return closeSession(s, true);
      case 'key': if (!s.terminal) return; await orca.keys(s.terminal, v.k); if (s.wait) s.wait.label = `已选：${v.k}. ${v.label}`; return;
      case 'raw': if (!s.terminal) return; return orca.keys(s.terminal, v.k);
      case 'answer': if (s.terminal && String(form.text || '').trim()) return answer(s, String(form.text).trim()); return;
      case 'flush': { const h = s.held; if (!h) return; await releaseHeld(s, '已发给模型'); return submit(s, h.items.map((x) => x.text).join('\n\n'), h.items.map((x) => x.id)); }
      case 'drop': return releaseHeld(s, '不要了');
    }
  });
}

async function esc(s) {
  if (!s.terminal) return notice(s.chatId, '终端没开着');
  await orca.keys(s.terminal, '\x1b');
}
async function screen(s) {
  if (!s.terminal) return notice(s.chatId, '终端没开着，说话时会自动续上');
  const lines = await orca.screen(s.terminal);
  await newCard(s.chatId, screenCard(lines, `${s.worktree.name} · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`));
}
async function keys(s, spec) {
  if (!s.terminal) return notice(s.chatId, '终端没开着');
  const map = { enter: '\r', esc: '\x1b', up: '\x1b[A', down: '\x1b[B', tab: '\t', 'shift-tab': '\x1b[Z', 'ctrl-c': '\x03' };
  for (const k of spec.split(/\s+/)) { await orca.keys(s.terminal, map[k.toLowerCase()] ?? k); await sleep(200); }
}
const groupName = (s) => `${s.closed ? (s.removed ? '【已删除】' : '【已结束】') : ''}${s.repo.name}${s.title ? ` · ${s.title}` : `/${s.worktree.name}`}`.slice(0, 60);

async function closeSession(s, remove) {
  if (!remove) {
    if (s.turn?.status === 'running') endTurn(s, 'interrupted');
    if (s.terminal) await orca.closeTerminal(s.terminal);
    s.terminal = null; s.closed = true;
    st.save();
    await f.updateChat(s.chatId, { name: groupName(s) }).catch((e) => log('ERR rename', e.message));
    await refreshHeader(s);
    return notice(s.chatId, '会话已结束，终端关了，工作树还在。再说话会重新打开、续上这个会话。');
  }
  if (s.terminal) await orca.closeTerminal(s.terminal);
  try { await orca.removeWorktree(s.worktree.id); } catch (e) {
    if (fs.existsSync(s.worktree.path)) return notice(s.chatId, `❌ 删除工作树失败：${e.message.slice(0, 300)}`);
    // 已经在 Orca 里删掉了：当成删除成功
  }
  for (const o of Object.values(S)) if (!o.removed && o.worktree.path === s.worktree.path) await retire(o, o === s ? '工作树已删除' : '这个工作树在另一个群里被删除了');
}

// 工作树没了（飞书里点删除，或者在 Orca 里删了）：关终端、结束会话、解散群
async function retire(s, reason) {
  if (s.turn?.status === 'running') endTurn(s, 'interrupted');
  if (s.terminal) await orca.closeTerminal(s.terminal);
  Object.assign(s, { terminal: null, closed: true, removed: true });
  st.save();
  log('retire', s.chatId, reason);
  const err = await dissolve(s.chatId);
  if (!err) { s.dissolved = true; st.save(); return; }
  // 解散不了就留着群，改名标记
  await f.updateChat(s.chatId, { name: groupName(s) }).catch(() => {});
  await refreshHeader(s);
  await notice(s.chatId, `🗑 ${reason}，会话结束。群没能自动解散：${err}`);
}

// 先用机器人解散（新建的群机器人是群主）；以前建的群群主是你，再用你的身份试一次
async function dissolve(chatId) {
  try { await f.dissolveChat(chatId); return null; } catch (e) {
    if (e.code === 232009) return null; // 群已经不在了
    const r = await run(CFG.larkCli, ['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`, '--as', 'user'], { timeout: 30_000 });
    if (r.code === 0 && !/"code":\s*[1-9]/.test(r.out)) return null;
    log('ERR dissolve', chatId, e.message.slice(0, 200), (r.out + r.err).replace(/\s+/g, ' ').slice(0, 200));
    return /99991672|im:chat:delete/.test(e.message + r.out + r.err) ? '机器人应用还没开「解散群」权限（im:chat:delete），开通后再删除就会自动解散' : e.message.slice(0, 200);
  }
}

// 会话群按项目打飞书标签（消息列表左侧的分组），群多了好找。标签只能用你的身份操作（lark-cli --as user）
async function larkUser(args) {
  const r = await run(CFG.larkCli, [...args, '--as', 'user'], { env: LARK_ENV, timeout: 30_000 });
  let j; try { j = JSON.parse(r.out); } catch {}
  if (!j?.ok) throw new Error((j?.error?.message || r.err || r.out).replace(/\s+/g, ' ').slice(0, 200));
  return j.data || {};
}
async function tagOf(name, fresh) {
  if (st.data.tags[name] && !fresh) return st.data.tags[name];
  const { groups = [] } = await larkUser(['im', '+feed-group-list', '--page-all']);
  st.data.tags[name] = groups.find((g) => g.name === name && g.type === 'normal')?.group_id
    || (await larkUser(['im', 'feed.groups', 'create', '--data', JSON.stringify({ feed_group_creator: { type: 'normal', name } })])).group_id;
  st.save();
  return st.data.tags[name];
}
let tagChain = Promise.resolve(); // 一个一个打：同一个项目同时打两个群会建出两个同名标签
function tagChat(s) {
  const add = async (fresh) => {
    const d = await larkUser(['im', 'feed.groups', 'batch_add_item', '--params', JSON.stringify({ feed_group_id: await tagOf(s.repo.name, fresh) }), '--data', JSON.stringify({ items: [{ feed_id: s.chatId, feed_type: 'chat' }] })]);
    if (d.failed_items?.length) throw new Error(d.failed_items[0].error_message);
  };
  tagChain = tagChain.then(async () => {
    try { await add(false); } catch { await add(true); } // 标签被你删了：重新找、重新建
    s.tagged = true; st.save();
    log('tag', s.chatId, s.repo.name);
  }).catch((e) => log('ERR tag', s.chatId, e.message));
  return tagChain;
}

// ───────────── 定时 ─────────────
let ticking = false;
setInterval(() => { // 读会话记录
  if (ticking) return; ticking = true;
  try { for (const s of Object.values(S)) { try { pump(s); } catch (e) { log('ERR pump', s.chatId, e.message); } } } finally { ticking = false; }
}, 1000);

setInterval(() => { // 等你回答的提示、正在跑的卡片刷新用时
  for (const s of Object.values(S)) {
    if (s.turn?.status !== 'running') continue;
    serial(s.chatId, () => checkWait(s));
    if (Date.now() - (R(s.chatId).lastTick || 0) > 15_000) { R(s.chatId).lastTick = Date.now(); scheduleRender(s); }
  }
}, 2500);

setInterval(async () => { // 标题、新会话文件、卡住的轮次、清理
  let terms = [];
  try { terms = await orca.terminals(); } catch (e) { log('ERR terminals', e.message); }
  for (const s of Object.values(S)) {
    if (s.removed) continue;
    if (!fs.existsSync(s.worktree.path)) { await retire(s, '这个工作树在 Orca 里被删除了').catch((e) => log('ERR retire', e.message)); continue; }
    if (!s.sessionId) continue;
    await followNewFile(s, terms).catch((e) => log('ERR follow', e.message));
    const info = sessionInfo(transcriptPath(s.worktree.path, s.sessionId));
    if (info?.title && info.title !== s.title) {
      s.title = info.title; st.save();
      f.updateChat(s.chatId, { name: groupName(s) }).catch((e) => log('ERR rename', e.message));
      refreshHeader(s);
    }
    if (s.terminal && !terms.some((t) => t.handle === s.terminal && t.connected)) { // 终端在 Orca 里被关了
      s.terminal = null; st.save();
      if (s.turn?.status === 'running') endTurn(s, 'error', '终端被关了；再说话会新开终端续上');
      refreshHeader(s);
    }
    s.sent = s.sent.filter((x) => Date.now() - x.at < 10 * 60_000);
  }
  const week = Date.now() - 7 * 86400_000;
  for (const [k, v] of Object.entries(st.data.seen)) if (v < week) delete st.data.seen[k];
  for (const [k, v] of Object.entries(st.data.cards)) if (v.at < week) delete st.data.cards[k];
  st.save();
}, 10_000);

// ───────────── 启动 ─────────────
const inbound = [
  consume(CFG.larkCli, 'im.message.receive_v1', (ev) => onMessage(ev), log, LARK_ENV),
  consume(CFG.larkCli, 'card.action.trigger', (ev) => onAction(ev), log, LARK_ENV),
];
for (const s of Object.values(S)) if (s.turn?.status === 'running') scheduleRender(s);
// 工作树删了但群没解散成的（当时没权限），启动时再试一次
for (const s of Object.values(S)) {
  if (!s.removed || s.dissolved) continue;
  dissolve(s.chatId).then((err) => { if (!err) { s.dissolved = true; st.save(); log('dissolved', s.chatId); } }).catch(() => {});
}
for (const s of Object.values(S)) if (!s.removed && !s.tagged) tagChat(s); // 以前建的群、上次没打成的补上
log('start', Object.keys(S).length, 'sessions');
const stop = () => { for (const c of inbound) c.stop(); st.flush(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
