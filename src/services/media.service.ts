import path from 'path';
import fs from 'fs/promises';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { getCategoryFromMime, MEDIA_TYPES, MediaCategory } from '../middlewares/upload.js';
import { logger } from '../config/logger.js';

const UPLOADS_ROOT = process.env.UPLOADS_PATH ?? 'uploads';
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

export interface MediaFile {
  url: string;
  thumbnailUrl?: string;
  category: MediaCategory;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  filename: string;
}

// ─── Build public URL from filename ───────────────────────────────
export const buildUrl = (folder: string, filename: string): string =>
  `${BASE_URL}/uploads/${folder}/${filename}`;

// ─── Process a single uploaded file ───────────────────────────────
export const processUploadedFile = async (
  file: Express.Multer.File
): Promise<MediaFile> => {
  const category = getCategoryFromMime(file.mimetype);
  if (!category) throw new Error(`Unknown mime: ${file.mimetype}`);

  const folder = MEDIA_TYPES[category].folder;
  const url = buildUrl(folder, file.filename);

  const result: MediaFile = {
    url,
    category,
    mimeType: file.mimetype,
    size: file.size,
    filename: file.filename,
  };

  // ── Image: generate thumbnail + extract dimensions ────────────
  if (category === 'image') {
    try {
      const meta = await sharp(file.path).metadata();
      result.width = meta.width;
      result.height = meta.height;

      // Generate thumbnail (400px wide, preserving aspect ratio)
      const thumbFilename = `thumb_${file.filename}`;
      const thumbPath = path.join(UPLOADS_ROOT, folder, thumbFilename);

      await sharp(file.path)
        .resize({ width: 400, withoutEnlargement: true })
        .jpeg({ quality: 80, progressive: true })
        .toFile(thumbPath);

      result.thumbnailUrl = buildUrl(folder, thumbFilename);

      // If it's a PNG/WebP, also create a compressed WebP version
      if (['image/png', 'image/webp'].includes(file.mimetype)) {
        const webpFilename = file.filename.replace(/\.[^.]+$/, '.webp');
        const webpPath = path.join(UPLOADS_ROOT, folder, webpFilename);
        await sharp(file.path)
          .webp({ quality: 85 })
          .toFile(webpPath);
        // Return webp url as primary (smaller size)
        result.url = buildUrl(folder, webpFilename);
      }
    } catch (err) {
      logger.warn('Sharp processing failed, returning original', err);
    }
  }

  // ── Video: just return URL (ffprobe would go here for duration) ─
  if (category === 'video') {
    // Duration extraction requires ffprobe — add if needed:
    // result.duration = await getVideoDuration(file.path);
    logger.info(`Video uploaded: ${file.filename} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
  }

  // ── Audio: just return URL ─────────────────────────────────────
  if (category === 'audio') {
    logger.info(`Audio uploaded: ${file.filename} (${(file.size / 1024).toFixed(2)} KB)`);
  }

  return result;
};

// ─── Process multiple files (for posts with multiple images) ──────
export const processUploadedFiles = async (
  files: Express.Multer.File[]
): Promise<MediaFile[]> => {
  return Promise.all(files.map(processUploadedFile));
};

// ─── Delete a file by URL (cleanup on post delete etc.) ───────────
export const deleteFileByUrl = async (url: string): Promise<void> => {
  try {
    // Extract relative path from URL: /uploads/images/abc.jpg
    const relativePath = url.replace(BASE_URL, '');
    const filePath = path.join(process.cwd(), relativePath);
    await fs.unlink(filePath);

    // Also delete thumbnail if it exists
    const thumbPath = filePath.replace(/(\.[\w]+)$/, '_thumb$1');
    await fs.unlink(thumbPath).catch(() => {}); // silent fail if no thumb
  } catch (err) {
    logger.warn(`Could not delete file: ${url}`, err);
  }
};
