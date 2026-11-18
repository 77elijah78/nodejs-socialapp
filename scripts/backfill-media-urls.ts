/**
 * Idempotent backfill: rewrite stored owned-upload URLs to the deployment's
 * canonical PUBLIC_MEDIA_BASE_URL origin, so authorization no longer depends on
 * whichever origin (reverse proxy, LAN address, old port) a client uploaded from.
 *
 * Only paths shaped like /uploads/(images|videos|audio)/<safe-filename> are
 * rewritten. Genuinely external CDN URLs — including signed URLs with queries —
 * are left untouched. Re-running this script is a no-op.
 *
 *   npm run db:backfill:media-urls -- --dry-run
 */
import { PrismaClient } from '@prisma/client';
import { canonicalUploadUrl, mediaBaseUrl } from '../src/config/media.js';

const prisma = new PrismaClient();
const dryRun = process.argv.includes('--dry-run');
const KEYED_UPLOAD_PATH = /\/uploads\/((?:images|videos|audio)\/[a-zA-Z0-9_-]+\.[a-z0-9]+)(?=$|[?#])/;

function rewrite(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return value;
    const match = KEYED_UPLOAD_PATH.exec(url.pathname);
    if (!match) return value;
    const canonical = canonicalUploadUrl(match[1]!);
    // A query/hash on an owned upload is not a signature we must preserve; the
    // canonical reference is the bare path so lookups match exactly.
    return canonical === value ? value : canonical;
  } catch {
    return value;
  }
}

async function main() {
  const base = mediaBaseUrl();
  console.log(`Canonical media base: ${base}${dryRun ? ' (dry run)' : ''}`);

  const users = await prisma.user.findMany({ where: { avatarUrl: { not: null } }, select: { id: true, avatarUrl: true } });
  const posts = await prisma.post.findMany({ select: { id: true, imageUrls: true, videoUrl: true, mediaMetadata: true } });
  const conversations = await prisma.conversation.findMany({ where: { groupAvatar: { not: null } }, select: { id: true, groupAvatar: true } });
  const stories = await prisma.story.findMany({ select: { id: true, mediaUrl: true } });

  let changes = 0;

  for (const user of users) {
    const next = rewrite(user.avatarUrl);
    if (next === user.avatarUrl) continue;
    changes++;
    if (!dryRun) await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: next } });
  }

  for (const post of posts) {
    const imageUrls = post.imageUrls.map(url => rewrite(url)!);
    const videoUrl = rewrite(post.videoUrl);
    const metadata = Array.isArray(post.mediaMetadata)
      ? post.mediaMetadata.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        const record = { ...(item as Record<string, unknown>) };
        for (const key of ['url', 'thumbnailUrl']) {
          if (typeof record[key] === 'string') record[key] = rewrite(record[key] as string);
        }
        return record;
      })
      : post.mediaMetadata;
    const imagesChanged = imageUrls.some((url, index) => url !== post.imageUrls[index]);
    const metadataChanged = JSON.stringify(metadata) !== JSON.stringify(post.mediaMetadata);
    if (!imagesChanged && videoUrl === post.videoUrl && !metadataChanged) continue;
    changes++;
    if (!dryRun) await prisma.post.update({ where: { id: post.id }, data: {
      imageUrls, videoUrl, ...(metadataChanged ? { mediaMetadata: metadata as never } : {}),
    } });
  }

  for (const conversation of conversations) {
    const next = rewrite(conversation.groupAvatar);
    if (next === conversation.groupAvatar) continue;
    changes++;
    if (!dryRun) await prisma.conversation.update({ where: { id: conversation.id }, data: { groupAvatar: next ?? null } });
  }

  for (const story of stories) {
    const next = rewrite(story.mediaUrl);
    if (next === story.mediaUrl) continue;
    changes++;
    if (!dryRun) await prisma.story.update({ where: { id: story.id }, data: { mediaUrl: next! } });
  }

  console.log(`${dryRun ? 'Would rewrite' : 'Rewrote'} ${changes} stored media reference(s).`);
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
