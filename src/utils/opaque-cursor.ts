import { z } from 'zod';
import { ValidationError } from './errors.js';

const cursorSchema = z.object({ t: z.string().datetime(), id: z.string().min(1).max(128) }).strict();

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id })).toString('base64url');
}

export function decodeCursor(value: string | undefined): { createdAt: Date; id: string } | undefined {
  if (!value) return undefined;
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new ValidationError('Invalid pagination cursor');
  try {
    const data = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return { createdAt: new Date(data.t), id: data.id };
  } catch {
    throw new ValidationError('Invalid pagination cursor');
  }
}

export function boundedLimit(value: unknown, fallback = 30, maximum = 100): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new ValidationError('Invalid pagination limit');
  return parsed;
}
