import { Router } from 'express';
import authRoutes    from './auth.routes.js';
import userRoutes    from './user.routes.js';
import postRoutes    from './post.routes.js';
import messageRoutes from './message.routes.js';
import mediaRoutes   from './media.routes.js';
import adminRoutes   from './admin.routes.js';

const router = Router();

router.use('/auth',     authRoutes);
router.use('/users',    userRoutes);
router.use('/posts',    postRoutes);
router.use('/messages', messageRoutes);
router.use('/media',    mediaRoutes);
router.use('/admin',    adminRoutes);

export default router;
