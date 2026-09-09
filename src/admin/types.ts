import { AdminAccount, AdminRole, User } from '@prisma/client';
import { Request } from 'express';
import { AuthRequest } from '../types/index.js';
import { AdminPermission } from './permissions.js';

export interface AdminContext {
  account: AdminAccount & {
    user: Pick<User, 'id' | 'username' | 'email' | 'displayName' | 'accountStatus'>;
  };
  permissions: AdminPermission[];
}

export interface AdminRequest extends AuthRequest {
  admin: AdminContext;
}

export type AdminSessionRole = AdminRole;

export interface MessageAccessReasonPayload {
  reason: string;
}
