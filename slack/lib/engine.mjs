import fs from 'node:fs';
import crypto from 'node:crypto';
import { events, transcriptPath, readNew } from './claude.mjs';
import { SerialQueue, once } from './state.mjs';
import { renderTurn, sessionCard, waitingCard } from './ui.mjs';
import { parsePrompt } from './util.mjs';
import { provisionChannel } from './channels.mjs';

export class Engine {
  constructor({ state, orca, slack, config, log = () => {}, fileFor = s => transcriptPath(s.path, s.sessionId) }) {
    Object.assign(this, { state, orca, slack, config, log });
    this.fileFor = fileFor;
    this.queue = new SerialQueue(); this.polling = false; this.renderAt = new Map(); this.waitAt = new Map(); this.bindingAt = new Map();
  }
  get sessions() { return Object.values(this.state.data.sessions); }
  session(id) { const s = this.state.data.sessions[id]; if (!s) throw new Error('会话不存在'); return s; }
  byThread(channel, thread) { return this.sessions.find(s => s.channel === channel && (s.layout === 'channel' || s.thread === thread)); }
  async post(s, text, blocks) {
    return this.slack.chat.postMessage({ channel: s.channel, ...(s.layout === 'channel' ? {} : { thread_ts: s.thread }), text, ...(blocks ? { blocks } : {}), unfurl_links: false, unfurl_media: false, parse: 'none' });
  }
  async attach(live) {
    return this.queue.run(`bind:${live.path}:${live.sessionId}`, () => this.attachOnce(live));
  }
  async attachOnce(live) {
    const existing = this.sessions.find(s => s.sessionId === live.sessionId && s.path === live.path);
    const dedicated = this.config.sessionLayout === 'channel';
    if (existing && (!dedicated || existing.layout === 'channel')) return existing;
    await this.orca.resolve(live);
    const file = this.fileFor(live);
    // Stable ID survives provisioning failures before the session becomes pollable.
    const ids = this.state.data.bindingIds ||= {};
    const key = JSON.stringify([live.path, live.sessionId]);
    const id = existing?.id || (ids[key] ||= crypto.randomUUID()); this.state.save();
    const s = { ...live, id, channel: this.config.channelId, thread: null, paused: false, offset: fs.existsSync(file) ? fs.statSync(file).size : 0, turns: [], pending: [], createdAt: Date.now() };
    if (dedicated) {
      const bind = async () => {
        const bound = await provisionChannel(this, existing || s);
        if (existing) {
          bound.previousThreads = [...(existing.previousThreads || []), { channel: existing.channel, thread: existing.thread }];
          bound.turns = existing.turns.map(t => ({ ...t, messages: [], dirty: t.status === 'running' }));
        }
        const result = existing ? Object.assign(existing, bound) : bound;
        this.state.data.sessions[id] = result; this.state.save(); return result;
      };
      // Serialize migration against polling and user sends to the old thread.
      return this.queue.run(id, bind);
    }
    const msg = await this.slack.chat.postMessage({ channel: s.channel, text: s.title || 'Claude 会话', blocks: sessionCard(s), unfurl_links: false, unfurl_media: false });
    s.thread = msg.ts;
    this.state.data.sessions[s.id] = s; this.state.save();
    return s;
  }
  async updateHeader(s) { await this.slack.chat.update({ channel: s.channel, ts: s.thread, text: s.title, blocks: sessionCard(s) }); }
  async send(s, text, eventId) {
    return this.queue.run(s.id, async () => {
      if (s.paused) throw new Error('已暂停同步，请先点“恢复同步”');
      return once(this.state, eventId, async () => {
        s.pending.push({ text, at: Date.now() }); this.state.save();
        try {
          const result = await this.orca.send(s, text);
          const receipt = result.send?.prompt || {};
          const started = receipt.stages?.includes('turn_started');
          await this.post(s, started ? '已送达 Claude，开始处理。' : '输入已提交，尚未确认开始执行；请等待或看终端，不会自动重发。');
          return { requestId: receipt.requestId, stages: receipt.stages || [] };
        } catch (e) {
          s.pending = s.pending.filter(p => p.text !== text); this.state.save();
          throw e;
        }
      });
    });
  }
  async control(s, action, receiptId) {
    return this.queue.run(s.id, () => once(this.state, receiptId, async () => {
      if (action === 'pause' || action === 'resume') {
        s.paused = action === 'pause'; this.state.save(); await this.updateHeader(s); return { paused: s.paused };
      }
      await this.orca.key(s, action === 'stop' ? 'esc' : action);
      return { key: action };
    }));
  }
  onEvent(s, event) {
    let turn = s.turns.at(-1);
    const start = prompt => {
      // A new user turn is an explicit boundary. No terminal polling can invent an interruption.
      if (turn?.status === 'running') { turn.status = 'done'; turn.dirty = true; }
      const p = s.pending.findIndex(p => p.text.replace(/\s+/g, ' ').trim() === prompt.replace(/\s+/g, ' ').trim());
      turn = { id: crypto.randomUUID(), source: p >= 0 ? 'slack' : 'computer', prompt, blocks: [], status: 'running', messages: [], dirty: true, at: Date.now() };
      if (p >= 0) s.pending.splice(p, 1);
      s.turns.push(turn);
    };
    if (event.kind === 'prompt') { start(event.text); return; }
    if (!turn || turn.status !== 'running') {
      if (['text', 'tool', 'steer'].includes(event.kind)) start(''); else return;
    }
    if (event.kind === 'text') turn.blocks.push({ kind: 'text', text: event.text });
    if (event.kind === 'tool') turn.blocks.push({ kind: 'tool', name: event.name, id: event.id });
    if (event.kind === 'result') { const b = turn.blocks.find(b => b.id === event.id); if (b) b.error = event.error; }
    if (event.kind === 'steer') turn.blocks.push({ kind: 'text', text: `补充：${event.text}` });
    if (event.kind === 'end') turn.status = 'done';
    if (event.kind === 'interrupted') turn.status = 'interrupted';
    turn.dirty = true;
  }
  async render(s) {
    for (const turn of s.turns.filter(t => t.dirty)) {
      const pages = renderTurn(turn);
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i]; const hash = JSON.stringify(page);
        if (turn.messages[i]?.hash === hash) continue;
        if (turn.messages[i]) await this.slack.chat.update({ channel: s.channel, ts: turn.messages[i].ts, ...page });
        else {
          const msg = await this.post(s, page.text, page.blocks);
          turn.messages[i] = { ts: msg.ts }; this.state.save();
        }
        turn.messages[i].hash = hash; this.state.save();
      }
      turn.dirty = false; this.state.save();
    }
    // Keep a bounded local history after Slack delivery; transcripts remain on disk.
    while (s.turns.length > 12 && !s.turns[0].dirty && s.turns[0].status !== 'running') s.turns.shift();
  }
  async pollSession(s) {
    if (s.paused) return;
    if (Date.now() - (this.bindingAt.get(s.id) || 0) > 15000) {
      this.bindingAt.set(s.id, Date.now());
      try {
        const live = await this.orca.liveSessions();
        const exact = live.find(x => x.sessionId === s.sessionId && x.path === s.path);
        if (exact) { s.terminal = exact.terminal; s.paneKey = exact.paneKey; }
        else {
          // /clear or /resume in the SAME live pane. Never infer ownership from cwd/newest file.
          const next = live.find(x => x.path === s.path && x.paneKey === s.paneKey && x.terminal === s.terminal);
          if (next && !this.sessions.some(other => other !== s && other.sessionId === next.sessionId)) {
            const turn = s.turns.at(-1); if (turn?.status === 'running') { turn.status = 'done'; turn.dirty = true; }
            s.sessionId = next.sessionId; s.offset = 0; s.waitHash = null;
            this.state.save();
            await this.post(s, '终端切换了 Claude 会话，线程已跟随同一终端中的新会话。');
          }
        }
        this.state.save();
      } catch (e) { this.log('binding-observation-unavailable', s.id, e.message); }
    }
    const file = this.fileFor(s);
    if (!fs.existsSync(file)) return;
    const next = readNew(file, s.offset);
    for (const row of next.entries) for (const event of events(row)) this.onEvent(s, event);
    if (next.offset !== s.offset) { s.offset = next.offset; this.state.save(); }
    const now = Date.now();
    if (now - (this.renderAt.get(s.id) || 0) >= this.config.renderMs) {
      await this.render(s); this.renderAt.set(s.id, now);
    }
    if (now - (this.waitAt.get(s.id) || 0) > 15000 && s.turns.at(-1)?.status === 'running') {
      this.waitAt.set(s.id, now);
      try {
        const screen = await this.orca.screen(s);
        if (screen.waiting) {
          const parsed = parsePrompt(screen.lines);
          const hash = crypto.createHash('sha256').update(parsed.screen).digest('hex');
          if (hash !== s.waitHash) { await this.post(s, '等你回答', waitingCard(s, parsed)); s.waitHash = hash; this.state.save(); }
        } else { s.waitHash = null; }
      } catch (e) {
        // Unknown transport/liveness is NOT evidence that the agent exited.
        this.log('terminal-observation-unavailable', s.id, e.message);
      }
    }
    s.pending = s.pending.filter(p => now - p.at < 600000);
  }
  async tick() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const s of this.sessions) await this.queue.run(s.id, () => this.pollSession(s)).catch(e => this.log('poll-failed', s.id, e.message));
    } finally { this.polling = false; }
  }
}
