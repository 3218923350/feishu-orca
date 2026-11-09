import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrompt, sameText, worktreeName } from '../lib/util.mjs';

// 2026-11-06 probe1 终端里 AskUserQuestion 的真实画面
const SCREEN = [
  '❯ 第一行：请记住数字 7', '  第二行：然后只回复这个数字乘以 3 的结果', '⏺ 21', '✻ Crunched for 3s · done 4:06 PM',
  '❯ 请调用 AskUserQuestion 工具问我一个问题：喜欢哪种水果，选项 苹果/香蕉/橙子，单选。拿到答案后只回复答案。',
  '────────────────────────────────', ' ☐ 水果', '你喜欢哪种水果？', '❯ 1. 苹果', '     苹果', '  2. 香蕉', '     香蕉', '  3. 橙子', '     橙子', '  4. Type something.',
  '────────────────────────────────', '  5. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel',
];

test('parsePrompt 读出问题和选项，不把之前的回显算进去', () => {
  const p = parsePrompt(SCREEN);
  assert.equal(p.question, '你喜欢哪种水果？');
  assert.deepEqual(p.options.map((o) => `${o.n}:${o.label}`), ['1:苹果', '2:香蕉', '3:橙子', '4:Type something.', '5:Chat about this']);
  assert.ok(!p.screen.includes('请调用'));
});

test('parsePrompt 没有选项时给出画面', () => {
  const p = parsePrompt(['⏺ 好的', 'Do you want to proceed?', '  y/n']);
  assert.equal(p.options.length, 0);
  assert.equal(p.question, 'Do you want to proceed?');
});

test('sameText：空白不同、排队拼接都算同一句', () => {
  assert.ok(sameText('第一行\n第二行', '第一行 第二行'));
  assert.ok(sameText('帮我看看这个报错是什么原因\n\n顺便跑下测试', '帮我看看这个报错是什么原因'));
  assert.ok(!sameText('好', '好的呀'));
  assert.ok(!sameText('', 'x'));
});

test('worktreeName：清掉 git 不认的字符，空的自动起名', () => {
  assert.equal(worktreeName(' fix login bug '), 'fix-login-bug');
  assert.equal(worktreeName('a:b?c'), 'a-b-c');
  assert.equal(worktreeName('', new Date(2026, 10, 6, 9, 5)), 'feishu-1106-0905');
});
