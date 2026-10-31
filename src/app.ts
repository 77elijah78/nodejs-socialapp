import { mediaBaseUrl } from './config/media.js';
import { optionalAuth } from './middlewares/authenticate.js';
import { authorizeMedia } from './middlewares/media-access.js';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';
import { rateLimit } from 'express-rate-limit';
import { errorHandler } from './middlewares/errorHandler.js';
import { notFound } from './middlewares/notFound.js';
import routes from './routes/index.js';
import { logger } from './config/logger.js';
import { ensureUploadDirs } from './middlewares/upload.js';
import { maintenanceModeGuard } from './middlewares/maintenance.js';

const app = express();

// ─── Ensure upload dirs exist on startup ──────────────────────────
mediaBaseUrl();
ensureUploadDirs();

// ─── Security ─────────────────────────────────────────────────────
app.use(
  helmet({
    // Allow serving local media files
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? '*',
    credentials: true,
  })
);

// ─── Rate limiting ────────────────────────────────────────────────
app.use(
  rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    max: Number(process.env.RATE_LIMIT_MAX ?? 1000),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  })
);

// ─── Parsing ──────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Logging ──────────────────────────────────────────────────────
app.use(
  morgan('combined', {
    stream: { write: (msg) => logger.http(msg.trim()) },
  })
);

// ─── Static file serving for uploads ──────────────────────────────
// Serves: GET /uploads/images/abc.jpg
//         GET /uploads/videos/abc.mp4
//         GET /uploads/audio/abc.mp3
const uploadsPath = path.resolve(process.env.UPLOADS_PATH ?? 'uploads');
app.use(
  '/uploads', optionalAuth, authorizeMedia,
  express.static(uploadsPath, {
    maxAge: 0,          // Cache media files for 7 days
    immutable: false,       // Files are content-addressed (UUID names never change)
    dotfiles: 'deny',
    index: false,          // No directory listing

  })
);

// ─── Health ───────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Maintenance mode guard for public API traffic ────────────────
app.use(maintenanceModeGuard);

// ─── API Routes ───────────────────────────────────────────────────
app.use('/api/v1', routes);

// ─── Admin SPA static assets ──────────────────────────────────────
const adminDistPath = path.resolve('admin/dist');
if (fs.existsSync(adminDistPath)) {
  app.use('/admin', express.static(adminDistPath, { index: false }));
  app.get(/^\/admin(?:\/.*)?$/, (_req, res) => {
    res.sendFile(path.join(adminDistPath, 'index.html'));
  });
}

// ─── Error handling ───────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

export default app;
