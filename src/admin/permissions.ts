import { AdminRole } from '@prisma/client';

export const ADMIN_PERMISSIONS = [
  'view:dashboard',
  'view:users',
  'manage:users',
  'view:posts',
  'moderate:posts',
  'view:stories',
  'moderate:stories',
  'view:comments',
  'moderate:comments',
  'view:likes',
  'view:shares',
  'view:messages',
  'access:private_message_content',
  'moderate:messages',
  'view:reports',
  'resolve:reports',
  'manage:admins',
  'view:analytics',
  'view:audit_logs',
  'manage:settings',
  'view:system_monitoring',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export const DEFAULT_ROLE_PERMISSIONS: Record<AdminRole, AdminPermission[]> = {
  SUPER_ADMIN: [...ADMIN_PERMISSIONS],
  ADMIN: [
    'view:dashboard',
    'view:users',
    'manage:users',
    'view:posts',
    'moderate:posts',
    'view:stories',
    'moderate:stories',
    'view:comments',
    'moderate:comments',
    'view:likes',
    'view:shares',
    'view:messages',
    'access:private_message_content',
    'moderate:messages',
    'view:reports',
    'resolve:reports',
    'view:analytics',
    'view:audit_logs',
    'manage:settings',
    'view:system_monitoring',
  ],
  MODERATOR: [
    'view:dashboard',
    'view:users',
    'manage:users',
    'view:posts',
    'moderate:posts',
    'view:stories',
    'moderate:stories',
    'view:comments',
    'moderate:comments',
    'view:likes',
    'view:shares',
    'view:messages',
    'access:private_message_content',
    'moderate:messages',
    'view:reports',
    'resolve:reports',
    'view:audit_logs',
  ],
  SUPPORT_AGENT: [
    'view:dashboard',
    'view:users',
    'view:messages',
    'access:private_message_content',
    'view:reports',
    'view:audit_logs',
  ],
  ANALYST: [
    'view:dashboard',
    'view:analytics',
    'view:audit_logs',
    'view:system_monitoring',
    'view:users',
    'view:posts',
    'view:stories',
    'view:comments',
    'view:likes',
    'view:shares',
    'view:reports',
  ],
};

export const ROLE_RANK: Record<AdminRole, number> = {
  ANALYST: 10,
  SUPPORT_AGENT: 20,
  MODERATOR: 30,
  ADMIN: 40,
  SUPER_ADMIN: 50,
};

export const normalizePermissions = (permissions: string[] = []): AdminPermission[] => {
  const allowed = new Set(ADMIN_PERMISSIONS);
  return [...new Set(permissions.filter((permission): permission is AdminPermission => allowed.has(permission as AdminPermission)))];
};

export const resolvePermissions = (role: AdminRole, overrides: string[] = []): AdminPermission[] => {
  const defaults = DEFAULT_ROLE_PERMISSIONS[role] ?? [];
  return [...new Set([...defaults, ...normalizePermissions(overrides)])];
};

export const hasPermission = (permissions: string[], permission: AdminPermission): boolean => {
  return permissions.includes(permission);
};

export const canManageRole = (actorRole: AdminRole, targetRole: AdminRole): boolean => {
  return ROLE_RANK[actorRole] > ROLE_RANK[targetRole];
};
