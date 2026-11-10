import { Router } from 'express';

import {
  getConversationById,
  getMessages,
  getMyConversations,
  getUnreadCount,
  postMessage,
  readConversation,
  removeMessage,
} from '../controllers/conversations.controller';
import { authenticate } from '../middlewares/auth';
import { requireActiveUser } from '../middlewares/activeUser';
import { attachmentUpload } from '../middlewares/attachmentUpload';
import { validate } from '../middlewares/validate';
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
// The upload runs before validation (multer fills `req.body`); its 413/400 come first.
router.post('/:id/messages', ...guard, attachmentUpload, validate({ body: messageBody }), postMessage);
router.post('/:id/read', ...guard, readConversation);
router.delete('/:id/messages/:messageId', ...guard, removeMessage);

export default router;
