import { randomUUID } from 'node:crypto';
import { deliveryRedis } from '../config/redis.js';

const seenKey = (messageId: string, userId: string) => `message:emitted:${messageId}:${userId}`;
class MessageEmissionBusy extends Error {}
export async function emitMessageOnce(messageId: string, userId: string, emit: () => void) {
  const done = seenKey(messageId, userId);
  const lock = `${done}:lock`;
  const token = randomUUID();
  try {
    if (await deliveryRedis.get(done) === '1') return;
    const acquired = await deliveryRedis.set(lock, token, 'EX', 30, 'NX');
    if (!acquired) throw new MessageEmissionBusy('Message emission in progress; retry event');
  } catch (error) {
    if (error instanceof MessageEmissionBusy) throw error;
    emit(); // Redis outage: do not block real-time messaging; clients still upsert IDs.
    return;
  }
  try {
    let emitted = false;
    try { emitted = await deliveryRedis.get(done) === '1'; } catch { /* fail open */ }
    if (!emitted) {
      emit();
      try { await deliveryRedis.set(done, '1', 'EX', 86400); } catch { /* Stable IDs remain the final dedup layer. */ }
    }
  } finally {
    try { await deliveryRedis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, lock, token); }
    catch { /* Claim expires automatically; Kafka can retry. */ }
  }
}
export async function isDeviceViewing(deviceId: string, conversationId: string) {
  try {
    const value = await deliveryRedis.get(`push:view:${deviceId}`);
    return !!value && JSON.parse(value).conversationId === conversationId;
  } catch { return false; }
}
export async function setDeviceView(deviceId: string, socketId: string, conversationId: string) {
  await deliveryRedis.set(`push:view:${deviceId}`, JSON.stringify({ socketId, conversationId }), 'EX', 45);
}
export async function clearDeviceView(deviceId: string, socketId: string) {
  const key = `push:view:${deviceId}`;
  const value = await deliveryRedis.get(key);
  if (value && JSON.parse(value).socketId === socketId) {
    await deliveryRedis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, key, value);
  }
}
