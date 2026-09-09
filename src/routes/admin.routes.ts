import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middlewares/authenticate.js';
import { validate } from '../middlewares/validate.js';
import { buildPaginationMeta, sendSuccess } from '../utils/response.js';
import { AuthRequest } from '../types/index.js';
import { requireAdmin, requirePermission } from '../admin/middleware.js';
import { adminAuthService } from '../admin/auth.service.js';
import { adminDashboardService } from '../admin/dashboard.service.js';
import { adminUsersService } from '../admin/users.service.js';
import { adminContentService } from '../admin/content.service.js';
import { adminMessagesService } from '../admin/messages.service.js';
import { adminReportsService } from '../admin/reports.service.js';
import { adminAccountsService } from '../admin/admin-accounts.service.js';
import { adminAuditLogsService } from '../admin/audit-logs.service.js';
import { adminSettingsService } from '../admin/settings.service.js';
import { adminAnalyticsService, type AnalyticsGranularity, type AnalyticsMetric } from '../admin/analytics.service.js';
import { adminSystemService } from '../admin/system.service.js';
import { ADMIN_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '../admin/permissions.js';
import {
  adminContentActionSchema,
  adminCreateAccountSchema,
  adminDisableAccountSchema,
  adminGrantRoleSchema,
  adminMessageAccessSchema,
  adminMessageModerationSchema,
  adminReportAssignSchema,
  adminReportNoteSchema,
  adminReportStatusSchema,
  adminSettingUpdateSchema,
  adminUpdateAccountSchema,
  adminUserActionSchema,
} from '../admin/schemas.js';
import { AdminRequest } from '../admin/types.js';

const router = Router();

const param = (value: string | string[] | undefined): string => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

router.use(authenticate, requireAdmin);

router.get('/auth/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await adminAuthService.getSession((req as AuthRequest).user.userId);
    sendSuccess(res, session, 'Admin session');
  } catch (err) {
    next(err);
  }
});

router.get('/meta/permissions', requirePermission('manage:admins'), (_req, res) => {
  sendSuccess(res, {
    permissions: ADMIN_PERMISSIONS,
    defaultRolePermissions: DEFAULT_ROLE_PERMISSIONS,
  });
});

router.get('/dashboard/overview', requirePermission('view:dashboard'), async (_req, res, next) => {
  try {
    const data = await adminDashboardService.getOverview();
    sendSuccess(res, data, 'Dashboard overview');
  } catch (err) {
    next(err);
  }
});

