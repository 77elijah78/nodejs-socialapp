import { isIP } from 'node:net';
import path from 'node:path';

export const uploadsRoot = path.resolve(process.env.UPLOADS_PATH ?? 'uploads');

const UPLOAD_KEY_PATTERN = /^(images|videos|audio)\/[a-zA-Z0-9_-]+\.[a-z0-9]+$/;
// Local-only naming conventions. Reserved documentation TLDs are not blocked
// here: they are not resolvable as private hosts, and tests/staging commonly use
// them for a "different public origin" rehearsal.
const PRIVATE_HOST_SUFFIXES = [
  '.localhost', '.local', '.internal', '.home', '.lan', '.intranet', '.corp',
  '.private', '.home.arpa',
];

function rawPathOf(value: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(value);
  return match?.[1] ?? null;
}

function safeRawPath(value: string): string | null {
  const rawPath = rawPathOf(value);
  if (rawPath === null || /\\|%2f|%5c/i.test(rawPath)) return null;
  const segments = rawPath.split('/');
  for (let index = 0; index < segments.length; index++) {
    const rawSegment = segments[index]!;
    if (!rawSegment && index !== 0 && index !== segments.length - 1) return null;
    let decoded = rawSegment;
    try {
      // Catch double-encoded separators and dot segments too. Upload keys are
      // ASCII, while genuine external paths may still use safe percent escapes.
      for (let pass = 0; pass < 4; pass++) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
        if (/[\\/]/.test(decoded)) return null;
      }
    } catch {
      return null;
    }
    if (decoded === '.' || decoded === '..') return null;
  }
  return rawPath;
}

function ipv4InCidr(address: number[], network: number[], prefix: number): boolean {
  const wholeBytes = Math.floor(prefix / 8);
  for (let i = 0; i < wholeBytes; i++) if (address[i] !== network[i]) return false;
  const remainingBits = prefix % 8;
  if (!remainingBits) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((address[wholeBytes]! ^ network[wholeBytes]!) & mask) === 0;
}

// Never valid as a device-reachable media origin, in any environment.
const ALWAYS_BLOCKED_IPV4: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8], [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16], [[224, 0, 0, 0], 4],
];
// Private/reserved ranges. Rejected in production; a LAN origin (RFC1918) is the
// documented way to exercise uploads from a physical device during development.
const PRIVATE_IPV4: Array<[number[], number]> = [
  [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24], [[240, 0, 0, 0], 4],
];

function isAllowedIpv4(host: string, production: boolean): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (ALWAYS_BLOCKED_IPV4.some(([network, prefix]) => ipv4InCidr(parts, network, prefix))) return false;
  return production ? !PRIVATE_IPV4.some(([network, prefix]) => ipv4InCidr(parts, network, prefix)) : true;
}

function ipv6Groups(address: string): number[] | null {
  let normalized = address.toLowerCase();
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized);
  if (dotted) {
    const bytes = dotted[1]!.split('.').map(Number);
    if (bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
    const first = ((bytes[0]! << 8) | bytes[1]!).toString(16);
    const second = ((bytes[2]! << 8) | bytes[3]!).toString(16);
    const prefix = normalized.slice(0, dotted.index);
    normalized = `${prefix}${prefix.endsWith(':') ? '' : ':'}${first}:${second}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0]!.split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(':') : [];
  const zeroCount = 8 - left.length - right.length;
  if ((halves.length === 1 && zeroCount !== 0) || (halves.length === 2 && zeroCount < 1)) return null;
  const groups = [...left, ...Array(halves.length === 2 ? zeroCount : 0).fill('0'), ...right]
    .map(part => /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : NaN);
  return groups.length === 8 && groups.every(Number.isFinite) ? groups : null;
}

function isAllowedHost(hostname: string, production: boolean): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const family = isIP(host);
  if (family === 4) return isAllowedIpv4(host, production);
  if (family === 6) {
    const groups = ipv6Groups(host);
    if (!groups) return false;
    const first = groups[0]!;
    // Loopback, unspecified and link-local are never device-reachable media origins.
    if (groups.every(group => group === 0) || groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return false;
    if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return false;
    if (!production) return true;
    // Production: only global-unicast space, excluding IETF special-purpose,
    // documentation, and 6to4 ranges within that broader allocation.
    if (first < 0x2000 || first > 0x3fff) return false;
    if (first === 0x2001 && (groups[1]! <= 0x01ff || groups[1] === 0x0db8)) return false;
    if (first === 0x2002) return false;
    return true;
  }
  if (!host.includes('.') || host.length > 253 || host.startsWith('.') || host.includes('..')) return false;
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  if (PRIVATE_HOST_SUFFIXES.some(suffix => host === suffix.slice(1) || host.endsWith(suffix))) return false;
  return host.split('.').every(label => label.length > 0 && label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

function parseSharedUrl(value: string): URL | null {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\u0000-\u0020\u007f]/.test(value)) return null;
  if (safeRawPath(value) === null) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (!isAllowedHost(url.hostname, process.env.NODE_ENV === 'production')) return null;
    return url;
  } catch {
    return null;
  }
}

export function mediaBaseUrl(): string {
  const configured = process.env.PUBLIC_MEDIA_BASE_URL ?? process.env.BASE_URL;
  if (!configured) throw new Error('PUBLIC_MEDIA_BASE_URL is required for publicly fetchable media');
  const url = parseSharedUrl(configured);
  if (!url || url.search || url.hash) throw new Error('Invalid public media URL');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('Production media requires a public HTTPS origin');
  }
  // BASE_URL is the legacy API origin; PUBLIC_MEDIA_BASE_URL includes /uploads.
  return process.env.PUBLIC_MEDIA_BASE_URL ? url.href.replace(/\/$/, '') : `${url.origin}/uploads`;
}

export function isSharedMediaUrl(value: string): boolean {
  const url = parseSharedUrl(value);
  return !!url && (process.env.NODE_ENV !== 'production' || url.protocol === 'https:');
}

export function extractUploadMediaKey(value: string): string | null {
  if (!isSharedMediaUrl(value)) return null;
  const rawPath = safeRawPath(value);
  if (rawPath === null) return null;
  const parts = rawPath.split('/');
  const folder = parts.at(-2);
  const filename = parts.at(-1);
  if (!folder || !filename || !/^(images|videos|audio)$/.test(folder) || !/^[a-zA-Z0-9_-]+\.[a-z0-9]+$/.test(filename)) return null;
  // Generated upload keys are unescaped ASCII path segments.
  if (folder.includes('%') || filename.includes('%')) return null;
  const key = `${folder}/${filename}`;
  return UPLOAD_KEY_PATTERN.test(key) ? key : null;
}

export function canonicalUploadUrl(key: string): string {
  if (!UPLOAD_KEY_PATTERN.test(key)) throw new Error('Invalid owned media key');
  return `${mediaBaseUrl()}/${key}`;
}

export function isKnownOwnedUploadUrl(value: string, key: string, storedUrl?: string | null): boolean {
  if (extractUploadMediaKey(value) !== key) return false;
  const url = parseSharedUrl(value);
  if (!url) return false;
  const known = [canonicalUploadUrl(key), ...(storedUrl ? [storedUrl] : [])];
  return known.some(reference => {
    const parsed = parseSharedUrl(reference);
    return !!parsed && parsed.origin === url.origin && parsed.pathname === url.pathname;
  });
}
