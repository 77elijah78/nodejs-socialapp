import { z } from 'zod';

export class PushProviderError extends Error {
  constructor(public code: string, public retryable = false, public ambiguous = false) { super(code); }
}
const responseItem = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), id: z.string().optional() }),
  z.object({ status: z.literal('error'), details: z.object({ error: z.string().max(100) }).optional() }),
]);
export type MessagePushData = {
  contractVersion: 2; notificationType: 'MESSAGE';
  messageId: string; conversationId: string; conversationType: 'private' | 'group'; senderId: string;
  notificationId: string; recipientUserId: string; deviceId: string;
  groupKey: string; categoryIdentifier: 'MESSAGE_REPLY_V2';
};
export type ExpoPushPayload = {
  to: string; priority: 'high'; ttl: number;
} & ({
  title: string; body: string; sound: 'default'; channelId: 'messages';
  data: MessagePushData & { deliveryMode: 'expo-alert' };
} | {
  // No top-level display fields: the frontend must render exactly once.
  _contentAvailable: true;
  data: MessagePushData & { deliveryMode: 'android-data-v2';
    display: { title: string; body: string; channelId: 'messages' } };
});
async function request(path: 'send' | 'getReceipts', body: object) {
  let response: Response;
  try {
    response = await fetch(`https://exp.host/--/api/v2/push/${path}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json',
        ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
      }, body: JSON.stringify(body),
    });
  } catch { throw new PushProviderError('TransportUncertain', false, true); }
  if (response.status === 429) throw new PushProviderError('RateLimited', true);
  // A 5xx may occur after acceptance: avoid automatic duplicate sends.
  if (response.status >= 500) throw new PushProviderError('ProviderUncertain', false, true);
  if (!response.ok) throw new PushProviderError(response.status === 401 || response.status === 403 ? 'InvalidCredentials' : 'ProviderRejected');
  try { return await response.json(); } catch { throw new PushProviderError('InvalidProviderResponse', false, true); }
}
export async function sendExpoPush(payload: ExpoPushPayload) {
  const response = z.object({ data: responseItem }).safeParse(await request('send', payload));
  if (!response.success) throw new PushProviderError('InvalidProviderResponse', false, true);
  const item = response.data.data;
  if (item.status === 'error') throw new PushProviderError(item.details?.error ?? 'ProviderRejected', item.details?.error === 'MessageRateExceeded');
  if (!item.id) throw new PushProviderError('MissingTicket', false, true);
  return item.id;
}
export async function getExpoReceipt(ticketId: string) {
  const response = z.object({ data: z.record(responseItem) }).safeParse(await request('getReceipts', { ids: [ticketId] }));
  if (!response.success) throw new PushProviderError('InvalidReceiptResponse', true);
  return response.data.data[ticketId] ?? null;
}
