import sharp from 'sharp';
import type { OutputInfo } from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../config/database.js';
import { mediaBaseUrl, uploadsRoot } from '../config/media.js';
import { getCategoryFromMime, MEDIA_TYPES, type MediaCategory } from '../middlewares/upload.js';
import { AppError, ValidationError } from '../utils/errors.js';
import { v4 as uuidv4 } from 'uuid';

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

const AVATAR_UPLOAD_LIMIT = 5 * 1024 * 1024;
const AVATAR_OUTPUT_SIZE = 1024;
const AVATAR_MAX_INPUT_PIXELS = 40_000_000;
const AVATAR_THUMB_SIZE = 400;

export interface ProcessedAvatar {
  url: string;
  thumbnailUrl?: string;
  width: number;
  height: number;
}

function startsLikeXml(input: Buffer): boolean {
  let text: string;
  if (input[0] === 0xff && input[1] === 0xfe) {
    text = input.subarray(2).toString('utf16le');
  } else if (input[0] === 0xfe && input[1] === 0xff) {
    const body = input.subarray(2, input.length - ((input.length - 2) % 2));
    const littleEndian = Buffer.alloc(body.length);
    for (let i = 0; i < body.length; i += 2) {
      littleEndian[i] = body[i + 1];
      littleEndian[i + 1] = body[i];
    }
    text = littleEndian.toString('utf16le');
  } else if (input[1] === 0x00 && input[3] === 0x00) {
    text = input.subarray(0, input.length - (input.length % 2)).toString('utf16le');
  } else if (input[0] === 0x00 && input[2] === 0x00) {
    const body = input.subarray(0, input.length - (input.length % 2));
    const littleEndian = Buffer.alloc(body.length);
    for (let i = 0; i < body.length; i += 2) {
      littleEndian[i] = body[i + 1];
      littleEndian[i + 1] = body[i];
    }
    text = littleEndian.toString('utf16le');
  } else {
    text = input.toString('utf8').replace(/^\uFEFF/, '');
  }
  return text.trimStart().startsWith('<');
}

/**
 * Avatar uploads have an intentionally separate decoder path. Input MIME and
 * filename are not used to select a decoder or output format; only the payload
 * is decoded, bounded, oriented, and rewritten to WebP.
 */
export async function processAvatarFile(file: Express.Multer.File, ownerId: string): Promise<ProcessedAvatar> {
  const filename = `${uuidv4()}.webp`;
  const outputPath = path.join(uploadsRoot, MEDIA_TYPES.image.folder, filename);
  const thumbnailFilename = `thumb_${filename}`;
  const thumbnailPath = path.join(uploadsRoot, MEDIA_TYPES.image.folder, thumbnailFilename);
  try {
    if (file.size > AVATAR_UPLOAD_LIMIT) throw new AppError('File too large', 413);

    let output: OutputInfo;
    try {
      // Multer caps this file at 5 MiB. Inspect its bounded bytes so SVG/XML is
      // rejected before any vector loader runs, even with padded prologs or a
      // misleading client MIME/filename. SVGZ is rejected by its gzip signature.
      const inputBytes = await fs.readFile(file.path);
      if (startsLikeXml(inputBytes)) {
        throw new AppError('SVG avatars are not supported; upload a raster image', 415);
      }
      if (inputBytes[0] === 0x1f && inputBytes[1] === 0x8b) {
        throw new AppError('Compressed image avatars are not supported; upload a raster image', 415);
      }

      const image = sharp(file.path, {
        failOn: 'error',
        limitInputPixels: AVATAR_MAX_INPUT_PIXELS,
        animated: false,
      });
      const metadata = await image.metadata();
      if (metadata.format === 'svg') {
        throw new AppError('SVG avatars are not supported; upload a raster image', 415);
      }
      if (!metadata.width || !metadata.height) throw new Error('Image has no dimensions');

      output = await image
        .rotate()
        .resize({
          width: AVATAR_OUTPUT_SIZE,
          height: AVATAR_OUTPUT_SIZE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 85 })
        .toFile(outputPath);
      if (!output.width || !output.height) throw new Error('Normalized image has no dimensions');
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('That image format is unsupported or could not be read', 415);
    }

    let thumbnailUrl: string | undefined;
    let thumbnailSize: number | undefined;
    try {
      const thumbnail = await sharp(outputPath, {
        failOn: 'error',
        limitInputPixels: AVATAR_MAX_INPUT_PIXELS,
        animated: false,
      })
        .resize({
          width: AVATAR_THUMB_SIZE,
          height: AVATAR_THUMB_SIZE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toFile(thumbnailPath);
      thumbnailSize = thumbnail.size;
      thumbnailUrl = buildUrl(MEDIA_TYPES.image.folder, thumbnailFilename);
    } catch {
      await fs.unlink(thumbnailPath).catch(() => {});
    }

    const url = buildUrl(MEDIA_TYPES.image.folder, filename);
    await prisma.$transaction(async tx => {
      await tx.mediaAsset.create({
        data: {
          ownerId,
          key: `${MEDIA_TYPES.image.folder}/${filename}`,
          url,
          mimeType: 'image/webp',
          size: output.size,
        },
      });
      if (thumbnailUrl && thumbnailSize !== undefined) {
        await tx.mediaAsset.create({
          data: {
            ownerId,
            key: `${MEDIA_TYPES.image.folder}/${thumbnailFilename}`,
            url: thumbnailUrl,
            sourceUrl: url,
            mimeType: 'image/webp',
            size: thumbnailSize,
          },
        });
      }
    });

    return { url, ...(thumbnailUrl ? { thumbnailUrl } : {}), width: output.width, height: output.height };
  } catch (error) {
    // Remove partial output on decode/encode failure and both outputs if asset
    // registration fails. The original staged upload is always removed below.
    await Promise.all([outputPath, thumbnailPath].map(filePath => fs.unlink(filePath).catch(() => {})));
    throw error;
  } finally {
    await fs.unlink(file.path).catch(() => {});
  }
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
