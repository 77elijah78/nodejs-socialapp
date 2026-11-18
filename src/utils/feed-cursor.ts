import { z } from 'zod';
import { ValidationError } from './errors.js';
export function encodeFeedCursor(at: Date, id: string) { return Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString('base64url'); }
export function decodeFeedCursor(cursor?: string) {
  if (!cursor) return undefined;
  try { return z.object({ at: z.string().datetime(), id: z.string().uuid() }).strict().parse(JSON.parse(Buffer.from(z.string().max(300).parse(cursor), 'base64url').toString())); }
  catch { throw new ValidationError('Invalid cursor'); }
}
