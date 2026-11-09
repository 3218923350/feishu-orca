// 收事件：lark-cli event consume（机器人身份），一个 EventKey 一个子进程，断了退避重连
import { spawn } from 'node:child_process';

export function consume(lark, key, onEvent, log, env = process.env) {
  let delay = 5000, child = null, stopped = false;
  const start = () => {
    if (stopped) return;
    child = spawn(lark, ['event', 'consume', key, '--as', 'bot'], { env, stdio: ['pipe', 'pipe', 'pipe'] }); // stdin 不关：关了它就退出
    let buf = '', errTail = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        Promise.resolve(onEvent(ev)).catch((e) => log('ERR', key, e.stack || e.message));
      }
    });
    child.stderr.on('data', (d) => {
      errTail = (errTail + d).slice(-2000);
      if (/\[event\] ready/.test(String(d))) { delay = 5000; log('ready', key); }
    });
    child.on('close', (code) => {
      if (stopped) return;
      log('consume-exit', key, code, errTail.replace(/\s+/g, ' ').slice(-300));
      setTimeout(start, delay); delay = Math.min(delay * 2, 300_000);
    });
  };
  start();
  return { stop() { stopped = true; child?.kill('SIGTERM'); } };
}
