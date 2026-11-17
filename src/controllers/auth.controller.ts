import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service.js';
import { googleAuthService } from '../services/google-auth.service.js';
import { sendSuccess } from '../utils/response.js';
import { AuthRequest } from '../types/index.js';

export const authController = {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.register(req.body);
      sendSuccess(res, result, 'Account created successfully', 201);
    } catch (err) {
      next(err);
    }
  },

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await authService.login(req.body);
      sendSuccess(res, result, 'Login successful');
    } catch (err) {
      next(err);
    }
  },

  async googleSignIn(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await googleAuthService.signIn(req.body.idToken);
      sendSuccess(res, result, 'Google sign-in successful');
    } catch (err) {
      next(err);
    }
  },

  async linkGoogle(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const result = await googleAuthService.linkAccount(userId, req.body.idToken);
      sendSuccess(res, result, 'Google account linked');
    } catch (err) {
      next(err);
    }
  },

  async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      const { refreshToken } = req.body;
      const result = await authService.refresh(refreshToken);
      sendSuccess(res, result, 'Token refreshed');
    } catch (err) {
      next(err);
    }
  },

  async logout(req: Request, res: Response, next: NextFunction) {
    try {
      const { refreshToken } = req.body;
      await authService.logout(refreshToken);
      sendSuccess(res, null, 'Logged out successfully');
    } catch (err) {
      next(err);
    }
  },

  async me(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as AuthRequest).user;
      sendSuccess(res, user, 'Current user');
    } catch (err) {
      next(err);
    }
  },
};
