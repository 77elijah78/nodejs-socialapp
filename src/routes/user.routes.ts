import { Router } from 'express';
import { userController } from '../controllers/user.controller.js';
import { authenticate, optionalAuth } from '../middlewares/authenticate.js';
import { abuseProtection } from '../middlewares/abuse-protection.js';
import { validate } from '../middlewares/validate.js';
import { updateProfileSchema } from '../middlewares/schemas.js';

const router = Router();

router.get('/search', optionalAuth, abuseProtection('social'), userController.searchUsers);
router.get('/:username', optionalAuth, abuseProtection('social'), userController.getProfile);
router.patch('/me', authenticate, abuseProtection('social'), validate(updateProfileSchema), userController.updateProfile);
router.post('/:username/follow', authenticate, abuseProtection('social'), userController.follow);
router.delete('/:username/follow', authenticate, abuseProtection('social'), userController.unfollow);
router.get('/me/following', authenticate, abuseProtection('social'), userController.getMyFollowing);
router.get('/me/suggested', authenticate, abuseProtection('social'), userController.getSuggestedUsers);
router.get('/:username/followers', abuseProtection('social'), userController.getFollowers);
router.get('/:username/following', abuseProtection('social'), userController.getFollowing);

export default router;
