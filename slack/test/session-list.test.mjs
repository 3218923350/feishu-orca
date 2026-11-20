import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSlack } from '../lib/slack.mjs';
import { Orca } from '../lib/orca.mjs';

function harness(count = 41) {
  const callbacks = [];
  const views = new Map();
  const items = Array.from({ length: count }, (_, i) => ({ key: `s${i}`, sessionId: `s${i}`, title: `session ${i}`, path: '/repo', available: true, category: 'terminal' }));
  const app = { command() {}, event() {}, error() {}, view() {}, action(pattern, fn) { callbacks.push([pattern, fn]); } };
  let viewSeq = 0;
  const client = { views: { open: async () => ({ view: { id: `V${++viewSeq}` } }), update: async r => { views.set(r.view_id, r.view); } } };
  registerSlack(app, { config: { ownerId: 'U', teamId: 'T' }, state: { data: {} }, orca: { liveSessions: async () => items, sessionCatalog: async () => ({ current: items, history: [{ key: 'h', title: 'old history', path: '/repo', category: 'history', available: false }], warnings: [] }) } });
  const invoke = async (id, value, viewId) => {
    const found = callbacks.find(([p]) => typeof p === 'string' ? p === id : p.test(id));
    assert.ok(found, `missing ${id} handler`);
    await found[1]({ ack: async () => {}, body: { user: { id: 'U' }, team: { id: 'T' }, trigger_id: 'x', ...(viewId ? { view: { id: viewId } } : {}) }, action: { action_id: id, value }, client });
  };
  return { items, views, invoke };
}
const buttons = view => view.blocks.flatMap(b => b.elements || []).filter(e => e.type === 'button');
test('all 41 sessions are reachable through pagination, including the last item', async () => {
  const h = harness(); await h.invoke('list');
  const seen = new Set(); let pages = 0;
  while (true) {
    const view = h.views.get('V1');
    assert.ok(view.blocks.length <= 100);
    for (const b of buttons(view).filter(b => b.action_id === 'attach')) seen.add(b.value);
    const next = buttons(view).find(b => b.action_id === 'list_next');
    pages++;
    if (!next) break;
    assert.ok(pages < 10);
    await h.invoke('list_next', next.value, 'V1');
  }
  assert.equal(seen.size, 41); assert.ok(pages > 1);
});
test('unavailable sessions stay visible with a reason, never an attach button', async () => {
  const h = harness(2); h.items[1].available = false; h.items[1].reason = '需要在 Orca 中恢复';
  await h.invoke('list'); const v = h.views.get('V1');
  assert.match(JSON.stringify(v), /需要在 Orca 中恢复/);
  assert.equal(buttons(v).filter(b => b.action_id === 'attach').length, 1);
});
test('history mode is reachable and independently paginated', async () => {
  const h = harness(); await h.invoke('list');
  const b = buttons(h.views.get('V1')).find(b => b.action_id === 'list_history');
  assert.ok(b); await h.invoke('list_history', b.value, 'V1');
  assert.match(JSON.stringify(h.views.get('V1')), /old history/);
});
test('two open lists keep independent snapshots', async () => {
  const h = harness(); await h.invoke('list');
  const next = buttons(h.views.get('V1')).find(b => b.action_id === 'list_next');
  assert.ok(next);
  h.items.splice(0, h.items.length, { key: 'new', sessionId: 'new', title: 'replacement', available: true });
  await h.invoke('list');
  await h.invoke('list_next', next.value, 'V1');
  assert.doesNotMatch(JSON.stringify(h.views.get('V1')), /replacement/);
});
test('catalog retains sleeping and unsupported Orca entries without enabling dispatch', async () => {
  const o = new Orca('unused');
  o.liveSessions = async () => [{ sessionId: 'live', paneKey: 'pane', title: 'live session', path: '/nonexistent-test-path' }];
  o.call = async args => args[0] === 'agent' ? { agents: [
    { orcaSessionId: 'live-orca', hostId: 'local', agent: 'claude', kind: 'terminal', paneKey: 'pane', title: 'named live' },
    { orcaSessionId: 'sleeping', hostId: 'local', agent: 'claude', kind: 'terminal', paneKey: 'sleeping', title: 'sleeping session' },
    { orcaSessionId: 'chat', hostId: 'local', agent: 'claude', kind: 'chat', paneKey: 'chat', title: 'chat session' },
    { orcaSessionId: 'kimi', hostId: 'local', agent: 'kimi', kind: 'terminal', paneKey: 'kimi', title: 'kimi session' },
  ] } : { worktrees: [] };
  const c = await o.sessionCatalog();
  assert.equal(c.current.length, 4); assert.equal(c.current.filter(x => x.available).length, 1);
  assert.match(c.current.find(x => x.title === 'chat session').reason, /原生聊天/);
  assert.match(c.current.find(x => x.title === 'sleeping session').reason, /恢复/);
});
test('failed live discovery is reported as incomplete rather than hiding all Orca entries', async () => {
  const o = new Orca('unused'); o.liveSessions = async () => { throw new Error('timeout'); };
  o.call = async args => args[0] === 'agent' ? { agents: [{ orcaSessionId: 'id', hostId: 'local', agent: 'claude', kind: 'terminal', title: 'known session' }], truncated: true } : { worktrees: [] };
  const c = await o.sessionCatalog();
  assert.equal(c.current.length, 1); assert.equal(c.current[0].available, false);
  assert.match(c.warnings.join(' '), /验证/); assert.match(c.warnings.join(' '), /截断/);
});
