import crypto from 'node:crypto';
import path from 'node:path';
import { sessionCard } from './ui.mjs';

// Persist each provisioning step separately; failed invitations must not create extra channels.
export async function provisionChannel({ state, slack, config }, session) {
  const pending = state.data.channelProvisioning ||= {};
  const key = session.id;
  const slug = path.basename(session.path).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 35) || 'session';
  const job = pending[key] ||= { name: `orca-${slug}-${crypto.randomBytes(6).toString('hex')}` };
  state.save();
  if (!job.channel) {
    try {
      const result = await slack.conversations.create({ name: job.name, is_private: true });
      job.channel = result.channel.id;
    } catch (e) {
      if (e.data?.error === 'missing_scope') throw new Error('独立聊天需要 groups:write 权限。请在 Slack 应用 OAuth & Permissions 添加该 Bot Token Scope，再 Reinstall to Workspace。');
      if (e.data?.error !== 'name_taken') throw e;
      // Recover a create whose response was lost. Only accept our persisted random private name.
      let cursor;
      do {
        const result = await slack.conversations.list({ types: 'private_channel', limit: 200, exclude_archived: true, ...(cursor ? { cursor } : {}) });
        const found = result.channels.find(c => c.name === job.name && c.is_private && c.is_member);
        if (found) { job.channel = found.id; break; }
        cursor = result.response_metadata?.next_cursor;
      } while (cursor);
      if (!job.channel) throw new Error('频道创建结果待确认，请检查 Slack 后重试。');
    }
    state.save();
  }
  if (!job.invited) {
    try { await slack.conversations.invite({ channel: job.channel, users: config.ownerId }); }
    catch (e) { if (e.data?.error !== 'already_in_channel') throw e; }
    job.invited = true; state.save();
  }
  const dedicated = { ...session, channel: job.channel, layout: 'channel' };
  if (!job.thread) {
    // Recovery after a post timeout/crash: find our control card before posting another.
    if (job.postStarted) {
      const history = await slack.conversations.history({ channel: job.channel, limit: 100 });
      const card = history.messages?.find(m => m.blocks?.some(b => b.elements?.some(el => el.action_id === 'prompt' && el.value === session.id)));
      if (card) job.thread = card.ts;
      else throw new Error('频道已建立，但会话卡片发送结果待确认；请稍后重试。');
    } else {
      job.postStarted = true; state.save();
      try {
        const message = await slack.chat.postMessage({ channel: job.channel, text: session.title || 'Claude 会话', blocks: sessionCard(dedicated), unfurl_links: false, unfurl_media: false });
        job.thread = message.ts;
      } catch (e) {
        // Slack's explicit rejection means nothing was sent; transport failures remain uncertain.
        if (e.data?.ok === false) { job.postStarted = false; state.save(); }
        throw e;
      }
    }
    state.save();
  }
  return { ...dedicated, thread: job.thread };
}
