import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openState, once, SerialQueue } from '../lib/state.mjs';
import { matchingTerminals, Orca, processMatches } from '../lib/orca.mjs';
import { Engine } from '../lib/engine.mjs';
import { registerSlack } from '../lib/slack.mjs';
import { authorized, redact } from '../lib/config.mjs';
import { safeDownloadUrl } from '../lib/media.mjs';
import { chunkText, renderTurn, newModal, validateNew, sessionCard } from '../lib/ui.mjs';

const session = { sessionId: 'session-1', path: '/repo' };
const terminal = { handle: 'current', tabId: 'tab', leafId: 'leaf', executionHostId: 'local', connected: true, writable: true, agentIdentity: 'claude', worktreePath: '/repo' };
const record = { paneKey: 'tab:leaf', providerSession: { id: 'session-1', cwd: '/repo' }, agentPresence: { sessionOwner: true, session: 'session-1' } };
const clone = x => structuredClone(x);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-orca-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = openState(path.join(dir, 'state.json'));
  const file = path.join(dir, 'transcript.jsonl'); fs.writeFileSync(file, '');
  const sent = [], posted = [], updated = [];
  const config = { ownerId: 'U_OWNER', teamId: 'T_TEAM', channelId: 'C_CONTROL', home: dir, renderMs: 0 };
  const orca = { resolve: async s => s, send: async (s, text) => { sent.push({ s: s.id, text }); return { send: { prompt: { stages: ['input_accepted', 'turn_started'] } } }; }, key: async () => {}, liveSessions: async () => [], screen: async () => ({ waiting: false, lines: [] }) };
  const slack = { chat: {
    postMessage: async x => { posted.push(x); return { ts: String(posted.length) }; },
    update: async x => { updated.push(x); return {}; },
    getPermalink: async () => ({ permalink: 'https://example.slack.com/archives/C/1' }),
  } };
  const engine = new Engine({ state, orca, slack, config, fileFor: () => file });
  const s = { ...session, id: 's', title: 'test', terminal: 'current', paneKey: 'tab:leaf', channel: 'C_CONTROL', thread: 'root', offset: 0, turns: [], pending: [] };
  state.data.sessions.s = s;
  const append = rows => fs.appendFileSync(file, rows.map(x => JSON.stringify(x)).join('\n') + '\n');
  return { dir, file, state, sent, posted, updated, config, orca, slack, engine, s, append };
}
const prompt = text => ({ type: 'user', message: { content: text } });
const reply = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const end = { type: 'system', subtype: 'turn_duration', durationMs: 2000 };

