import { Router } from 'express';

import {
  getConversationById,
  getMessageAttachment,
  getMessages,
  getMyConversations,
  getUnreadCount,
  postMessage,
  postMessageUploads,
  readConversation,
  removeMessage,
} from '../controllers/conversations.controller';
import { authenticate } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { validate } from '../middlewares/validate';
import { uploadRequestBody } from '../schemas/attachments';
import { conversationListQuery, messageBody, messageListQuery } from '../schemas/conversations';

/**
 * `/api/conversations` — conversations and messages,
 * open to either role; the only authorization is being a participant (checked in the service).
 * `GET /api/contracts/:id/conversation` lives on the contracts router instead.
 *
 * Guards are attached per route, never with `router.use`: an unmatched path must still fall
 * through to the final JSON 404 rather than a guard's 401.
 */
const router = Router();

const guard = [authenticate, requireActiveUser];

router.get('/', ...guard, validate({ query: conversationListQuery }), getMyConversations);
// Before `/:id`, so `unread-count` is never read as an id.
router.get('/unread-count', ...guard, getUnreadCount);
router.get('/:id', ...guard, getConversationById);
router.get('/:id/messages', ...guard, validate({ query: messageListQuery }), getMessages);
// Files go straight to storage: this issues the signed upload URLs, the message names the uploads.
router.post('/:id/uploads', ...guard, validate({ body: uploadRequestBody }), postMessageUploads);
router.post('/:id/messages', ...guard, validate({ body: messageBody }), postMessage);
router.get('/:id/attachments/:attachmentId/download', ...guard, getMessageAttachment);
router.post('/:id/read', ...guard, readConversation);
router.delete('/:id/messages/:messageId', ...guard, removeMessage);

export default router;
