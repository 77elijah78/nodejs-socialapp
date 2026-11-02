import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { authenticate } from '../middlewares/authenticate.js';
import { validate } from '../middlewares/validate.js';
import type { AuthRequest } from '../types/index.js';
import { sendSuccess } from '../utils/response.js';
import { pushDeviceService } from '../services/push-device.service.js';

export const pushTokenInput = z.object({ deviceId: z.string().uuid(), platform: z.literal('android'),
  deliveryMode: z.enum(['expo-alert', 'android-data-v2']).default('expo-alert'),
  projectId: z.string().uuid(), token: z.string().max(256).regex(/^(ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]+\]$/),
});
const router = Router();
router.use(authenticate);
router.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));
router.post('/devices', validate(z.object({ body: pushTokenInput })), async (req, res, next) => {
  try { sendSuccess(res, await pushDeviceService.register((req as AuthRequest).user.userId, req.body), 'Device registered'); }
  catch (error) { next(error); }
});
router.delete('/devices/:deviceId', validate(z.object({ params: z.object({ deviceId: z.string().uuid() }) })), async (req, res, next) => {
  try { sendSuccess(res, await pushDeviceService.unregister((req as AuthRequest).user.userId, String(req.params.deviceId))); }
  catch (error) { next(error); }
});
router.get('/preferences', async (req, res, next) => {
  try { sendSuccess(res, await pushDeviceService.preferences((req as AuthRequest).user.userId)); }
  catch (error) { next(error); }
});
router.patch('/preferences', validate(z.object({ body: z.object({
  messagePushEnabled: z.boolean().optional(), pushPreviewsEnabled: z.boolean().optional(),
}).refine(d => Object.keys(d).length > 0, 'At least one preference is required') })), async (req, res, next) => {
  try { sendSuccess(res, await pushDeviceService.updatePreferences((req as AuthRequest).user.userId, req.body)); }
  catch (error) { next(error); }
});
export default router;
