import { Router } from 'express';
import { messageController } from '../controllers/message.controller.js';
import { groupCompatController } from '../controllers/group-compat.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { abuseProtection, idempotencyGuard } from '../middlewares/abuse-protection.js';
import { validate } from '../middlewares/validate.js';
import { batchDeleteSchema, deleteMessageSchema, editMessageSchema, syncReceiptsSchema, sendMessageSchema, startConversationSchema, deleteConversationSchema, forwardMessageSchema, markDeliveredSchema, replyMessageSchema, compatGroupAddMembersSchema, compatGroupCreateSchema, compatGroupIdSchema, compatGroupMemberSchema, compatGroupRoleSchema, compatGroupUpdateSchema } from '../middlewares/schemas.js';

const router = Router();

router.use(authenticate);
router.use(abuseProtection('messages'));
router.post('/messages/delete-batch', validate(batchDeleteSchema), messageController.deleteMessages);
router.post('/receipts/sync', validate(syncReceiptsSchema), messageController.syncReceipts);

// Frontend compatibility aliases. These remain authenticated and rate-limited by
// the router above; idempotency keys are accepted when supplied but not required.
router.post('/groups', idempotencyGuard(), validate(compatGroupCreateSchema), groupCompatController.create);
router.get('/groups/:id', validate(compatGroupIdSchema), groupCompatController.get);
router.patch('/groups/:id', validate(compatGroupUpdateSchema), groupCompatController.update);
router.post('/groups/:id/members', idempotencyGuard(), validate(compatGroupAddMembersSchema), groupCompatController.addMembers);
router.delete('/groups/:id/members/:userId', validate(compatGroupMemberSchema), groupCompatController.removeMember);
router.patch('/groups/:id/members/:userId/role', validate(compatGroupRoleSchema), groupCompatController.setRole);
router.post('/groups/:id/leave', validate(compatGroupIdSchema), groupCompatController.leave);

router.get('/conversations', messageController.getConversations);
router.post('/conversations', validate(startConversationSchema), messageController.startConversation);
router.delete('/conversations/:conversationId', validate(deleteConversationSchema), messageController.deleteConversation);

router.get('/conversations/:conversationId/messages', messageController.getMessages);
router.post(
  '/conversations/:conversationId/messages',
  validate(sendMessageSchema),
  idempotencyGuard(),
  messageController.sendMessage
);

router.post(
  '/conversations/:conversationId/reply',
  validate(replyMessageSchema),
  idempotencyGuard(),
  messageController.replyMessage
);

router.post(
  '/messages/:messageId/edit',
  validate(editMessageSchema), messageController.editMessage
);

router.delete(
  '/messages/:messageId',
  validate(deleteMessageSchema), messageController.deleteMessage
);

router.post('/conversations/:conversationId/read', messageController.markRead);
router.post('/delivered', validate(markDeliveredSchema), messageController.markDelivered);
router.get('/pending/delivery', messageController.getPendingDeliveryMessages);
router.post('/messages/forward', validate(forwardMessageSchema), messageController.forwardMessage);

export default router;
