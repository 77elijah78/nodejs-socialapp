import { rateLimit } from 'express-rate-limit';
import { exploreService } from '../services/explore.service.js';
import { z } from 'zod';
import { postService } from '../services/post.service.js';
import { parsePagination, type AuthRequest } from '../types/index.js';
import { sendSuccess, buildPaginationMeta } from '../utils/response.js';
import { Router } from 'express';
import { postController } from '../controllers/post.controller.js';
import { authenticate, optionalAuth } from '../middlewares/authenticate.js';
import { validate } from '../middlewares/validate.js';
import { commentSchema, createPostSchema, updatePostSchema, createStorySchema, shareSchema, shareStorySchema, reportPostSchema, shareToUserSchema } from '../middlewares/schemas.js';

const router = Router();
const interactionLimit = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
const exploreLimit = rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
router.get('/explore', authenticate, exploreLimit, async (req, res, next) => {
  try {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(300).optional(), refresh: z.enum(['true','false']).optional() }).parse(req.query);
    const result = await exploreService.get((req as AuthRequest).user.userId, query.limit, query.cursor, query.refresh === 'true');
    res.json({ success: true, message: 'Explore', data: result.posts, meta: { limit: query.limit, hasNext: !!result.nextCursor, nextCursor: result.nextCursor ?? null, expiresAt: result.expiresAt, exhausted: result.exhausted, algorithmVersion: 1 } });
  } catch (error) { next(error); }
});
router.get('/:id/comments/:commentId/likes', authenticate, interactionLimit, async (req, res, next) => {
  try { sendSuccess(res, await postService.commentEngagement(z.string().uuid().parse(req.params.id), z.string().uuid().parse(req.params.commentId), (req as AuthRequest).user.userId)); }
  catch (error) { next(error); }
});
for (const method of ['post', 'delete'] as const) router[method]('/:id/comments/:commentId/like', authenticate, interactionLimit, async (req, res, next) => {
  try { sendSuccess(res, await postService.setCommentLike(z.string().uuid().parse(req.params.id), z.string().uuid().parse(req.params.commentId), (req as AuthRequest).user.userId, method === 'post')); }
  catch (error) { next(error); }
});
router.get('/:id/engagement', authenticate, interactionLimit, async (req, res, next) => {
  try { const result = await postService.getPostEngagement(z.string().uuid().parse(req.params.id), (req as AuthRequest).user.userId);
    sendSuccess(res, result); }
  catch (error) { next(error); }
});

router.get('/feed', authenticate, postController.getFeed);
router.get('/stories', authenticate, postController.getStories);
router.get('/saved', authenticate, (req, _res, next) => { try { z.object({ cursor: z.string().max(300).optional() }).parse(req.query); next(); } catch (error) { next(error); } }, postController.getSaved);
router.get('/liked', authenticate, postController.getLiked);
router.get('/user/:username', optionalAuth, postController.getUserPosts);
router.post('/', authenticate, validate(createPostSchema), postController.create);
router.post('/stories', authenticate, validate(createStorySchema), postController.createStory);
router.post('/stories/:storyId/view', authenticate, postController.viewStory);
router.get('/:id', optionalAuth, postController.getOne);
router.patch('/:id', authenticate, validate(updatePostSchema), postController.update);
router.delete('/:id', authenticate, postController.remove);
router.post('/:id/like', authenticate, interactionLimit, postController.like);
router.delete('/:id/like', authenticate, interactionLimit, postController.unlike);
router.post('/:id/save', authenticate, interactionLimit, postController.save);
router.delete('/:id/save', authenticate, interactionLimit, postController.unsave);
router.get('/:id/comments', authenticate, async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const { page, limit } = parsePagination(req.query);
    const result = await postService.getComments(id, (req as AuthRequest).user.userId, page, limit, req.query.cursor === undefined ? undefined : z.string().max(300).parse(req.query.cursor));
    sendSuccess(res, result.comments, 'Comments', 200, buildPaginationMeta(result.total, page, limit, result.nextCursor));
  } catch (error) { next(error); }
});
router.delete('/:id/comments/:commentId', authenticate, async (req, res, next) => {
  try { sendSuccess(res, await postService.deleteComment(z.string().uuid().parse(req.params.id), z.string().uuid().parse(req.params.commentId), (req as AuthRequest).user.userId)); }
  catch (error) { next(error); }
});
router.post('/:id/comments', authenticate, validate(commentSchema), postController.comment);
router.post('/:id/share', authenticate, validate(shareSchema), postController.share);
router.post('/:id/report', authenticate, validate(reportPostSchema), postController.report);
router.post('/:id/share-to-user', authenticate, validate(shareToUserSchema), postController.shareToUser);
router.post('/stories/:storyId/share', authenticate, validate(shareStorySchema), postController.shareStory);

export default router;
