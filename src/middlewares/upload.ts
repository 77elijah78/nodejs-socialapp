import multer, { FileFilterCallback } from 'multer';
import path from 'path';
import fs from 'fs';
import { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AppError } from '../utils/errors.js';

// ─── Media type config ─────────────────────────────────────────────
export const MEDIA_TYPES = {
  image: {
    mimes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
    maxSize: 10 * 1024 * 1024,   // 10 MB
    folder: 'images',
  },
  video: {
    mimes: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo'],
    extensions: ['.mp4', '.mov', '.webm', '.avi'],
    maxSize: 200 * 1024 * 1024,  // 200 MB
    folder: 'videos',
  },
  audio: {
    mimes: ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/aac'],
    extensions: ['.mp3', '.ogg', '.wav', '.webm', '.m4a', '.aac'],
    maxSize: 20 * 1024 * 1024,   // 20 MB
    folder: 'audio',
  },
} as const;

export type MediaCategory = keyof typeof MEDIA_TYPES;

// All accepted mimes (for mixed endpoint)
const ALL_MIMES = Object.values(MEDIA_TYPES).flatMap((t) => t.mimes) as string[];

// ─── Resolve category from mimetype ───────────────────────────────
export const getCategoryFromMime = (mime: string): MediaCategory | null => {
  for (const [cat, config] of Object.entries(MEDIA_TYPES)) {
    if ((config.mimes as readonly string[]).includes(mime)) {
      return cat as MediaCategory;
    }
  }
  return null;
};

// ─── Ensure upload directories exist ──────────────────────────────
const UPLOADS_ROOT = process.env.UPLOADS_PATH ?? 'uploads';

export const ensureUploadDirs = (): void => {
  for (const { folder } of Object.values(MEDIA_TYPES)) {
    const dir = path.join(UPLOADS_ROOT, folder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
};

// ─── Disk storage ─────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req: Request, file, cb) => {
    const category = getCategoryFromMime(file.mimetype);
    if (!category) return cb(new AppError('Unsupported file type', 400), '');

    const dest = path.join(UPLOADS_ROOT, MEDIA_TYPES[category].folder);
    cb(null, dest);
  },

  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = `${uuidv4()}${ext}`;
    cb(null, unique);
  },
});

// ─── File filter ──────────────────────────────────────────────────
const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  if (ALL_MIMES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError(`Unsupported file type: ${file.mimetype}`, 400));
  }
};

// ─── Multer instances ─────────────────────────────────────────────

// Single file (any type) — for message attachments
export const uploadSingle = multer({
  storage,
  fileFilter,
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
}).single('file');

// Multiple images — for post creation (up to 4)
export const uploadImages = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if ((MEDIA_TYPES.image.mimes as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError('Only images are allowed here', 400));
    }
  },
  limits: { fileSize: MEDIA_TYPES.image.maxSize, files: 4 },
}).array('images', 4);

// Avatar — single image only
export const uploadAvatar = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if ((MEDIA_TYPES.image.mimes as readonly string[]).includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError('Only images are allowed for avatars', 400));
    }
  },
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).single('avatar');

// ─── Multer error wrapper ──────────────────────────────────────────
// Converts multer errors to AppError so our global handler catches them
import { NextFunction, Response } from 'express';

export const handleMulterError = (
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      next(new AppError('File too large', 413));
    } else if (err.code === 'LIMIT_FILE_COUNT') {
      next(new AppError('Too many files', 400));
    } else {
      next(new AppError(err.message, 400));
    }
    return;
  }
  next(err);
};
