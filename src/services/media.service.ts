import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../config/database.js';
import { mediaBaseUrl, uploadsRoot } from '../config/media.js';
import { getCategoryFromMime, MEDIA_TYPES, type MediaCategory } from '../middlewares/upload.js';
import { ValidationError } from '../utils/errors.js';

export interface MediaFile {
  url: string; thumbnailUrl?: string; category: MediaCategory; mimeType: string;
  size: number; filename: string; fileName: string; fileMimeType: string; fileSize: number;
  width?: number; height?: number; duration?: number;
}
export const buildUrl = (folder: string, filename: string) => `${mediaBaseUrl()}/${folder}/${filename}`;

// Inspect a bounded header rather than buffering a potentially 200MB video.
export async function validateFile(file: Express.Multer.File): Promise<void> {
  const category = getCategoryFromMime(file.mimetype);
  if (!category || file.size > MEDIA_TYPES[category].maxSize) throw new ValidationError('Unsupported or oversized media');
  const handle = await fs.open(file.path, 'r');
  const bytes = Buffer.alloc(4096);
  let n: number;
  try { n = (await handle.read(bytes, 0, bytes.length, 0)).bytesRead; } finally { await handle.close(); }
  const b = bytes.subarray(0, n);
  const ascii = b.toString('latin1');
  const matches: Record<string, boolean> = {
    'image/jpeg': b[0] === 255 && b[1] === 216 && b[2] === 255,
    'image/png': b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
    'image/gif': /^GIF8[79]a/.test(ascii),
    'image/webp': ascii.startsWith('RIFF') && ascii.slice(8,12) === 'WEBP',
    'video/mp4': ascii.slice(4,8) === 'ftyp', 'video/quicktime': ascii.slice(4,8) === 'ftyp',
    'video/webm': b.subarray(0,4).equals(Buffer.from([26,69,223,163])),
    'audio/webm': b.subarray(0,4).equals(Buffer.from([26,69,223,163])),
    'audio/mp4': ascii.slice(4,8) === 'ftyp', 'audio/ogg': ascii.startsWith('OggS'),
    'audio/wav': ascii.startsWith('RIFF') && ascii.slice(8,12) === 'WAVE',
    'audio/mpeg': ascii.startsWith('ID3') || (b[0] === 255 && (b[1] & 224) === 224),
    'audio/aac': b[0] === 255 && (b[1] & 246) === 240,
  };
  if (!matches[file.mimetype]) throw new ValidationError('File content does not match supported MIME type');
}
export async function processUploadedFile(file: Express.Multer.File, ownerId: string): Promise<MediaFile> {
  const generated: string[] = [];
  try {
    await validateFile(file);
    const category = getCategoryFromMime(file.mimetype)!;
    const key = `${MEDIA_TYPES[category].folder}/${file.filename}`;
    const url = buildUrl(MEDIA_TYPES[category].folder, file.filename);
    const result: MediaFile = { url, category, mimeType: file.mimetype, size: file.size, filename: file.filename,
      fileName: path.basename(file.originalname), fileMimeType: file.mimetype, fileSize: file.size };
    let thumbnail: { key: string; url: string; size: number } | undefined;
    if (category === 'image') {
      const image = sharp(file.path, { limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      result.width = metadata.width; result.height = metadata.height;
      const name = `thumb_${path.parse(file.filename).name}.jpg`;
      const thumbnailPath = path.join(uploadsRoot, 'images', name);
      generated.push(thumbnailPath);
      await image.rotate().resize({ width: 400, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(thumbnailPath);
      thumbnail = { key: `images/${name}`, url: buildUrl('images', name), size: (await fs.stat(thumbnailPath)).size };
      result.thumbnailUrl = thumbnail.url;
    }
    await prisma.$transaction(async tx => {
      await tx.mediaAsset.create({ data: { ownerId, key, url, mimeType: file.mimetype, size: file.size } });
      if (thumbnail) await tx.mediaAsset.create({ data: { ownerId, ...thumbnail, sourceUrl: url, mimeType: 'image/jpeg' } });
    });
    return result;
  } catch (error) {
    await Promise.all([file.path, ...generated].map(p => fs.unlink(p).catch(() => {})));
    if (error instanceof ValidationError) throw error;
    // Decoder/storage failures must not expose internal filesystem paths.
    throw new ValidationError('Media processing failed');
  }
}
export async function processUploadedFiles(files: Express.Multer.File[], ownerId: string): Promise<MediaFile[]> {
  try {
    for (const file of files) await validateFile(file);
    const results = [];
    for (const file of files) results.push(await processUploadedFile(file, ownerId));
    return results;
  } catch (error) {
    const urls = files.map(f => buildUrl(MEDIA_TYPES[getCategoryFromMime(f.mimetype)!].folder, f.filename));
    const generated = await prisma.mediaAsset.findMany({ where: { ownerId, sourceUrl: { in: urls } } });
    await prisma.mediaAsset.deleteMany({ where: { ownerId, OR: [{ url: { in: urls } }, { sourceUrl: { in: urls } }] } });
    await Promise.all([...files.map(f => f.path), ...generated.map(f => path.join(uploadsRoot, f.key))].map(p => fs.unlink(p).catch(() => {})));
    throw error;
  }
}
// Never unlink a shared URL on post/message deletion. Reclamation must check all references.
export async function deleteFileByUrl(_url: string): Promise<void> {
  throw new ValidationError('Shared media deletion requires reference-aware cleanup');
}
