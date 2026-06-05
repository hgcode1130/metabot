import { describe, expect, it, vi } from 'vitest';
import { decideGroupMessageHandling, isBotMentioned } from '../src/feishu/group-message-policy.js';

describe('group message policy', () => {
  it('processes non-group messages directly', async () => {
    await expect(
      decideGroupMessageHandling({
        chatType: 'p2p',
        msgType: 'text',
        mentions: undefined,
        botOpenId: 'ou_bot',
        groupNoMention: false,
      }),
    ).resolves.toEqual({ action: 'process', reason: 'not_group' });
  });

  it('processes group messages that mention the bot', async () => {
    await expect(
      decideGroupMessageHandling({
        chatType: 'group',
        msgType: 'text',
        mentions: [{ id: { open_id: 'ou_bot' } }],
        botOpenId: 'ou_bot',
        groupNoMention: false,
      }),
    ).resolves.toEqual({ action: 'process', reason: 'mentioned' });
  });

  it('processes unmentioned group messages when groupNoMention is enabled', async () => {
    const isPrivateLike = vi.fn(async () => false);

    await expect(
      decideGroupMessageHandling({
        chatType: 'group',
        msgType: 'text',
        mentions: undefined,
        botOpenId: 'ou_bot',
        groupNoMention: true,
        isPrivateLikeGroup: isPrivateLike,
      }),
    ).resolves.toEqual({ action: 'process', reason: 'group_no_mention' });
    expect(isPrivateLike).not.toHaveBeenCalled();
  });

  it('processes unmentioned private-like groups', async () => {
    await expect(
      decideGroupMessageHandling({
        chatType: 'group',
        msgType: 'text',
        mentions: undefined,
        botOpenId: 'ou_bot',
        groupNoMention: false,
        isPrivateLikeGroup: async () => true,
      }),
    ).resolves.toEqual({ action: 'process', reason: 'private_like' });
  });

  it('caches unmentioned group media for a later mention', async () => {
    await expect(
      decideGroupMessageHandling({
        chatType: 'group',
        msgType: 'file',
        mentions: undefined,
        botOpenId: 'ou_bot',
        groupNoMention: false,
        isPrivateLikeGroup: async () => false,
      }),
    ).resolves.toEqual({ action: 'cache_media', reason: 'unmentioned_media' });
  });

  it('ignores unmentioned group text by default', async () => {
    await expect(
      decideGroupMessageHandling({
        chatType: 'group',
        msgType: 'text',
        mentions: undefined,
        botOpenId: 'ou_bot',
        groupNoMention: false,
        isPrivateLikeGroup: async () => false,
      }),
    ).resolves.toEqual({ action: 'ignore', reason: 'not_mentioned' });
  });

  it('treats any mention as a bot mention when bot open id is unavailable', () => {
    expect(isBotMentioned([{ id: { open_id: 'ou_someone' } }], undefined)).toBe(true);
  });
});
