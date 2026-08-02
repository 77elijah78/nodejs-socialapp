import { Router } from 'express';
import { postController } from '../controllers/post.controller.js';
import { authenticate, optionalAuth } from '../middlewares/authenticate.js';
import { validate } from '../middlewares/validate.js';
import { commentSchema, createPostSchema, updatePostSchema, createStorySchema } from '../middlewares/schemas.js';

const router = Router();

router.get('/feed', authenticate, postController.getFeed);
router.get('/stories', authenticate, postController.getStories);
router.get('/saved', authenticate, postController.getSaved);
router.post('/', authenticate, validate(createPostSchema), postController.create);
router.post('/stories', authenticate, validate(createStorySchema), postController.createStory);
router.get('/:id', optionalAuth, postController.getOne);
router.patch('/:id', authenticate, validate(updatePostSchema), postController.update);
router.delete('/:id', authenticate, postController.remove);
router.post('/:id/like', authenticate, postController.like);
router.delete('/:id/like', authenticate, postController.unlike);
router.post('/:id/save', authenticate, postController.save);
router.delete('/:id/save', authenticate, postController.unsave);
router.post('/:id/comments', authenticate, validate(commentSchema), postController.comment);

export default router;
