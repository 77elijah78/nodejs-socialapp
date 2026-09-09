import { NextFunction, Request, Response } from 'express';
import { adminSettingsService } from '../admin/settings.service.js';

const BYPASS_PREFIXES = ['/health', '/api/v1/admin', '/api/v1/auth/login', '/api/v1/auth/refresh'];

export async function maintenanceModeGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (BYPASS_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
    next();
    return;
  }

  const maintenanceMode = await adminSettingsService.isMaintenanceMode();
  if (!maintenanceMode) {
    next();
    return;
  }

  res.status(503).json({
    success: false,
    message: 'Platform is currently in maintenance mode. Please try again later.',
  });
}
