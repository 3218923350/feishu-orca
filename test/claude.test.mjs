import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { events, projectDir, readNew } from '../lib/claude.mjs';

test('projectDir 和 Claude Code 的目录名一致', () => {
  assert.ok(projectDir('/Users/me/orca/workspaces/demo/probe1').endsWith('/-Users-me-orca-workspaces-demo-probe1'));
});

test('events：提示词、正文、工具、结果、轮次结束、中断、斜杠命令', () => {
  assert.deepEqual(events({ type: 'user', message: { role: 'user', content: '你好' } }), [{ kind: 'prompt', text: '你好' }]);
  assert.deepEqual(events({ type: 'user', isMeta: true, message: { content: 'x' } }), []);
  assert.deepEqual(events({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }), [{ kind: 'interrupted' }]);
  assert.deepEqual(events({ type: 'user', message: { content: '<command-name>/compact</command-name>\n<command-args></command-args>' } }), [{ kind: 'command', text: '/compact' }]);
  assert.deepEqual(events({ type: 'user', message: { content: '<local-command-stdout>ok</local-command-stdout>' } }), []);
  assert.deepEqual(events({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '21' }] } }), [{ kind: 'text', text: '21', error: false }]);
  assert.deepEqual(events({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }), [{ kind: 'tool', id: 't1', name: 'Bash', input: { command: 'ls' } }]);
  assert.deepEqual(events({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb', is_error: true }] } }), [{ kind: 'result', id: 't1', error: true, text: 'a\nb' }]);
  assert.deepEqual(events({ type: 'system', subtype: 'turn_duration', durationMs: 4172 }), [{ kind: 'end', durationMs: 4172 }]);
  assert.deepEqual(events({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } }), []);
});

test('readNew 只读完整的行，记住读到哪', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fo-')), 'x.jsonl');
  fs.writeFileSync(f, '{"a":1}\n{"b":');
  let r = readNew(f, 0);
  assert.deepEqual(r.entries, [{ a: 1 }]);
  fs.appendFileSync(f, '2}\n');
  r = readNew(f, r.offset);
  assert.deepEqual(r.entries, [{ b: 2 }]);
  assert.deepEqual(readNew(f, r.offset).entries, []);
});

test('events：后台任务通知单独成一类', () => {
  const e = events({ type: 'user', message: { content: '<task-notification>\n<task-id>x</task-id>\n<summary>Background command "sleep 90" completed</summary>\n</task-notification>' } });
  assert.deepEqual(e, [{ kind: 'notification', text: 'Background command "sleep 90" completed' }]);
});

test('events：模型忙时插的话（queued_command）', () => {
  // 2026-11-09 steer-probe 实测的记录行
  const d = { type: 'attachment', attachment: { type: 'queued_command', prompt: '插话：总结时顺便说一下今天星期几', source_uuid: 'f795', delivery_id: '2da7', commandMode: 'prompt' } };
  assert.deepEqual(events(d), [{ kind: 'steer', text: '插话：总结时顺便说一下今天星期几' }]);
  assert.deepEqual(events({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>\n<summary>x</summary>' } }), []);
  assert.deepEqual(events({ type: 'queue-operation', operation: 'enqueue', content: 'x' }), []);
});
