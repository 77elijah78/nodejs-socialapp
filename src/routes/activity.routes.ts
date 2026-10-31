import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middlewares/authenticate.js';
import { activityService } from '../services/activity.service.js';
import { parsePagination, type AuthRequest } from '../types/index.js';
import { sendSuccess, buildPaginationMeta } from '../utils/response.js';
const router = Router();
router.use(authenticate);
router.get('/', async (req, res, next) => {
  try {
    const { page, limit } = parsePagination(req.query);
    const result = await activityService.list((req as AuthRequest).user.userId, page, limit);
    sendSuccess(res, result, 'Activity', 200, buildPaginationMeta(result.total, page, limit));
  } catch (error) { next(error); }
});
router.get('/unread-count', async (req, res, next) => {
  try { const result = await activityService.list((req as AuthRequest).user.userId, 1, 1); sendSuccess(res, { unreadCount: result.unreadCount }); } catch (error) { next(error); }
});
router.post('/read', async (req, res, next) => {
  try {
    const input = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).parse(req.body);
    sendSuccess(res, await activityService.read((req as AuthRequest).user.userId, input.ids));
  } catch (error) { next(error); }
});
router.post('/read-all', async (req, res, next) => {
  try { sendSuccess(res, await activityService.read((req as AuthRequest).user.userId)); } catch (error) { next(error); }
});
export default router;
