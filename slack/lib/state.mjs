import fs from 'node:fs';
import path from 'node:path';

export function openState(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Corruption must never silently reset session mappings or delivery receipts.
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, sessions: {}, receipts: {}, jobs: {} };
  if (data.version !== 1 || !data.sessions || !data.receipts || !data.jobs) throw new Error('不兼容的状态文件，已停止启动以保留会话');
  const save = () => {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return { data, save };
}

export function lockProcess(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'bridge.lock');
  try { fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('锁文件异常，请检查 bridge.lock');
    let live = true;
    try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') live = false; else throw err; }
    if (live) throw new Error(`桥接服务已在运行（PID ${pid}）`);
    fs.unlinkSync(file);
    fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  return () => { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); };
}

export class SerialQueue {
  queues = new Map();
  run(key, fn) {
    const p = (this.queues.get(key) || Promise.resolve()).then(fn);
    const safe = p.catch(() => {});
    this.queues.set(key, safe);
    safe.finally(() => { if (this.queues.get(key) === safe) this.queues.delete(key); });
    return p;
  }
}

// Persist BEFORE sending. An uncertain outcome is never automatically replayed.
export async function once(state, id, fn) {
  if (state.data.receipts[id]) return { duplicate: true, receipt: state.data.receipts[id] };
  const receipt = state.data.receipts[id] = { status: 'pending', at: Date.now() };
  state.save();
  try {
    const result = await fn();
    Object.assign(receipt, { status: 'accepted', result });
    state.save();
    return result;
  } catch (e) {
    receipt.status = 'uncertain';
    state.save();
    throw e;
  }
}
