import { Prisma } from '@prisma/client';
import { prisma } from '../config/database.js';
import { getOrSetCache, invalidateCacheByPrefix } from './cache.js';

const SETTINGS_CACHE_PREFIX = 'admin:settings:';

export interface SettingDefinition {
  key: string;
  category: string;
  description: string;
  value: Prisma.InputJsonValue;
}

export const DEFAULT_SETTINGS: SettingDefinition[] = [
  {
    key: 'platform_name',
    category: 'general',
    description: 'Public platform name used in admin surfaces',
    value: 'Social App',
  },
  {
    key: 'platform_description',
    category: 'general',
    description: 'Internal description for operational reference',
    value: 'A modern social media platform',
  },
  {
    key: 'registration_enabled',
    category: 'general',
    description: 'Allow new user registrations',
    value: true,
  },
  {
    key: 'maintenance_mode',
    category: 'general',
    description: 'Temporarily disable non-admin user traffic',
    value: false,
  },
  {
    key: 'default_account_visibility',
    category: 'users',
    description: 'Default visibility applied by clients that support it',
    value: 'public',
  },
  {
    key: 'max_post_images',
    category: 'content',
    description: 'Maximum number of images allowed per post',
    value: 4,
  },
  {
    key: 'allowed_story_media_types',
    category: 'content',
    description: 'Allowed story media types',
    value: ['image', 'video'],
  },
  {
    key: 'allowed_post_report_reasons',
    category: 'moderation',
    description: 'Configured moderation reasons for post reports',
    value: ['spam', 'harassment', 'abusive content', 'impersonation', 'inappropriate content', 'copyright', 'other'],
  },
];

export const adminSettingsService = {
  async ensureDefaults() {
    try {
      for (const definition of DEFAULT_SETTINGS) {
        await prisma.platformSetting.upsert({
          where: { key: definition.key },
          update: {
            category: definition.category,
            description: definition.description,
          },
          create: definition,
        });
      }
    } catch {
      // Table may not exist before migration in local dev; ignore.
    }
  },

  async list(category?: string) {
    const settings = await prisma.platformSetting.findMany({
      where: category ? { category } : undefined,
      include: {
        updatedByAdmin: {
          include: {
            user: {
              select: { id: true, username: true, email: true, displayName: true },
            },
          },
        },
      },
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    });

    return settings;
  },

  async update(key: string, value: Prisma.InputJsonValue, adminAccountId?: string) {
    const existing = await prisma.platformSetting.findUnique({ where: { key } });
    const definition = DEFAULT_SETTINGS.find((item) => item.key === key);

    const setting = await prisma.platformSetting.upsert({
      where: { key },
      update: { value, updatedByAdminId: adminAccountId ?? null },
      create: {
        key,
        category: existing?.category ?? definition?.category ?? 'custom',
        description: existing?.description ?? definition?.description ?? null,
        value,
        updatedByAdminId: adminAccountId ?? null,
      },
      include: {
        updatedByAdmin: {
          include: {
            user: {
              select: { id: true, username: true, email: true, displayName: true },
            },
          },
        },
      },
    });

    await invalidateCacheByPrefix(SETTINGS_CACHE_PREFIX);
    return setting;
  },

  async getValue<T = unknown>(key: string, fallback: T): Promise<T> {
    return getOrSetCache(`${SETTINGS_CACHE_PREFIX}${key}`, 60, async () => {
      const setting = await prisma.platformSetting.findUnique({ where: { key } });
      if (!setting) return fallback;
      return setting.value as T;
    });
  },

  async isRegistrationEnabled(): Promise<boolean> {
    try {
      return await this.getValue<boolean>('registration_enabled', true);
    } catch {
      return true;
    }
  },

  async isMaintenanceMode(): Promise<boolean> {
    try {
      return await this.getValue<boolean>('maintenance_mode', false);
    } catch {
      return false;
    }
  },
};
