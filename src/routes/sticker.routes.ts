import { Router } from 'express';
import { stickerController } from '../controllers/sticker.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { abuseProtection, idempotencyGuard } from '../middlewares/abuse-protection.js';
import { validate } from '../middlewares/validate.js';
import { packIdSchema, paginationQuerySchema, stickerIdSchema, stickerPackSchema } from '../middlewares/schemas.js';

const router = Router();
router.use(authenticate);
router.use(abuseProtection('stickers'));

router.get('/packs', validate(paginationQuerySchema), stickerController.listPacks);
router.post('/packs', idempotencyGuard({ required: true }), validate(stickerPackSchema), stickerController.createPack);
router.get('/packs/:packId', validate(packIdSchema), stickerController.getPack);
router.put('/packs/:packId/install', validate(packIdSchema), stickerController.installPack);
router.delete('/packs/:packId/install', validate(packIdSchema), stickerController.uninstallPack);
router.get('/favorites', validate(paginationQuerySchema), stickerController.favorites);
router.get('/recents', validate(paginationQuerySchema), stickerController.recents);
router.put('/:stickerId/favorite', validate(stickerIdSchema), stickerController.favorite);
router.delete('/:stickerId/favorite', validate(stickerIdSchema), stickerController.unfavorite);

export default router;
