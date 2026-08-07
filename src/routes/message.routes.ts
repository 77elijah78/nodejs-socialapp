import { Router } from 'express';
import { messageController } from '../controllers/message.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { validate } from '../middlewares/validate.js';
import { sendMessageSchema, startConversationSchema, deleteConversationSchema, editMessageSchema, forwardMessageSchema, markDeliveredSchema, replyMessageSchema } from '../middlewares/schemas.js';

const router = Router();

router.use(authenticate);

router.get('/conversations', messageController.getConversations);
router.post('/conversations', validate(startConversationSchema), messageController.startConversation);
router.delete('/conversations/:conversationId', validate(deleteConversationSchema), messageController.deleteConversation);

router.get('/conversations/:conversationId/messages', messageController.getMessages);
router.post(
  '/conversations/:conversationId/messages',
  validate(sendMessageSchema),
  messageController.sendMessage
);

router.post(
  '/conversations/:conversationId/reply',
  validate(replyMessageSchema),
  messageController.replyMessage
);

router.post(
  '/messages/:messageId/edit',
  messageController.editMessage
);

router.delete(
  '/messages/:messageId',
  messageController.deleteMessage
);

router.post('/conversations/:conversationId/read', messageController.markRead);
router.post('/delivered', validate(markDeliveredSchema), messageController.markDelivered);
router.post('/messages/forward', validate(forwardMessageSchema), messageController.forwardMessage);

export default router;
