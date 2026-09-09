export type AdminRole = 'SUPER_ADMIN' | 'ADMIN' | 'MODERATOR' | 'SUPPORT_AGENT' | 'ANALYST';
export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DELETED';
export type ReportStatus = 'PENDING' | 'REVIEWED' | 'DISMISSED' | 'ACTION_TAKEN';

export interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data: T;
  meta?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
  errors?: string[];
}

export interface AdminSession {
  adminAccount: {
    id: string;
    userId: string;
    role: AdminRole;
    permissions: string[];
    isActive: boolean;
    lastLoginAt: string | null;
    createdAt: string;
    updatedAt: string;
    user: {
      id: string;
      username: string;
      email: string;
      displayName: string | null;
      avatarUrl: string | null;
      isVerified: boolean;
      accountStatus: AccountStatus;
      createdAt: string;
      lastActiveAt: string | null;
    };
  };
}

export interface AdminUser {
  id: string;
  username: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio?: string | null;
  isVerified: boolean;
  accountStatus: AccountStatus;
  createdAt: string;
  lastActiveAt: string | null;
  role?: string;
  adminAccount?: {
    id: string;
    role: AdminRole;
    isActive: boolean;
    permissions: string[];
  } | null;
  _count?: Record<string, number>;
  reportsAgainstUser?: number;
}

export interface PaginatedResult<T> {
  items: T[];
  meta?: ApiEnvelope<T[]>['meta'];
}
