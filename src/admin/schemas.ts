import { z } from 'zod';
import { ADMIN_PERMISSIONS } from './permissions.js';

const adminRoleSchema = z.enum(['SUPER_ADMIN', 'ADMIN', 'MODERATOR', 'SUPPORT_AGENT', 'ANALYST']);
const permissionSchema = z.enum(ADMIN_PERMISSIONS);

export const adminUserActionSchema = z.object({
  body: z.object({
    action: z.enum(['suspend', 'unsuspend', 'ban', 'unban', 'delete', 'restore', 'verify', 'unverify']),
    reason: z.string().min(3).max(500),
  }),
  params: z.object({ id: z.string().uuid() }),
});

export const adminMessageAccessSchema = z.object({
  body: z.object({
    reason: z.string().min(5).max(500),
  }),
  params: z.object({ conversationId: z.string().uuid() }),
});

export const adminContentActionSchema = z.object({
  body: z.object({
    action: z.enum(['remove', 'restore']),
    reason: z.string().min(3).max(500),
  }),
  params: z.object({ id: z.string().uuid() }),
});

export const adminMessageModerationSchema = z.object({
  body: z.object({
    reason: z.string().min(3).max(500),
  }),
  params: z.object({ messageId: z.string().uuid() }),
});

export const adminReportAssignSchema = z.object({
  body: z.object({
    adminAccountId: z.string().uuid().nullable().optional(),
    reason: z.string().min(3).max(500).optional(),
  }),
  params: z.object({ id: z.string().uuid() }),
});

export const adminReportNoteSchema = z.object({
  body: z.object({
    note: z.string().min(3).max(2000),
  }),
  params: z.object({ id: z.string().uuid() }),
});

export const adminReportStatusSchema = z.object({
  body: z.object({
    status: z.enum(['PENDING', 'REVIEWED', 'DISMISSED', 'ACTION_TAKEN']),
    note: z.string().max(2000).optional(),
    reason: z.string().min(3).max(500).optional(),
    removePost: z.boolean().optional(),
    suspendUser: z.boolean().optional(),
    banUser: z.boolean().optional(),
  }),
  params: z.object({ id: z.string().uuid() }),
});

export const adminSettingUpdateSchema = z.object({
  body: z.object({
    key: z.string().min(1).max(100),
    value: z.any(),
  }),
});

export const adminCreateAccountSchema = z.object({
  body: z.object({
    existingUserId: z.string().uuid().optional(),
    username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/, 'Only letters, numbers, underscores').optional(),
    email: z.string().email().optional(),
    password: z.string().min(8).optional(),
    displayName: z.string().max(60).optional(),
    role: adminRoleSchema,
    permissions: z.array(permissionSchema).optional(),
  }).refine((data) => {
    return Boolean(data.existingUserId || (data.username && data.email && data.password));
  }, { message: 'Provide existingUserId or username/email/password' }),
});

export const adminUpdateAccountSchema = z.object({
  body: z.object({
    role: adminRoleSchema.optional(),
    permissions: z.array(permissionSchema).optional(),
    isActive: z.boolean().optional(),
    reason: z.string().min(3).max(500).optional(),
  }),
  params: z.object({ id: z.string().uuid() }),
});

export const adminDisableAccountSchema = z.object({
  body: z.object({
    reason: z.string().min(3).max(500),
  }),
  params: z.object({ id: z.string().uuid() }),
});

export const adminGrantRoleSchema = z.object({
  body: z.object({
    role: adminRoleSchema,
    permissions: z.array(permissionSchema).optional(),
    reason: z.string().min(3).max(500),
  }),
  params: z.object({ id: z.string().uuid() }),
});