router.get('/users', requirePermission('view:users'), async (req, res, next) => {
  try {
    const { users, total, page, limit } = await adminUsersService.listUsers(req.query as Record<string, unknown>);
    sendSuccess(res, users, 'Users', 200, buildPaginationMeta(total, page, limit));
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id', requirePermission('view:users'), async (req, res, next) => {
  try {
    const user = await adminUsersService.getUser(param(req.params.id));
    sendSuccess(res, user, 'User detail');
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id/posts', requirePermission('view:posts'), async (req, res, next) => {
  try {
    const result = await adminUsersService.getUserPosts(param(req.params.id), req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'User posts', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id/stories', requirePermission('view:stories'), async (req, res, next) => {
  try {
    const result = await adminUsersService.getUserStories(param(req.params.id), req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'User stories', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id/comments', requirePermission('view:comments'), async (req, res, next) => {
  try {
    const result = await adminUsersService.getUserComments(param(req.params.id), req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'User comments', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id/likes', requirePermission('view:likes'), async (req, res, next) => {
  try {
    const result = await adminUsersService.getUserLikes(param(req.params.id), req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'User likes', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id/followers', requirePermission('view:users'), async (req, res, next) => {
  try {
    const result = await adminUsersService.getUserFollowers(param(req.params.id), req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'User followers', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id/following', requirePermission('view:users'), async (req, res, next) => {
  try {
    const result = await adminUsersService.getUserFollowing(param(req.params.id), req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'User following', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id/reports', requirePermission('view:reports'), async (req, res, next) => {
  try {
    const result = await adminUsersService.getUserReports(param(req.params.id), req.query as Record<string, unknown>);
    sendSuccess(res, result, 'User reports');
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id/moderation-history', requirePermission('view:audit_logs'), async (req, res, next) => {
  try {
    const result = await adminUsersService.getModerationHistory(param(req.params.id), req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'Moderation history', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id/activity', requirePermission('view:users'), async (req, res, next) => {
  try {
    const result = await adminUsersService.getLoginActivity(param(req.params.id), req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'Login/activity history', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/actions', requirePermission('manage:users'), validate(adminUserActionSchema), async (req, res, next) => {
  try {
    const result = await adminUsersService.applyAction(param(req.params.id), req.body.action, req.body.reason, (req as AdminRequest).admin);
    sendSuccess(res, result, 'User updated');
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/role', requirePermission('manage:admins'), validate(adminGrantRoleSchema), async (req, res, next) => {
  try {
    const result = await adminUsersService.grantOrUpdateAdminRole(param(req.params.id), req.body.role, req.body.permissions, req.body.reason, (req as AdminRequest).admin);
    sendSuccess(res, result, 'User role updated');
  } catch (err) {
    next(err);
  }
});

router.get('/content/posts', requirePermission('view:posts'), async (req, res, next) => {
  try {
    const result = await adminContentService.listPosts(req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'Posts', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.get('/content/posts/:id', requirePermission('view:posts'), async (req, res, next) => {
  try {
    const result = await adminContentService.getPost(param(req.params.id));
    sendSuccess(res, result, 'Post detail');
  } catch (err) {
    next(err);
  }
});

router.post('/content/posts/:id/moderate', requirePermission('moderate:posts'), validate(adminContentActionSchema), async (req, res, next) => {
  try {
    const result = await adminContentService.moderatePost(param(req.params.id), req.body.action, req.body.reason, (req as AdminRequest).admin);
    sendSuccess(res, result, 'Post moderated');
  } catch (err) {
    next(err);
  }
});

router.get('/content/stories', requirePermission('view:stories'), async (req, res, next) => {
  try {
    const result = await adminContentService.listStories(req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'Stories', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.post('/content/stories/:id/moderate', requirePermission('moderate:stories'), validate(adminContentActionSchema), async (req, res, next) => {
  try {
    const result = await adminContentService.moderateStory(param(req.params.id), req.body.action, req.body.reason, (req as AdminRequest).admin);
    sendSuccess(res, result, 'Story moderated');
  } catch (err) {
    next(err);
  }
});

router.get('/content/comments', requirePermission('view:comments'), async (req, res, next) => {
  try {
    const result = await adminContentService.listComments(req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'Comments', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.post('/content/comments/:id/moderate', requirePermission('moderate:comments'), validate(adminContentActionSchema), async (req, res, next) => {
  try {
    const result = await adminContentService.moderateComment(param(req.params.id), req.body.action, req.body.reason, (req as AdminRequest).admin);
    sendSuccess(res, result, 'Comment moderated');
  } catch (err) {
    next(err);
  }
});

router.get('/content/likes', requirePermission('view:likes'), async (req, res, next) => {
  try {
    const result = await adminContentService.listLikes(req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'Likes', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.get('/content/shares', requirePermission('view:shares'), async (req, res, next) => {
  try {
    const result = await adminContentService.listShares(req.query as Record<string, unknown>);
    sendSuccess(res, result, 'Shares');
  } catch (err) {
    next(err);
  }
});

router.get('/messages/conversations', requirePermission('view:messages'), async (req, res, next) => {
  try {
    const result = await adminMessagesService.listConversations(req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'Conversations', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.post('/messages/search', requirePermission('access:private_message_content'), async (req, res, next) => {
  try {
    const { reason, ...filters } = req.body ?? {};
    const result = await adminMessagesService.searchMessages(filters, reason, (req as AdminRequest).admin);
    sendSuccess(res, result.items, 'Messages', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.post('/messages/conversations/:conversationId/access', requirePermission('access:private_message_content'), validate(adminMessageAccessSchema), async (req, res, next) => {
  try {
    const result = await adminMessagesService.getConversationMessages(param(req.params.conversationId), req.body.reason, (req as AdminRequest).admin, req.query as Record<string, unknown>);
    sendSuccess(res, result, 'Conversation messages');
  } catch (err) {
    next(err);
  }
});

router.post('/messages/:messageId/remove', requirePermission('moderate:messages'), validate(adminMessageModerationSchema), async (req, res, next) => {
  try {
    const result = await adminMessagesService.removeMessage(param(req.params.messageId), req.body.reason, (req as AdminRequest).admin);
    sendSuccess(res, result, 'Message removed');
  } catch (err) {
    next(err);
  }
});

router.get('/reports', requirePermission('view:reports'), async (req, res, next) => {
  try {
    const result = await adminReportsService.list(req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'Reports', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.get('/reports/:id', requirePermission('view:reports'), async (req, res, next) => {
  try {
    const result = await adminReportsService.getOne(param(req.params.id));
    sendSuccess(res, result, 'Report detail');
  } catch (err) {
    next(err);
  }
});

router.post('/reports/:id/assign', requirePermission('resolve:reports'), validate(adminReportAssignSchema), async (req, res, next) => {
  try {
    const result = await adminReportsService.assign(param(req.params.id), req.body.adminAccountId, req.body.reason, (req as AdminRequest).admin);
    sendSuccess(res, result, 'Report assigned');
  } catch (err) {
    next(err);
  }
});

router.post('/reports/:id/notes', requirePermission('resolve:reports'), validate(adminReportNoteSchema), async (req, res, next) => {
  try {
    const result = await adminReportsService.addNote(param(req.params.id), req.body.note, (req as AdminRequest).admin);
    sendSuccess(res, result, 'Report note added', 201);
  } catch (err) {
    next(err);
  }
});

router.post('/reports/:id/status', requirePermission('resolve:reports'), validate(adminReportStatusSchema), async (req, res, next) => {
  try {
    const result = await adminReportsService.updateStatus(param(req.params.id), req.body, (req as AdminRequest).admin);
    sendSuccess(res, result, 'Report updated');
  } catch (err) {
    next(err);
  }
});

router.get('/admins', requirePermission('manage:admins'), async (_req, res, next) => {
  try {
    const result = await adminAccountsService.list();
    sendSuccess(res, result, 'Admin accounts');
  } catch (err) {
    next(err);
  }
});

router.post('/admins', requirePermission('manage:admins'), validate(adminCreateAccountSchema), async (req, res, next) => {
  try {
    const result = await adminAccountsService.create(req.body, (req as AdminRequest).admin);
    sendSuccess(res, result, 'Admin account created', 201);
  } catch (err) {
    next(err);
  }
});

router.patch('/admins/:id', requirePermission('manage:admins'), validate(adminUpdateAccountSchema), async (req, res, next) => {
  try {
    const result = await adminAccountsService.update(param(req.params.id), req.body, (req as AdminRequest).admin);
    sendSuccess(res, result, 'Admin account updated');
  } catch (err) {
    next(err);
  }
});

router.post('/admins/:id/disable', requirePermission('manage:admins'), validate(adminDisableAccountSchema), async (req, res, next) => {
  try {
    const result = await adminAccountsService.disable(param(req.params.id), req.body.reason, (req as AdminRequest).admin);
    sendSuccess(res, result, 'Admin account disabled');
  } catch (err) {
    next(err);
  }
});

router.get('/audit-logs/export', requirePermission('view:audit_logs'), async (req, res, next) => {
  try {
    const csv = await adminAuditLogsService.exportCsv(req.query as Record<string, unknown>);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
    res.status(200).send(csv);
  } catch (err) {
    next(err);
  }
});

router.get('/audit-logs', requirePermission('view:audit_logs'), async (req, res, next) => {
  try {
    const result = await adminAuditLogsService.list(req.query as Record<string, unknown>);
    sendSuccess(res, result.items, 'Audit logs', 200, buildPaginationMeta(result.total, result.page, result.limit));
  } catch (err) {
    next(err);
  }
});

router.get('/settings', requirePermission('manage:settings'), async (req, res, next) => {
  try {
    const result = await adminSettingsService.list(typeof req.query.category === 'string' ? req.query.category : undefined);
    sendSuccess(res, result, 'Platform settings');
  } catch (err) {
    next(err);
  }
});

router.put('/settings', requirePermission('manage:settings'), validate(adminSettingUpdateSchema), async (req, res, next) => {
  try {
    const result = await adminSettingsService.update(req.body.key, req.body.value, (req as AdminRequest).admin.account.id);
    sendSuccess(res, result, 'Setting updated');
  } catch (err) {
    next(err);
  }
});

router.get('/analytics/summary', requirePermission('view:analytics'), async (req, res, next) => {
  try {
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : new Date();
    const result = await adminAnalyticsService.getSummary(from, to);
    sendSuccess(res, result, 'Analytics summary');
  } catch (err) {
    next(err);
  }
});

router.get('/analytics/timeseries', requirePermission('view:analytics'), async (req, res, next) => {
  try {
    const metrics = String(req.query.metrics ?? 'users,posts,reports').split(',').filter(Boolean) as AnalyticsMetric[];
    const granularity = (req.query.granularity === 'weekly' || req.query.granularity === 'monthly' ? req.query.granularity : 'daily') as AnalyticsGranularity;
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : new Date();
    const result = await adminAnalyticsService.getTimeSeries(metrics, granularity, from, to);
    sendSuccess(res, result, 'Analytics time series');
  } catch (err) {
    next(err);
  }
});

router.get('/system/overview', requirePermission('view:system_monitoring'), async (_req, res, next) => {
  try {
    const result = await adminSystemService.getOverview();
    sendSuccess(res, result, 'System overview');
  } catch (err) {
    next(err);
  }
});

export default router;
