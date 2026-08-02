import jwt from 'jsonwebtoken';
import { UnauthorizedError } from './errors.js';

export interface JwtPayload {
  userId: string;
  email: string;
  username: string;
}

const ACCESS_SECRET = process.env.JWT_SECRET ?? 'changeme';
const ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES ?? '15m';
const REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES ?? '7d';

export const signAccessToken = (payload: JwtPayload): string =>
  jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRES } as jwt.SignOptions);

export const signRefreshToken = (payload: JwtPayload): string =>
  jwt.sign(payload, ACCESS_SECRET, { expiresIn: REFRESH_EXPIRES } as jwt.SignOptions);

export const verifyToken = (token: string): JwtPayload => {
  try {
    return jwt.verify(token, ACCESS_SECRET) as JwtPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired token');
  }
};
