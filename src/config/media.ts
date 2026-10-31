import path from 'node:path';
export const uploadsRoot = path.resolve(process.env.UPLOADS_PATH ?? 'uploads');
export function mediaBaseUrl(): string {
  const configured = process.env.PUBLIC_MEDIA_BASE_URL ?? process.env.BASE_URL;
  if (!configured && process.env.NODE_ENV === 'production') throw new Error('PUBLIC_MEDIA_BASE_URL is required');
  const url = new URL(configured ?? 'http://localhost:3000/uploads');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid public media URL');
  if (process.env.NODE_ENV === 'production' && (url.protocol !== 'https:' || !url.hostname.includes('.') || /^(localhost|127\.|0\.|\[?::1)/i.test(url.hostname) || url.hostname.endsWith('.local'))) throw new Error('Production media requires a public HTTPS origin');
  // BASE_URL is the legacy API origin; PUBLIC_MEDIA_BASE_URL includes /uploads.
  return process.env.PUBLIC_MEDIA_BASE_URL ? url.href.replace(/\/$/, '') : `${url.origin}/uploads`;
}
export function isSharedMediaUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (process.env.NODE_ENV === 'production' ? u.protocol === 'https:' : ['http:', 'https:'].includes(u.protocol)) && !u.username && !u.password && !/^(localhost$|127\.|0\.|\[?::1|169\.254\.)/i.test(u.hostname) && !u.hostname.endsWith('.localhost') && !u.hostname.endsWith('.local') && u.hostname.includes('.');
  } catch { return false; }
}
