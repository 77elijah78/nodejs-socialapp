import { Request, Response, NextFunction } from 'express';
import { processUploadedFile, processUploadedFiles } from '../services/media.service.js';
import { sendSuccess } from '../utils/response.js';
import { AppError } from '../utils/errors.js';

export const mediaController = {

  // POST /api/v1/media/upload
  // Single file — any type (image / video / audio)
  // Used for: message attachments, voice messages
  async uploadSingle(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.file) throw new AppError('No file provided', 400);

      const media = await processUploadedFile(req.file);

      sendSuccess(res, media, 'File uploaded successfully', 201);
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/media/upload/images
  // Multiple images (up to 4) — for posts
  async uploadImages(req: Request, res: Response, next: NextFunction) {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) throw new AppError('No images provided', 400);

      const media = await processUploadedFiles(files);

      sendSuccess(res, media, `${media.length} image(s) uploaded`, 201);
    } catch (err) {
      next(err);
    }
  },

  // POST /api/v1/media/upload/avatar
  // Single image — for profile picture
  async uploadAvatar(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.file) throw new AppError('No image provided', 400);

      const media = await processUploadedFile(req.file);

      sendSuccess(res, {
        url: media.url,
        thumbnailUrl: media.thumbnailUrl,
        width: media.width,
        height: media.height,
      }, 'Avatar uploaded', 201);
    } catch (err) {
      next(err);
    }
  },
};
