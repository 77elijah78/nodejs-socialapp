import type { NextFunction, Request, Response } from 'express';
import { stickerService } from '../services/sticker.service.js';
import { AuthRequest } from '../types/index.js';
import { sendSuccess } from '../utils/response.js';

const userId = (req: Request) => (req as AuthRequest).user.userId;

export const stickerController = {
  async createPack(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await stickerService.createPack(userId(req), req.body), 'Sticker pack created', 201); }
    catch (error) { next(error); }
  },
  async listPacks(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await stickerService.listPacks(userId(req), req.query.limit, req.query.cursor as string | undefined)); }
    catch (error) { next(error); }
  },
  async getPack(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await stickerService.getPack(userId(req), req.params.packId as string)); }
    catch (error) { next(error); }
  },
  async installPack(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await stickerService.installPack(userId(req), req.params.packId as string), 'Sticker pack installed'); }
    catch (error) { next(error); }
  },
  async uninstallPack(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await stickerService.uninstallPack(userId(req), req.params.packId as string), 'Sticker pack removed'); }
    catch (error) { next(error); }
  },
  async favorite(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await stickerService.favorite(userId(req), req.params.stickerId as string), 'Sticker added to favorites'); }
    catch (error) { next(error); }
  },
  async unfavorite(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await stickerService.unfavorite(userId(req), req.params.stickerId as string), 'Sticker removed from favorites'); }
    catch (error) { next(error); }
  },
  async favorites(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await stickerService.listFavorites(userId(req), req.query.limit, req.query.cursor as string | undefined)); }
    catch (error) { next(error); }
  },
  async recents(req: Request, res: Response, next: NextFunction) {
    try { sendSuccess(res, await stickerService.listRecents(userId(req), req.query.limit, req.query.cursor as string | undefined)); }
    catch (error) { next(error); }
  },
};
