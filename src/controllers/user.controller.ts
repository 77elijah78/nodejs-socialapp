import { Request, Response, NextFunction } from 'express';
import { userService } from '../services/user.service.js';
import { sendSuccess, buildPaginationMeta } from '../utils/response.js';
import { AuthRequest, parsePagination } from '../types/index.js';

// Helper function to extract single string value from express param
function extractParamValue(param: string | string[]): string {
  if (Array.isArray(param)) {
    return param[0] || '';
  }
  return param;
}

export const userController = {
  async getProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const requesterId = (req as AuthRequest).user?.userId;
      const username = extractParamValue(req.params.username);
      
      // Validate username exists
      if (!username) {
        throw new Error('Username is required');
      }
      
      const profile = await userService.getProfile(username, requesterId);
      sendSuccess(res, profile);
    } catch (err) {
      next(err);
    }
  },

  async updateProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const user = await userService.updateProfile(userId, req.body);
      sendSuccess(res, user, 'Profile updated');
    } catch (err) {
      next(err);
    }
  },

  async follow(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const username = extractParamValue(req.params.username);
      
      if (!username) {
        throw new Error('Username is required');
      }
      
      const result = await userService.follow(userId, username);
      sendSuccess(res, result, result.message, 201);
    } catch (err) {
      next(err);
    }
  },

  async unfollow(req: Request, res: Response, next: NextFunction) {
    try {
      const { userId } = (req as AuthRequest).user;
      const username = extractParamValue(req.params.username);
      
      if (!username) {
        throw new Error('Username is required');
      }
      
      const result = await userService.unfollow(userId, username);
      sendSuccess(res, result, result.message);
    } catch (err) {
      next(err);
    }
  },

  async getFollowers(req: Request, res: Response, next: NextFunction) {
    try {
      const username = extractParamValue(req.params.username);
      
      if (!username) {
        throw new Error('Username is required');
      }
      
      const { page, limit } = parsePagination(req.query);
      const { followers, total } = await userService.getFollowers(username, page, limit);
      sendSuccess(res, followers, 'Followers', 200, buildPaginationMeta(total, page, limit));
    } catch (err) {
      next(err);
    }
  },

  async getFollowing(req: Request, res: Response, next: NextFunction) {
    try {
      const username = extractParamValue(req.params.username);
      
      if (!username) {
        throw new Error('Username is required');
      }
      
      const { page, limit } = parsePagination(req.query);
      const { following, total } = await userService.getFollowing(username, page, limit);
      sendSuccess(res, following, 'Following', 200, buildPaginationMeta(total, page, limit));
    } catch (err) {
      next(err);
    }
  },
};