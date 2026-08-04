import { Router } from 'express';
import { userController } from '../controllers/user.controller.js';
import { authenticate, optionalAuth } from '../middlewares/authenticate.js';
import { validate } from '../middlewares/validate.js';
import { updateProfileSchema } from '../middlewares/schemas.js';

const router = Router();

router.get('/search', optionalAuth, userController.searchUsers);
router.get('/:username', optionalAuth, userController.getProfile);
router.patch('/me', authenticate, validate(updateProfileSchema), userController.updateProfile);
router.post('/:username/follow', authenticate, userController.follow);
router.delete('/:username/follow', authenticate, userController.unfollow);
router.get('/:username/followers', userController.getFollowers);
router.get('/:username/following', userController.getFollowing);

export default router;
