import { Router } from 'express';
import { communityController } from '../controllers/community.controller.js';
import { authenticate } from '../middlewares/authenticate.js';
import { abuseProtection, idempotencyGuard } from '../middlewares/abuse-protection.js';
import { validate } from '../middlewares/validate.js';
import {
  channelMemberSchema, communityIdSchema, createChannelSchema, createGroupSchema, groupMemberSchema,
  groupMembersSchema, joinChannelSchema, memberRoleSchema, paginationQuerySchema,
  updateChannelSchema, updateGroupSchema,
} from '../middlewares/schemas.js';

const router = Router();
router.use(authenticate);

router.get('/groups', abuseProtection('messages'), validate(paginationQuerySchema), communityController.listGroups);
router.post('/groups', abuseProtection('messages'), idempotencyGuard({ required: true }), validate(createGroupSchema), communityController.createGroup);
router.get('/groups/:conversationId', abuseProtection('messages'), validate(communityIdSchema), communityController.getGroup);
router.patch('/groups/:conversationId', abuseProtection('messages'), validate(updateGroupSchema), communityController.updateGroup);
router.post('/groups/:conversationId/members', abuseProtection('messages'), idempotencyGuard({ required: true }), validate(groupMembersSchema), communityController.addGroupMembers);
router.delete('/groups/:conversationId/members/:memberId', abuseProtection('messages'), validate(groupMemberSchema), communityController.removeGroupMember);
router.patch('/groups/:conversationId/members/:memberId/role', abuseProtection('messages'), validate(memberRoleSchema), communityController.setGroupRole);

router.get('/channels', abuseProtection('messages'), validate(paginationQuerySchema), communityController.listChannels);
router.post('/channels', abuseProtection('messages'), idempotencyGuard({ required: true }), validate(createChannelSchema), communityController.createChannel);
router.get('/channels/:conversationId', abuseProtection('messages'), validate(communityIdSchema), communityController.getChannel);
router.patch('/channels/:conversationId', abuseProtection('messages'), validate(updateChannelSchema), communityController.updateChannel);
router.post('/channels/:conversationId/join', abuseProtection('messages'), idempotencyGuard({ required: true }), validate(joinChannelSchema), communityController.joinChannel);
router.delete('/channels/:conversationId/leave', abuseProtection('messages'), validate(communityIdSchema), communityController.leaveChannel);
router.delete('/channels/:conversationId/members/:memberId', abuseProtection('messages'), validate(channelMemberSchema), communityController.removeChannelMember);
router.patch('/channels/:conversationId/members/:memberId/role', abuseProtection('messages'), validate(memberRoleSchema), communityController.setChannelRole);
router.post('/channels/:conversationId/invite/rotate', abuseProtection('messages'), idempotencyGuard({ required: true }), validate(communityIdSchema), communityController.rotateChannelInvite);

export default router;
