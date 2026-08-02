import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../utils/jwt.js';
import { UnauthorizedError } from '../utils/errors.js';
import { AuthRequest } from '../types/index.js';

export const authenticate = (req: Request, _res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return next(new UnauthorizedError('No token provided'));
  }

  const token = authHeader.slice(7);

  try {
    const payload: JwtPayload = verifyToken(token);
    (req as AuthRequest).user = payload;
    next();
  } catch (err) {
    next(err);
  }
};

// Optional auth — doesn't throw if no token
export const optionalAuth = (req: Request, _res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      (req as AuthRequest).user = verifyToken(token);
    } catch {
      // silently ignore
    }
  }
  next();
};
