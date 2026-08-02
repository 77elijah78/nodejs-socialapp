import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
import { errorHandler } from './middlewares/errorHandler.js';
import { notFound } from './middlewares/notFound.js';
import routes from './routes/index.js';
import { logger } from './config/logger.js';
import { ensureUploadDirs } from './middlewares/upload.js';

const app = express();

// ─── Ensure upload dirs exist on startup ──────────────────────────
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
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 900_000),
    max: Number(process.env.RATE_LIMIT_MAX ?? 100),
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
  '/uploads',
  express.static(uploadsPath, {
    maxAge: '7d',          // Cache media files for 7 days
    immutable: true,       // Files are content-addressed (UUID names never change)
    dotfiles: 'deny',
    index: false,          // No directory listing
    setHeaders: (res, filePath) => {
      // Force correct content-type for audio/video (important for mobile)
      if (filePath.endsWith('.mp3'))  res.set('Content-Type', 'audio/mpeg');
      if (filePath.endsWith('.ogg'))  res.set('Content-Type', 'audio/ogg');
      if (filePath.endsWith('.m4a'))  res.set('Content-Type', 'audio/mp4');
      if (filePath.endsWith('.aac'))  res.set('Content-Type', 'audio/aac');
      if (filePath.endsWith('.mp4'))  res.set('Content-Type', 'video/mp4');
      if (filePath.endsWith('.webm')) res.set('Content-Type', 'video/webm');
      if (filePath.endsWith('.mov'))  res.set('Content-Type', 'video/quicktime');
    },
  })
);

// ─── Health ───────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── API Routes ───────────────────────────────────────────────────
app.use('/api/v1', routes);

// ─── Error handling ───────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

export default app;
