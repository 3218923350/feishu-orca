// 状态落盘：原子写，写之前先合并成一次
import fs from 'node:fs';

export function store(file, init) {
  let data = init;
  try { data = { ...init, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  let timer = null;
  const flush = () => { timer = null; const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 1)); fs.renameSync(tmp, file); };
  return { data, save() { if (!timer) timer = setTimeout(flush, 300); }, flush() { if (timer) clearTimeout(timer); flush(); } };
}
