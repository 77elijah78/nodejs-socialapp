# Audit Log Design

Audit logs are stored in `audit_logs` and are written from the backend only.

## Logged fields
- `adminAccountId`
- `action`
- `targetType`
- `targetId`
- `reason`
- `metadata` (JSON)
- `createdAt`

## Example actions
- `USER_SUSPENDED`
- `USER_UNSUSPENDED`
- `USER_BANNED`
- `USER_UNBANNED`
- `USER_DELETED`
- `USER_RESTORED`
- `USER_VERIFIED`
- `POST_REMOVED`
- `POST_RESTORED`
- `COMMENT_REMOVED`
- `COMMENT_RESTORED`
- `STORY_REMOVED`
- `STORY_RESTORED`
- `REPORT_ASSIGNED`
- `REPORT_NOTE_ADDED`
- `REPORT_REVIEWED`
- `REPORT_DISMISSED`
- `REPORT_ACTION_TAKEN`
- `PRIVATE_MESSAGE_SEARCHED`
- `PRIVATE_MESSAGE_ACCESSED`
- `MESSAGE_REMOVED`
- `ADMIN_CREATED`
- `ADMIN_UPDATED`
- `ADMIN_DISABLED`

## Guarantees
- Normal admin UI does not expose delete/edit operations for audit log entries.
- Private message access always requires a reason and generates an audit record.
- Destructive moderation actions generate audit records server-side, not just in the browser.
