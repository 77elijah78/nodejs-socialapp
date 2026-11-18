import { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodType } from 'zod';

type RequestParts = { body?: unknown; query?: unknown; params?: unknown };

export const validate =
  (schema: ZodType<RequestParts>) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      if (parsed.body !== undefined) req.body = parsed.body;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const errors = err.issues.map((e) => `${e.path.join('.')}: ${e.message}`);
        res.status(400).json({ success: false, message: 'Validation failed', errors });
        return;
      }
      next(err);
    }
  };
