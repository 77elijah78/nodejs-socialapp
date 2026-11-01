import { Router } from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { validate } from '../middlewares/validate.js';
import { notificationIdSchema, notificationPageQuery, notificationReadSchema } from '../middlewares/schemas.js';
import { activityService } from '../services/activity.service.js';
import type { AuthRequest } from '../types/index.js';
import { sendSuccess, buildPaginationMeta } from '../utils/response.js';

export function createActivityRouter(cursorDefault = false) {
  const router = Router();
  router.use(authenticate);
  router.get('/', async (req, res, next) => {
    try {
      const input = notificationPageQuery.parse(req.query);
      const userId = (req as AuthRequest).user.userId;
      if (cursorDefault || input.cursor) {
        const { pagination, ...result } = await activityService.listCursor(userId, input.limit, input.cursor);
        // Cursor metadata is additive; do not manufacture offset totals for cursor pages.
        res.json({ success: true, message: 'Notifications', data: result, meta: pagination });
      } else {
        const result = await activityService.list(userId, input.page, input.limit);
        sendSuccess(res, result, 'Activity', 200, buildPaginationMeta(result.total, input.page, input.limit));
      }
    } catch (error) { next(error); }
  });
  router.get('/unread-count', async (req, res, next) => {
    try { sendSuccess(res, { unreadCount: await activityService.unreadCount((req as AuthRequest).user.userId) }); }
    catch (error) { next(error); }
  });
  router.post('/read', validate(notificationReadSchema), async (req, res, next) => {
    try { sendSuccess(res, await activityService.read((req as AuthRequest).user.userId, req.body.ids)); }
    catch (error) { next(error); }
  });
  router.post('/read-all', async (req, res, next) => {
    try { sendSuccess(res, await activityService.read((req as AuthRequest).user.userId)); }
    catch (error) { next(error); }
  });
  router.post('/:id/read', validate(notificationIdSchema), async (req, res, next) => {
    try { sendSuccess(res, await activityService.readOne((req as AuthRequest).user.userId, String(req.params.id))); }
    catch (error) { next(error); }
  });
  router.delete('/:id', validate(notificationIdSchema), async (req, res, next) => {
    try { sendSuccess(res, await activityService.dismiss((req as AuthRequest).user.userId, String(req.params.id))); }
    catch (error) { next(error); }
  });
  return router;
}
export default createActivityRouter();
