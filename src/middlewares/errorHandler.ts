import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';
import { logger } from '../config/logger.js';

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void => {
  logger.error(err.message, { stack: err.stack });

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
    });
    return;
  }

  // Prisma duplicate key error
  if ((err as { code?: string }).code === 'P2002') {
    res.status(409).json({ success: false, message: 'Resource already exists' });
    return;
  }

  // Prisma not found error
  if ((err as { code?: string }).code === 'P2025') {
    res.status(404).json({ success: false, message: 'Resource not found' });
    return;
  }

  res.status(500).json({
    success: false,
    message:
      process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
};
