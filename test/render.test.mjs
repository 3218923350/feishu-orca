import test from 'node:test';
import assert from 'node:assert/strict';
import { fit, splitText, toolSummary, turnCard, units } from '../lib/render.mjs';

test('splitText 不切开代码块：两边各自补全 ```', () => {
  const text = ['开头', '```js', ...Array.from({ length: 30 }, (_, i) => `line ${i}`), '```', '结尾'].join('\n');
  const parts = splitText(text, 10000, 12);
  assert.ok(parts.length > 2);
  for (const p of parts) assert.equal((p.match(/^```/gm) || []).length % 2, 0, p);
  assert.ok(parts[1].startsWith('```js'));
  assert.equal(parts.join('\n').replace(/\n```\n```js/g, '').includes('line 29'), true);
});

test('splitText 短文本原样一段', () => {
  assert.deepEqual(splitText('你好\n世界'), ['你好\n世界']);
});

test('splitText 超长单行硬切', () => {
  const parts = splitText('x'.repeat(25000), 12000, 280);
  assert.ok(parts.length >= 3);
  assert.equal(parts.join('').length, 25000);
});

const turn = (blocks, extra = {}) => ({ source: 'feishu', prompt: '问题', startedAt: Date.now() - 5000, status: 'running', blocks, cards: [], ...extra });

test('units：正文全文、连续工具合成一组', () => {
  const t = turn([{ type: 'text', text: '先看看' }, { type: 'tools', tools: [{ id: 'a', name: 'Bash', input: { command: 'ls' }, status: 'ok' }, { id: 'b', name: 'Read', input: { file_path: '/x.js' }, status: 'running' }] }, { type: 'text', text: '结论：没问题' }]);
  const us = units(t, true);
  assert.equal(us.length, 3);
  assert.equal(us[0].el.content, '先看看');
  assert.equal(us[1].el.tag, 'collapsible_panel');
  assert.equal(us[2].el.content, '结论：没问题');
});

test('units：电脑上说的话放在最前面', () => {
  const us = units(turn([], { source: 'computer', prompt: '在电脑上问的' }), true);
  assert.match(us[0].el.content, /电脑上说/);
  assert.match(us[0].el.content, /> 在电脑上问的/);
});

test('fit：放不下就停，但至少放一个', () => {
  const us = [{ chars: 8000, lines: 10 }, { chars: 8000, lines: 10 }, { chars: 100, lines: 1 }];
  assert.equal(fit(us, 0, 12000), 1);
  assert.equal(fit(us, 1, 12000), 2);
  assert.equal(fit([{ chars: 50000, lines: 1 }], 0, 12000), 1);
});

test('turnCard：跑着时有中断按钮，结束后没有', () => {
  const t = turn([{ type: 'text', text: 'hi' }]);
  const running = JSON.stringify(turnCard(t, 0, [], { last: true, chatId: 'oc_x' }));
  assert.match(running, /"fo":"esc"/);
  const done = JSON.stringify(turnCard({ ...t, status: 'done', endedAt: Date.now() }, 0, [], { last: true, chatId: 'oc_x' }));
  assert.doesNotMatch(done, /"fo":"esc"/);
  assert.match(done, /完成/);
});

test('toolSummary', () => {
  assert.equal(toolSummary({ name: 'Bash', input: { command: 'npm test' } }), '`npm test`');
  assert.equal(toolSummary({ name: 'TodoWrite', input: { todos: [{ status: 'completed' }, { status: 'pending' }] } }), '1/2 项');
});

test('units：插话显示在这一轮里', () => {
  const t = turn([{ type: 'text', text: '第一次结束' }, { type: 'steer', text: '顺便说下星期几', source: 'feishu' }, { type: 'steer', text: '电脑上补一句', source: 'computer' }]);
  const us = units(t, true);
  assert.match(us[1].el.content, /^> 💬 \*\*你插话：\*\* 顺便说下星期几/);
  assert.match(us[2].el.content, /电脑上插话/);
});
