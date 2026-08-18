import { Router } from 'express';
import { postController } from '../controllers/post.controller.js';
import { authenticate, optionalAuth } from '../middlewares/authenticate.js';
import { validate } from '../middlewares/validate.js';
import { commentSchema, createPostSchema, updatePostSchema, createStorySchema, shareSchema, shareStorySchema } from '../middlewares/schemas.js';

const router = Router();

router.get('/feed', authenticate, postController.getFeed);
router.get('/stories', authenticate, postController.getStories);
router.get('/saved', authenticate, postController.getSaved);
router.get('/liked', authenticate, postController.getLiked);
router.get('/user/:username', optionalAuth, postController.getUserPosts);
router.post('/', authenticate, validate(createPostSchema), postController.create);
router.post('/stories', authenticate, validate(createStorySchema), postController.createStory);
router.post('/stories/:storyId/view', authenticate, postController.viewStory);
router.get('/:id', optionalAuth, postController.getOne);
router.patch('/:id', authenticate, validate(updatePostSchema), postController.update);
router.delete('/:id', authenticate, postController.remove);
router.post('/:id/like', authenticate, postController.like);
router.delete('/:id/like', authenticate, postController.unlike);
router.post('/:id/save', authenticate, postController.save);
router.delete('/:id/save', authenticate, postController.unsave);
router.post('/:id/comments', authenticate, validate(commentSchema), postController.comment);
router.post('/:id/share', authenticate, validate(shareSchema), postController.share);
router.post('/stories/:storyId/share', authenticate, validate(shareStorySchema), postController.shareStory);

export default router;
