// 飞书开放平台 REST：机器人身份（tenant_access_token），只用 fetch
const BASE = 'https://open.feishu.cn/open-apis';

export function feishu({ appId, secret }) {
  let token = '', expires = 0;
  async function tenantToken() {
    if (token && Date.now() < expires) return token;
    const r = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app_id: appId, app_secret: secret }),
    }).then((x) => x.json());
    if (r.code) throw new Error(`token: ${r.code} ${r.msg}`);
    token = r.tenant_access_token; expires = Date.now() + (r.expire - 300) * 1000;
    return token;
  }

  async function api(method, path, { body, query, raw = false, retry = 2 } = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, v);
    for (let i = 0; ; i++) {
      let res;
      try {
        res = await fetch(url, {
          method, signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${await tenantToken()}`, ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) { if (i < retry) { await sleep(1000 * (i + 1)); continue; } throw e; }
      if (raw && res.ok) return Buffer.from(await res.arrayBuffer());
      const j = await res.json().catch(() => ({ code: res.status, msg: res.statusText }));
      if (j.code === 99991663 || j.code === 99991661) { token = ''; if (i < retry) continue; } // token 失效
      if ((res.status === 429 || j.code === 99991400 || j.code === 230020) && i < retry) { await sleep(1500 * (i + 1)); continue; } // 限流
      if (j.code) { const e = new Error(`${method} ${path}: ${j.code} ${j.msg}`); e.code = j.code; throw e; }
      return j.data ?? {};
    }
  }

  const send = (chatId, msgType, content) => api('POST', '/im/v1/messages', { query: { receive_id_type: 'chat_id' }, body: { receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) } }).then((d) => d.message_id);
  const reply = (messageId, msgType, content, { inThread = false } = {}) => api('POST', `/im/v1/messages/${messageId}/reply`, { body: { msg_type: msgType, content: JSON.stringify(content), reply_in_thread: inThread } }).then((d) => d.message_id);

  return {
    api,
    sendCard: (chatId, card) => send(chatId, 'interactive', card),
    replyCard: (messageId, card) => reply(messageId, 'interactive', card),
    patchCard: (messageId, card) => api('PATCH', `/im/v1/messages/${messageId}`, { body: { content: JSON.stringify(card) } }),
    sendText: (chatId, text) => send(chatId, 'text', { text }),
    // CardKit 卡片实体：建一次，之后按 card_id 整卡更新（sequence 要递增）
    createCard: (card) => api('POST', '/cardkit/v1/cards', { body: { type: 'card_json', data: JSON.stringify(card) } }).then((d) => d.card_id),
    updateCard: (cardId, card, sequence) => api('PUT', `/cardkit/v1/cards/${cardId}`, { body: { card: { type: 'card_json', data: JSON.stringify(card) }, sequence, uuid: `u_${cardId}_${sequence}` } }),
    sendCardId: (chatId, cardId) => send(chatId, 'interactive', { type: 'card', data: { card_id: cardId } }),
    replyCardId: (messageId, cardId) => reply(messageId, 'interactive', { type: 'card', data: { card_id: cardId } }),
    getMessage: (messageId) => api('GET', `/im/v1/messages/${messageId}`, { query: { card_msg_content_type: 'raw_card_content' } }).then((d) => d.items || []),
    download: (messageId, fileKey, type) => api('GET', `/im/v1/messages/${messageId}/resources/${fileKey}`, { query: { type }, raw: true }),
    react: (messageId, emoji) => api('POST', `/im/v1/messages/${messageId}/reactions`, { body: { reaction_type: { emoji_type: emoji } } }).then((d) => d.reaction_id),
    unreact: (messageId, reactionId) => api('DELETE', `/im/v1/messages/${messageId}/reactions/${reactionId}`),
    pin: (messageId) => api('POST', '/im/v1/pins', { body: { message_id: messageId } }),
    createChat: ({ name, description, users, owner }) => api('POST', '/im/v1/chats', {
      query: { user_id_type: 'open_id', set_bot_manager: true },
      body: { name, description, user_id_list: users, owner_id: owner, chat_mode: 'group', chat_type: 'private' },
    }).then((d) => d.chat_id),
    updateChat: (chatId, patch) => api('PUT', `/im/v1/chats/${chatId}`, { body: patch }),
    dissolveChat: (chatId) => api('DELETE', `/im/v1/chats/${chatId}`),
    getChat: (chatId) => api('GET', `/im/v1/chats/${chatId}`),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
