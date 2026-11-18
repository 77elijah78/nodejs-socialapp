import { Router } from 'express';
import { authController } from '../controllers/auth.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { abuseProtection, idempotencyGuard } from '../middlewares/abuse-protection.js';
import { validate } from '../middlewares/validate.js';
import { googleTokenSchema, loginSchema, refreshSchema, registerSchema } from '../middlewares/schemas.js';

const router = Router();

router.post('/register', abuseProtection('auth'), validate(registerSchema), authController.register);
router.post('/login', abuseProtection('auth'), validate(loginSchema), authController.login);
router.post('/google', abuseProtection('auth'), idempotencyGuard({ required: true, allowAnonymous: true }), validate(googleTokenSchema), authController.googleSignIn);
router.post('/google/link', authenticate, abuseProtection('auth'), idempotencyGuard({ required: true }), validate(googleTokenSchema), authController.linkGoogle);
router.post('/refresh', abuseProtection('auth'), validate(refreshSchema), authController.refresh);
router.post('/logout', abuseProtection('auth'), validate(refreshSchema), authController.logout);
router.get('/me', authenticate, authController.me);

export default router;
