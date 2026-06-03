import { describe, expect, it, vi } from 'vitest';
import { isPrivateLikeGroup } from '../src/feishu/event-handler.js';

describe('isPrivateLikeGroup', () => {
  it('returns true when Feishu reports exactly two members', async () => {
    const sender = { getChatMemberCount: vi.fn(async () => 2) };

    await expect(isPrivateLikeGroup('oc_two_members', sender)).resolves.toBe(true);
  });

  it('returns false for larger groups', async () => {
    const sender = { getChatMemberCount: vi.fn(async () => 3) };

    await expect(isPrivateLikeGroup('oc_three_members', sender)).resolves.toBe(false);
  });

  it('returns false when member count cannot be read', async () => {
    const sender = { getChatMemberCount: vi.fn(async () => undefined) };

    await expect(isPrivateLikeGroup('oc_unknown_members', sender)).resolves.toBe(false);
  });

  it('caches member counts briefly to avoid repeated Feishu API calls', async () => {
    const sender = { getChatMemberCount: vi.fn(async () => 2) };

    await expect(isPrivateLikeGroup('oc_cached_two_members', sender)).resolves.toBe(true);
    await expect(isPrivateLikeGroup('oc_cached_two_members', sender)).resolves.toBe(true);

    expect(sender.getChatMemberCount).toHaveBeenCalledOnce();
  });
});