test('binding requires exact session, pane, path, host and a Claude process', () => {
  assert.equal(matchingTerminals(session, [terminal], [record]).length, 1);
  for (const change of [{ executionHostId: 'remote' }, { agentIdentity: null }, { connected: false }, { writable: false }, { leafId: 'other' }, { worktreePath: '/other' }]) {
    assert.deepEqual(matchingTerminals(session, [{ ...terminal, ...change }], [record]), []);
  }
  assert.deepEqual(matchingTerminals({ ...session, sessionId: 'other' }, [terminal], [record]), []);
});
test('terminal-list timeout preserves binding and never sends to a shell', async () => {
  let sends = 0;
  const s = { ...session, terminal: 'old' };
  const o = new Orca('orca', { run: async (_bin, args) => { if (args.includes('send')) sends++; throw new Error('timeout'); } });
  await assert.rejects(o.send(s, 'hello'), /结果未知/);
  assert.equal(s.terminal, 'old'); assert.equal(sends, 0);
});
test('truncated enumeration is unknown, never an empty live list', async () => {
  const o = new Orca('orca', { run: async () => ({ stdout: JSON.stringify({ ok: true, result: { terminals: [], truncated: true } }) }) });
  await assert.rejects(o.terminals(), /不完整/);
});
test('a stale handle rebinds only to the same session and checks again before send', async () => {
  const calls = [];
  const o = new Orca('orca', { records: async () => [record], verifyProcess: async () => true, run: async (_bin, args) => {
    calls.push(args);
    const result = args[1] === 'list' ? { terminals: [terminal] } : args[1] === 'show' ? { terminal } : { send: { prompt: { stages: ['input_accepted'] } } };
    return { stdout: JSON.stringify({ ok: true, result }) };
  } });
  const s = { ...session, terminal: 'old' };
  await o.send(s, 'hello');
  assert.equal(s.terminal, 'current');
  assert.equal(calls.filter(x => x[1] === 'send').length, 1);
  assert.ok(calls.at(-1).includes('current'));
  assert.ok(calls.every(x => x.includes('local')));
});
test('exit to shell at final send boundary is rejected', async () => {
  let sends = 0;
  const o = new Orca('orca', { records: async () => [record], verifyProcess: async () => true, run: async (_bin, args) => {
    if (args[1] === 'send') sends++;
    return { stdout: JSON.stringify({ ok: true, result: args[1] === 'list' ? { terminals: [terminal] } : { terminal: { ...terminal, agentIdentity: null } } }) };
  } });
  await assert.rejects(o.send({ ...session }, 'hello'), /状态发生变化/); assert.equal(sends, 0);
});
test('stale hook process identity is not accepted', async () => {
  const o = new Orca('orca', { records: async () => [record], verifyProcess: async () => false, run: async () => ({ stdout: JSON.stringify({ ok: true, result: { terminals: [terminal] } }) }) });
  await assert.rejects(o.resolve({ ...session }), /无法确认/);
});
test('process start identity is compared in Orca UTC timezone, not local Mac timezone', async () => {
  const r = { agentPresence: { process: { pid: 123, platform: 'darwin', startTime: 'Fri Nov 13 05:38:54 2026' } } };
  assert.ok(await processMatches(r, async (_bin, _args, options) => {
    assert.equal(options.env.TZ, 'UTC'); assert.equal(options.env.LC_ALL, 'C');
    return { stdout: 'Fri Nov 13 05:38:54 2026\n' };
  }));
  assert.equal(await processMatches(r, async () => ({ stdout: 'Fri Nov 13 05:40:00 2026' })), false);
});
test('ambiguous same-session terminals refuse dispatch', () => {
  const t2 = { ...terminal, handle: 'second', leafId: 'leaf2' };
  assert.equal(matchingTerminals(session, [terminal, t2], [record, { ...record, paneKey: 'tab:leaf2' }]).length, 2);
});
test('event receipts survive restart and prevent duplicate prompts', async t => {
  const f = fixture(t);
  await f.engine.send(f.s, 'hello', 'E1');
  const reloaded = openState(path.join(f.dir, 'state.json'));
  await once(reloaded, 'E1', () => assert.fail('must not replay'));
  assert.equal(f.sent.length, 1);
});
test('an ambiguous delivery failure is never automatically resent', async t => {
  const f = fixture(t); let attempted = 0;
  f.orca.send = async () => { attempted++; throw new Error('connection reset after send'); };
  await assert.rejects(f.engine.send(f.s, 'hello', 'E2'));
  await f.engine.send(f.s, 'hello', 'E2');
  assert.equal(attempted, 1); assert.equal(f.state.data.receipts.E2.status, 'uncertain');
});
test('simultaneous duplicate events serialize to a single prompt', async t => {
  const f = fixture(t);
  await Promise.all([f.engine.send(f.s, 'hello', 'E1'), f.engine.send(f.s, 'hello', 'E1')]);
  assert.equal(f.sent.length, 1);
});
test('transcript updates one Slack turn, finishes it, and restart does not replay', async t => {
  const f = fixture(t);
  f.append([prompt('local question'), reply('first')]); await f.engine.tick();
  assert.equal(f.s.turns[0].source, 'computer'); assert.equal(f.s.turns[0].status, 'running');
  f.append([reply('second'), end]); await f.engine.tick();
  assert.equal(f.s.turns[0].status, 'done');
  assert.equal(f.posted.filter(p => p.blocks).length, 1); assert.equal(f.updated.length, 1);
  const offset = f.s.offset; await f.engine.tick();
  assert.equal(f.s.offset, offset); assert.equal(f.updated.length, 1);
  assert.ok(f.updated[0].blocks.some(b => b.text?.text.includes('second')));
  assert.equal(f.posted[0].thread_ts, 'root');
});
test('observation timeout does not invent terminal interruption', async t => {
  const f = fixture(t); f.orca.screen = async () => { throw new Error('timeout'); }; f.orca.liveSessions = async () => { throw new Error('timeout'); };
  f.append([prompt('keep going'), reply('running')]); await f.engine.tick();
  assert.equal(f.s.terminal, 'current'); assert.equal(f.s.turns[0].status, 'running');
});
test('explicit transcript interruption remains visible', async t => {
  const f = fixture(t); f.append([prompt('work'), reply('starting'), prompt('[Request interrupted by user]')]); await f.engine.tick();
  assert.equal(f.s.turns[0].status, 'interrupted');
});
test('paused threads accept no prompt and preserve unread transcript offset', async t => {
  const f = fixture(t); f.s.paused = true; f.append([prompt('local')]);
  await assert.rejects(f.engine.send(f.s, 'no', 'E1'), /暂停/); await f.engine.tick();
  assert.equal(f.s.offset, 0); assert.equal(f.sent.length, 0);
});
test('clear follows only the exact pane and handle; unrelated sessions cannot hijack it', async t => {
  const f = fixture(t); f.orca.liveSessions = async () => [{ ...session, sessionId: 'other', paneKey: 'other:leaf', terminal: 'other' }];
  await f.engine.tick(); assert.equal(f.s.sessionId, 'session-1');
  f.engine.bindingAt.clear(); f.orca.liveSessions = async () => [{ ...session, sessionId: 'cleared', paneKey: 'tab:leaf', terminal: 'current' }];
  await f.engine.tick(); assert.equal(f.s.sessionId, 'cleared');
});
test('untrusted users and other workspaces cannot operate the bridge', () => {
  const c = { ownerId: 'U1', teamId: 'T1' };
  assert.ok(authorized(c, 'U1', 'T1')); assert.ok(!authorized(c, 'U2', 'T1')); assert.ok(!authorized(c, 'U1', 'T2')); assert.ok(!authorized(c, 'U1'));
});
test('actual Slack message handler ignores other users, other threads and bot loops', async t => {
  const f = fixture(t); const handlers = {};
  const app = { command() {}, action() {}, view() {}, error() {}, event(name, fn) { handlers[name] = fn; } };
  registerSlack(app, f.engine);
  for (const change of [{ user: 'U_OTHER' }, { thread_ts: 'wrong' }, { bot_id: 'BOT' }, { subtype: 'message_changed' }]) {
    await handlers.message({ body: { team_id: 'T_TEAM', event_id: 'E1' }, event: { user: 'U_OWNER', channel: 'C_CONTROL', thread_ts: 'root', text: 'hello', ...change }, client: f.slack });
  }
  assert.equal(f.sent.length, 0);
  const args = { body: { team_id: 'T_TEAM', event_id: 'E_OK' }, event: { user: 'U_OWNER', channel: 'C_CONTROL', thread_ts: 'root', text: 'hello' }, client: f.slack };
  await handlers.message(args); await handlers.message(args); assert.equal(f.sent.length, 1);
});
test('new-session modal acknowledges immediately and duplicate submission creates only once', async t => {
  const f = fixture(t); const handlers = { views: new Map(), actions: [] }; let created = 0, acked = 0;
  const app = { command() {}, event() {}, error() {}, action(pattern, fn) { handlers.actions.push([pattern, fn]); }, view(id, fn) { handlers.views.set(id, fn); } };
  f.slack.views = { open: async () => ({ view: { id: 'V_NEW' } }), update: async () => {} };
  f.orca.catalog = async () => ({ repos: [{ id: 'repo', displayName: 'repo' }], models: [{ id: 'opus', label: 'Opus', efforts: [] }] });
  f.orca.create = async () => { assert.ok(acked >= 2); created++; return { ...session, title: 'created' }; };
  registerSlack(app, f.engine);
  const newHandler = handlers.actions.find(([pattern]) => pattern instanceof RegExp && pattern.test('new'))[1];
  await newHandler({ ack: async () => { acked++; }, body: { user: { id: 'U_OWNER' }, team: { id: 'T_TEAM' }, trigger_id: 'trigger' }, action: { action_id: 'new' }, client: f.slack });
  const view = { id: 'V_SUBMIT', state: { values: { repo: { repo: { selected_option: { value: 'repo' } } }, model: { model: { selected_option: { value: 'opus' } } } } } };
  const args = { ack: async () => { acked++; }, body: { user: { id: 'U_OWNER' }, team: { id: 'T_TEAM' } }, view, client: f.slack };
  await handlers.views.get('create_session')(args); await handlers.views.get('create_session')(args);
  assert.equal(created, 1); assert.equal(f.state.data.jobs.V_SUBMIT.status, 'created');
});
test('wrong-owner key callbacks acknowledge without operating terminal', async t => {
  const f = fixture(t); const views = new Map(); let keys = 0, acked = false;
  f.orca.key = async () => { keys++; };
  registerSlack({ command() {}, event() {}, error() {}, action() {}, view(id, fn) { views.set(id, fn); } }, f.engine);
  await views.get('key_session')({ ack: async () => { acked = true; }, body: { user: { id: 'U_OTHER' }, team: { id: 'T_TEAM' } }, view: { private_metadata: 's' } });
  assert.ok(acked); assert.equal(keys, 0);
});
test('Home session links use the required Slack channel parameter', async t => {
  const f = fixture(t); const events = new Map(); let published = false;
  f.slack.chat.getPermalink = async args => {
    assert.equal(args.channel, 'C_CONTROL'); assert.equal(args.message_ts, 'root');
    return { permalink: 'https://example.slack.com/archives/C/1' };
  };
  f.slack.views = { publish: async () => { published = true; } };
  registerSlack({ command() {}, action() {}, view() {}, error() {}, event(id, fn) { events.set(id, fn); } }, f.engine);
  await events.get('app_home_opened')({ body: { team_id: 'T_TEAM' }, event: { user: 'U_OWNER' }, client: f.slack });
  assert.ok(published, 'Home must publish after resolving the thread link');
});
test('output escapes Slack mass mentions, preserves all long text within limits', () => {
  const text = '<!channel> & <@U1> ' + '中文😀'.repeat(4000);
  const pages = renderTurn({ status: 'done', source: 'computer', prompt: '', blocks: [{ kind: 'text', text }] });
  assert.ok(pages.length > 1);
  const full = pages.map(p => p.blocks[1].text.text).join('');
  assert.ok(full.startsWith('&lt;!channel&gt; &amp; &lt;@U1&gt;'));
  assert.ok(pages.every(p => p.blocks[1].text.text.length <= 3000));
  assert.equal(chunkText(text).join(''), text);
});
test('malicious file download URLs cannot receive the Slack bot token', () => {
  assert.equal(safeDownloadUrl('https://files.slack.com/files-pri/T-F/x').hostname, 'files.slack.com');
  for (const u of ['http://files.slack.com/x', 'https://files.slack.com.evil.test/x', 'https://evil.test/x', 'https://u:p@files.slack.com/x', 'https://files.slack.com:8443/x']) assert.throws(() => safeDownloadUrl(u));
});
test('corrupted persistent state fails closed', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.dir, 'state.json'), '{bad');
  assert.throws(() => openState(path.join(f.dir, 'state.json')));
});
test('modal uses current model IDs and validates effort/name', () => {
  const catalog = { repos: [{ id: 'repo', displayName: 'repo' }], models: [{ id: 'opus', label: 'Opus', efforts: ['high'] }] };
  const modal = newModal(catalog); assert.equal(modal.blocks[1].element.options[0].value, 'opus');
  const view = { state: { values: { repo: { repo: { selected_option: { value: 'repo' } } }, model: { model: { selected_option: { value: 'opus' } } }, effort: { effort: { selected_option: { value: 'invalid' } } }, name: { name: { value: '../bad' } } } } };
  const { errors } = validateNew(view, catalog); assert.ok(errors.effort); assert.ok(errors.name);
});
test('session buttons are within Slack action limits and tokens are redacted', () => {
  assert.equal(sessionCard({ id: 's', path: '/repo' })[1].elements.length, 5);
  assert.equal(redact('xoxb-secret-value xapp-other-secret'), '<REDACTED> <REDACTED>');
});

