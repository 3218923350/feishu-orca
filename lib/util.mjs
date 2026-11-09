// 小工具：终端里的选择题、提示词比对、工作树起名

// 终端画面 → 问题和选项（Claude 的 AskUserQuestion / 确认框：「❯ 1. xxx」「  2. xxx」）
export function parsePrompt(lines) {
  let start = 0;
  lines.forEach((l, i) => { if (/^\s*(⏺|❯ (?!\d+\.))/.test(l)) start = i + 1; }); // 最后一次输入回显或模型输出之后才是提示框
  const region = lines.slice(start).map((l) => l.replace(/\s+$/, ''));
  const options = [];
  let firstOpt = -1;
  region.forEach((l, i) => {
    const m = l.match(/^\s*(?:❯\s*)?(\d+)\.\s+(.+)$/);
    if (m && !options.some((o) => o.n === m[1])) { options.push({ n: m[1], label: m[2].trim() }); if (firstOpt < 0) firstOpt = i; }
  });
  const isText = (l) => l.trim() && !/^[\s─━═-]+$/.test(l) && !/^\s*[☐☒✔□■]/.test(l.trim());
  const before = (firstOpt < 0 ? region : region.slice(0, firstOpt)).filter(isText);
  const question = (before.reverse().find((l) => /[?？:：]\s*$/.test(l)) || before[0] || '').trim();
  const screen = region.join('\n').replace(/\n{3,}/g, '\n\n').trim() || lines.join('\n').trim();
  return { question, options, screen };
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// 会话记录里那句话是不是我们发的（排队时几条可能被拼成一条）
export function sameText(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || (y.length >= 8 && x.includes(y)) || (x.length >= 8 && y.includes(x));
}

export function worktreeName(input, now = new Date()) {
  const s = String(input || '').trim().replace(/[\s~^:?*[\]\\]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/\.\.+/g, '.').slice(0, 50);
  if (s) return s;
  const p = (n) => String(n).padStart(2, '0');
  return `feishu-${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}
