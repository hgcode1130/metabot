export type GroupMessageAction = 'process' | 'cache_media' | 'ignore';

export type GroupMessageReason =
  | 'not_group'
  | 'mentioned'
  | 'group_no_mention'
  | 'private_like'
  | 'unmentioned_media'
  | 'not_mentioned';

export interface GroupMessageDecision {
  action: GroupMessageAction;
  reason: GroupMessageReason;
}

export interface GroupMessagePolicyInput {
  chatType: string | undefined;
  msgType: string;
  mentions: readonly unknown[] | undefined;
  botOpenId: string | undefined;
  groupNoMention: boolean | undefined;
  isPrivateLikeGroup?: () => Promise<boolean>;
}

export async function decideGroupMessageHandling(input: GroupMessagePolicyInput): Promise<GroupMessageDecision> {
  if (input.chatType !== 'group') return { action: 'process', reason: 'not_group' };
  if (isBotMentioned(input.mentions, input.botOpenId)) return { action: 'process', reason: 'mentioned' };
  if (input.groupNoMention) return { action: 'process', reason: 'group_no_mention' };
  if (input.isPrivateLikeGroup && (await input.isPrivateLikeGroup())) {
    return { action: 'process', reason: 'private_like' };
  }
  if (isCacheableMediaType(input.msgType)) return { action: 'cache_media', reason: 'unmentioned_media' };
  return { action: 'ignore', reason: 'not_mentioned' };
}

export function isBotMentioned(mentions: readonly unknown[] | undefined, botOpenId: string | undefined): boolean {
  if (!mentions?.length) return false;
  if (!botOpenId) return true;
  return mentions.some((mention) => getMentionOpenId(mention) === botOpenId);
}

function isCacheableMediaType(msgType: string): boolean {
  return msgType === 'image' || msgType === 'file';
}

function getMentionOpenId(mention: unknown): string | undefined {
  if (!mention || typeof mention !== 'object') return undefined;
  const id = (mention as { id?: unknown }).id;
  if (!id || typeof id !== 'object') return undefined;
  return (id as { open_id?: unknown }).open_id as string | undefined;
}
