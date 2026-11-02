import type { Prisma } from '@prisma/client';
export const messageInclude = {
  sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
  repliedTo: { include: { sender: { select: { id: true, username: true, displayName: true, avatarUrl: true } } } },
} satisfies Prisma.MessageInclude;
export function serializeMessage<T extends { deletedAt?: Date | string | null; repliedTo?: unknown }>(message: T): T {
  const result = { ...message };
  if (result.deletedAt) Object.assign(result, { content: '', mediaUrl: null, thumbnailUrl: null,
    duration: null, fileName: null, fileMimeType: null, fileSize: null, sharedReference: null });
  if (result.repliedTo) result.repliedTo = serializeMessage(result.repliedTo as T);
  return result;
}
