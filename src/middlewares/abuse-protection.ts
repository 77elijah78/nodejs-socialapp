import { createHash, createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { deliveryRedis } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { AuthRequest } from '../types/index.js';
import { AppError, ServiceUnavailableError } from '../utils/errors.js';

export type AbuseCategory = 'auth' | 'messages' | 'media' | 'stickers' | 'social' | 'explore' | 'push';

const RATE_LIMIT_LUA = `
local ip_cooldown = tonumber(redis.call('PTTL', KEYS[3]))
local user_cooldown = tonumber(redis.call('PTTL', KEYS[4]))
if ip_cooldown > 0 or user_cooldown > 0 then
  return {1, math.max(ip_cooldown, user_cooldown), 0, 0}
end
local ip_count = redis.call('INCR', KEYS[1])
if ip_count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
local ip_ttl = tonumber(redis.call('PTTL', KEYS[1]))
local user_count = 0
local user_ttl = 0
if tonumber(ARGV[2]) > 0 then
  user_count = redis.call('INCR', KEYS[2])
  if user_count == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
  user_ttl = tonumber(redis.call('PTTL', KEYS[2]))
end
local retry = 0
if ip_count > tonumber(ARGV[1]) then
  redis.call('SET', KEYS[3], '1', 'PX', ARGV[4], 'NX')
  retry = math.max(retry, tonumber(redis.call('PTTL', KEYS[3])))
end
if tonumber(ARGV[2]) > 0 and user_count > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[4], '1', 'PX', ARGV[4], 'NX')
  retry = math.max(retry, tonumber(redis.call('PTTL', KEYS[4])))
end
if retry > 0 then return {1, retry, ip_count, user_count} end
return {0, math.max(ip_ttl, user_ttl), ip_count, user_count}
`;

const RELEASE_IDEMPOTENCY_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  if ARGV[2] == '' then return redis.call('DEL', KEYS[1]) end
  return redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
end
return 0
`;

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function hash(value: string): string {
  const secret = process.env.ABUSE_HASH_SECRET?.trim() || process.env.JWT_SECRET || 'abuse-key-rotation-required';
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function socketClientIp(remoteAddress: string | undefined, forwardedFor: string | string[] | undefined): string {
  const remote = remoteAddress && isIP(remoteAddress) ? remoteAddress : 'unknown';
  const trustedHops = integerSetting('TRUST_PROXY_HOPS', 0, 0, 10);
  if (!trustedHops) return remote;
  const forwarded = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor ?? '')
    .split(',').map(address => address.trim()).filter(Boolean);
  const candidate = forwarded[Math.max(0, forwarded.length - trustedHops)];
  return candidate && isIP(candidate) ? candidate : remote;
}

function getConfig(category: AbuseCategory) {
  const prefix = `ABUSE_${category.toUpperCase()}`;
  const defaults = {
    auth: { windowMs: 60_000, ipMax: 40, userMax: 15, cooldownMs: 60_000 },
    media: { windowMs: 60_000, ipMax: 40, userMax: 20, cooldownMs: 120_000 },
    messages: { windowMs: 60_000, ipMax: 300, userMax: 120, cooldownMs: 30_000 },
    stickers: { windowMs: 60_000, ipMax: 120, userMax: 60, cooldownMs: 30_000 },
    social: { windowMs: 60_000, ipMax: 180, userMax: 60, cooldownMs: 30_000 },
    explore: { windowMs: 60_000, ipMax: 60, userMax: 30, cooldownMs: 60_000 },
    push: { windowMs: 60_000, ipMax: 60, userMax: 30, cooldownMs: 60_000 },
  }[category];
  return {
    windowMs: integerSetting(`${prefix}_WINDOW_MS`, defaults.windowMs, 1000, 3_600_000),
    ipMax: integerSetting(`${prefix}_IP_MAX`, defaults.ipMax, 1, 1_000_000),
    userMax: integerSetting(`${prefix}_USER_MAX`, defaults.userMax, 1, 1_000_000),
    cooldownMs: integerSetting(`${prefix}_COOLDOWN_MS`, defaults.cooldownMs, 1000, 86_400_000),
  };
}

type AbuseRedis = Pick<typeof deliveryRedis, 'eval'>;

export async function consumeAbuseLimit(category: AbuseCategory, userId: string | undefined, ip: string, redis: AbuseRedis = deliveryRedis): Promise<{ limited: boolean; retryAfter: number }> {
  const config = getConfig(category);
  const ipHash = hash(ip);
  const userHash = userId ? hash(userId) : 'anonymous';
  const keyPrefix = `abuse:v1:${category}`;
  try {
    const result = await redis.eval(
      RATE_LIMIT_LUA,
      4,
      `${keyPrefix}:ip:${ipHash}:count`,
      `${keyPrefix}:user:${userHash}:count`,
      `${keyPrefix}:ip:${ipHash}:cooldown`,
      `${keyPrefix}:user:${userHash}:cooldown`,
      String(config.ipMax),
      userId ? String(config.userMax) : '0',
      String(config.windowMs),
      String(config.cooldownMs),
    ) as unknown as Array<number | string>;
    const limited = Number(result?.[0]) === 1;
    const retryAfter = limited ? Math.max(1, Math.ceil(Number(result[1]) / 1000)) : 0;
    if (limited) logger.warn('Abuse limit triggered', { category, subjectHash: userId ? userHash.slice(0, 16) : ipHash.slice(0, 16) });
    return { limited, retryAfter };
  } catch {
    logger.error('Abuse protection unavailable', { category });
    throw new ServiceUnavailableError('Request protection is temporarily unavailable');
  }
}

export function createAbuseProtection(redis: AbuseRedis = deliveryRedis) {
  return (category: AbuseCategory) => async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = (req as AuthRequest).user?.userId;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    try {
      const result = await consumeAbuseLimit(category, userId, ip, redis);
      if (result.limited) {
        res.setHeader('Retry-After', String(result.retryAfter));
        res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
        return;
      }
      next();
    } catch (error) {
      res.setHeader('Retry-After', '1');
      next(error);
    }
  };
}
export const abuseProtection = createAbuseProtection();

export function createIdempotencyGuard(redis: Pick<typeof deliveryRedis, 'set' | 'eval'> = deliveryRedis) {
  return (options: { required?: boolean; ttlMs?: number; allowAnonymous?: boolean } = {}) => async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const keyHeader = req.get('Idempotency-Key');
    if (!keyHeader) {
      if (options.required) return next(new AppError('Idempotency-Key is required', 400));
      return next();
    }
    if (keyHeader.length < 16 || keyHeader.length > 128 || !/^[\x21-\x7e]+$/.test(keyHeader)) {
      return next(new AppError('Invalid Idempotency-Key', 400));
    }
    const userId = (req as AuthRequest).user?.userId;
    if (!userId && !options.allowAnonymous) return next(new AppError('Authentication is required for idempotent requests', 401));
    const scope = userId ? `user:${userId}` : `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;

    const requestHash = createHash('sha256').update(JSON.stringify([
      req.method, req.originalUrl, scope, req.body,
    ])).digest('hex');
    const claimToken = randomUUID();
    const redisKey = `abuse:v1:idempotency:${hash(scope)}:${hash(keyHeader)}`;
    const claim = `${requestHash}:processing:${claimToken}`;
    const ttlMs = Math.max(60_000, Math.min(options.ttlMs ?? 86_400_000, 7 * 86_400_000));
    try {
      const acquired = await redis.set(redisKey, claim, 'PX', ttlMs, 'NX');
      if (acquired !== 'OK') {
        res.status(409).json({ success: false, message: 'This request key has already been used' });
        return;
      }
    } catch {
      logger.error('Idempotency protection unavailable');
      res.setHeader('Retry-After', '1');
      next(new ServiceUnavailableError('Request protection is temporarily unavailable'));
      return;
    }

    res.once('finish', () => {
      const replacement = res.statusCode >= 200 && res.statusCode < 300 ? `${requestHash}:completed` : '';
      void redis.eval(RELEASE_IDEMPOTENCY_LUA, 1, redisKey, claim, replacement, String(ttlMs))
        .catch(() => logger.warn('Idempotency record could not be finalized'));
    });
    next();
  };
}

export const idempotencyGuard = createIdempotencyGuard();
