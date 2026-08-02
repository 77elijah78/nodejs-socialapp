import { Router } from "express";
import { mediaController } from "../controllers/media.controller.js";
import { authenticate } from "../middlewares/authenticate.js";
import {
  uploadSingle,
  uploadImages,
  uploadAvatar,
  handleMulterError,
} from "../middlewares/upload.js";

const router = Router();

// All media endpoints require auth
router.use(authenticate);

// ─── Single file (image / video / audio) ──────────────────────────
// Used for message attachments and voice messages
router.post(
  "/upload",
  (req, res, next) =>
    uploadSingle(req, res, (err: unknown) =>
      err ? handleMulterError(err, req, res, next) : next(),
    ),
  mediaController.uploadSingle,
);

// ─── Multiple images (up to 4) ────────────────────────────────────
// Used when creating a post with images
router.post(
  "/upload/images",
  (req, res, next) =>
    uploadImages(req, res, (err: unknown) =>
      err ? handleMulterError(err, req, res, next) : next(),
    ),
  mediaController.uploadImages,
);

// ─── Avatar ───────────────────────────────────────────────────────
router.post(
  "/upload/avatar",
  (req, res, next) =>
    uploadAvatar(req, res, (err: unknown) =>
      err ? handleMulterError(err, req, res, next) : next(),
    ),
  mediaController.uploadAvatar,
);

export default router;