function privateChannels(f) {
  f.config.sessionLayout = 'channel';
  const created = [], invited = [];
  f.slack.conversations = {
    create: async args => { created.push(args); return { channel: { id: `C_PRIVATE_${created.length}` } }; },
    invite: async args => { invited.push(args); return {}; },
  };
  return { created, invited };
}
test('private sessions create separate private channels, invite only the owner and route root messages', async t => {
  const f = fixture(t); const c = privateChannels(f);
  const a = await f.engine.attach({ sessionId: 'new-a', path: '/repo', title: 'A' });
  const b = await f.engine.attach({ sessionId: 'new-b', path: '/repo', title: 'B' });
  assert.notEqual(a.channel, b.channel);
  assert.ok(c.created.every(x => x.is_private === true));
  assert.ok(c.invited.every(x => x.users === f.config.ownerId));
  assert.equal(f.engine.byThread(a.channel, undefined), a);
  assert.equal(f.engine.byThread(b.channel, 'reply'), b);
  assert.equal(f.engine.byThread(f.s.channel, undefined), undefined);
  await f.engine.post(a, 'response');
  assert.equal(f.posted.at(-1).channel, a.channel);
  assert.equal(f.posted.at(-1).thread_ts, undefined);
  await f.engine.attach({ sessionId: 'new-a', path: '/repo' });
  assert.equal(c.created.length, 2);
});
test('invitation failure retries the same persisted channel even after restart', async t => {
  const f = fixture(t); const c = privateChannels(f); const invite = f.slack.conversations.invite;
  f.slack.conversations.invite = async () => { throw new Error('invite timeout'); };
  const live = { sessionId: 'new', path: '/repo', title: 'New' };
  await assert.rejects(f.engine.attach(live), /invite timeout/);
  assert.equal(f.engine.sessions.length, 1, 'incomplete channel is not polled');
  const reloaded = openState(path.join(f.dir, 'state.json'));
  const engine = new Engine({ state: reloaded, config: f.config, slack: f.slack, orca: f.orca, fileFor: () => f.file });
  f.slack.conversations.invite = invite;
  const s = await engine.attach(live);
  assert.equal(c.created.length, 1); assert.equal(s.channel, 'C_PRIVATE_1');
});
test('migration leaves old mapping intact on failure and never edits old messages in new channel', async t => {
  const f = fixture(t); privateChannels(f);
  f.s.turns.push({ status: 'running', messages: [{ ts: 'old-reply' }], blocks: [], dirty: true });
  const invite = f.slack.conversations.invite;
  f.slack.conversations.invite = async () => { throw new Error('scope'); };
  await assert.rejects(f.engine.attach(session), /scope/);
  assert.equal(f.engine.session('s').channel, 'C_CONTROL');
  f.slack.conversations.invite = invite;
  const s = await f.engine.attach(session);
  assert.equal(s.id, 's'); assert.equal(f.engine.sessions.length, 1);
  assert.equal(s.turns[0].messages.length, 0);
  assert.deepEqual(s.previousThreads, [{ channel: 'C_CONTROL', thread: 'root' }]);
});
test('concurrent attach requests provision only one channel for a session', async t => {
  const f = fixture(t); const c = privateChannels(f);
  const live = { sessionId: 'new', path: '/repo' };
  const [a, b] = await Promise.all([f.engine.attach(live), f.engine.attach(live)]);
  assert.equal(a.id, b.id); assert.equal(c.created.length, 1);
});
test('lost channel-create response recovers by persisted private channel name', async t => {
  const f = fixture(t); privateChannels(f); let name;
  f.slack.conversations.create = async args => { name = args.name; throw new Error('timeout'); };
  const live = { sessionId: 'new', path: '/repo' };
  await assert.rejects(f.engine.attach(live), /timeout/);
  f.slack.conversations.create = async args => { assert.equal(args.name, name); throw { data: { error: 'name_taken' } }; };
  f.slack.conversations.list = async () => ({ channels: [{ name, id: 'C_RECOVERED', is_private: true, is_member: true }] });
  const s = await f.engine.attach(live); assert.equal(s.channel, 'C_RECOVERED');
});
test('attachment succeeds when permalink API fails after binding; retries do not duplicate cards', async t => {
  const f = fixture(t); const handlers = []; const updates = [];
  f.orca.sessionCatalog = async () => ({ current: [{ ...session, key: 'test', available: true }], history: [] });
  f.slack.views = { open: async () => ({ view: { id: 'V' } }), update: async x => updates.push(x) };
  f.slack.chat.getPermalink = async args => {
    assert.equal(args.channel, 'C_CONTROL'); assert.equal(args.message_ts, 'root');
    throw Object.assign(new Error('An API error occurred: invalid_arguments'), { data: { error: 'invalid_arguments' } });
  };
  registerSlack({ command() {}, event() {}, view() {}, error() {}, action(id, fn) { handlers.push([id, fn]); } }, f.engine);
  const invoke = async id => {
    const [, fn] = handlers.find(([p]) => typeof p === 'string' ? p === id : p.test(id));
    await fn({ ack: async () => {}, body: { user: { id: 'U_OWNER' }, team: { id: 'T_TEAM' }, view: { id: 'V' }, trigger_id: 'trigger' }, action: { action_id: id, value: 'test' }, client: f.slack });
  };
  await invoke('list'); await invoke('attach'); await invoke('attach');
  assert.equal(updates.at(-1).view.title.text, '已接入');
  assert.match(JSON.stringify(updates.at(-1)), /app.slack.com\/client\/T_TEAM\/C_CONTROL/);
  assert.equal(f.posted.length, 0); assert.equal(f.engine.sessions.length, 1);
});
