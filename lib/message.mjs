// 飞书消息 → 发给模型的文字：合并转发展开、卡片转文字、图片和文件下载到本地换成路径
import fs from 'node:fs';
import path from 'node:path';
import { normalize } from '@larksuite/channel';

const EXT = { image: '.png', audio: '.opus', video: '.mp4', sticker: '.png' };

// 转发 / 附件，不带自己打的字：先等一句再发
export const isPassive = (type) => ['merge_forward', 'image', 'file', 'interactive', 'media', 'audio', 'sticker', 'share_chat', 'share_user'].includes(type);

const names = new Map(); // open_id → 姓名（转发里显示谁说的）
async function resolveNames(f, ids) {
  for (const id of ids) {
    if (names.has(id) || !id.startsWith('ou_')) continue;
    try { const r = await f.api('GET', '/contact/v3/users/batch', { query: { user_id_type: 'open_id', user_ids: id } }); names.set(id, r.items?.[0]?.name || id); } catch { names.set(id, id); }
  }
}

export async function toPrompt(f, messageId, mediaDir) {
  const items = await f.getMessage(messageId);
  const msg = items.find((x) => x.message_id === messageId) || items[0];
  if (!msg) throw new Error(`取不到消息 ${messageId}`);
  const ev = {
    message: { message_id: msg.message_id, chat_id: msg.chat_id, chat_type: 'group', message_type: msg.msg_type, content: msg.body?.content || '', create_time: msg.create_time, parent_id: msg.parent_id, root_id: msg.root_id,
      mentions: (msg.mentions || []).map((m) => ({ key: m.key, name: m.name, id: { open_id: m.id } })) },
    sender: { sender_id: { open_id: msg.sender?.id }, sender_type: msg.sender?.sender_type },
  };
  const n = await normalize(ev, {
    fetchSubMessages: async (mid) => (mid === messageId ? items : f.getMessage(mid)),
    batchResolveNames: (ids) => resolveNames(f, ids),
    resolveUserName: (id) => names.get(id),
    stripBotMentions: true,
  });
  let text = n.content;
  fs.mkdirSync(mediaDir, { recursive: true });
  for (const r of n.resources) {
    if (r.type === 'sticker') continue;
    const file = path.join(mediaDir, `${r.fileKey.slice(-16)}${r.fileName ? `-${r.fileName.replace(/[/\\]/g, '_')}` : EXT[r.type] || ''}`);
    let local = file;
    try {
      // 合并转发里的图片、文件也要用收到的这条（外层）消息 id 下载，用子消息 id 会报 234003
      if (!fs.existsSync(file)) fs.writeFileSync(file, await f.download(messageId, r.fileKey, r.type === 'image' ? 'image' : 'file'));
    } catch (e) { local = `（下载失败：${e.message.slice(0, 80)}）`; }
    const label = { image: '图片', file: '文件', audio: '语音', video: '视频' }[r.type] || r.type;
    text = text.split(`![image](${r.fileKey})`).join(`[${label}: ${local}]`)
      .replace(new RegExp(`<(file|audio|video|media)[^>]*key="${r.fileKey}"[^>]*/>`, 'g'), `[${label}: ${local}]`);
  }
  return { text: text.replace(/<sticker key="[^"]*"\/>/g, '[表情]').trim(), type: msg.msg_type };
}
