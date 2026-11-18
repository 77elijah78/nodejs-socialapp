import { Router } from 'express';
import { channelCompatController } from '../controllers/channel-compat.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { abuseProtection, idempotencyGuard } from '../middlewares/abuse-protection.js';
import { validate } from '../middlewares/validate.js';
import {
  channelListQuerySchema, channelPostCreateSchema, channelPostIdSchema, channelPostUpdateSchema,
  channelPostsQuerySchema, compatChannelCreateSchema, compatChannelIdSchema, compatChannelJoinSchema,
} from '../middlewares/schemas.js';

const router = Router();
router.use(authenticate, abuseProtection('messages'));

router.get('/', validate(channelListQuerySchema), channelCompatController.list);
router.post('/', idempotencyGuard(), validate(compatChannelCreateSchema), channelCompatController.create);
router.get('/:id/posts', validate(channelPostsQuerySchema), channelCompatController.listPosts);
router.post('/:id/posts', idempotencyGuard(), validate(channelPostCreateSchema), channelCompatController.createPost);
router.patch('/:id/posts/:postId', validate(channelPostUpdateSchema), channelCompatController.updatePost);
router.delete('/:id/posts/:postId', validate(channelPostIdSchema), channelCompatController.deletePost);
router.post('/:id/subscribe', validate(compatChannelJoinSchema), channelCompatController.subscribe);
router.delete('/:id/subscribe', validate(compatChannelIdSchema), channelCompatController.unsubscribe);
router.get('/:id', validate(compatChannelIdSchema), channelCompatController.get);

export default router;
