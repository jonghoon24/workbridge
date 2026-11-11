import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { preferencesBody } from '../../schemas/notificationPreferences';
import { notificationListQuery } from '../../schemas/notifications';
import { ACTIVE_USER, AUTHENTICATED, bearer, cause, errors, invalid, jsonBody, ok, pathParams } from '../common';
import { messageBody, unreadCountBody } from '../responses/common';
import { notification, notificationList, notificationPreferences } from '../responses/notifications';

const tags = ['Notifications'];

export function registerNotificationPaths(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/notifications',
    operationId: 'getNotifications',
    tags,
    summary: '내 알림',
    description: '최신순 `limit`개(기본 20, 최대 50)와 전체 안 읽은 수.',
    security: bearer,
    request: { query: notificationListQuery },
    responses: { 200: ok(notificationList), ...errors(invalid(), AUTHENTICATED) },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/notifications/unread-count',
    operationId: 'getUnreadNotificationCount',
    tags,
    summary: '안 읽은 알림 수',
    security: bearer,
    responses: { 200: ok(unreadCountBody), ...errors(AUTHENTICATED) },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/notifications/read-all',
    operationId: 'markAllNotificationsRead',
    tags,
    summary: '알림 모두 읽음',
    security: bearer,
    responses: { 200: ok(messageBody, '`Notifications marked as read`'), ...errors(ACTIVE_USER) },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/notifications/{id}/read',
    operationId: 'markNotificationRead',
    tags,
    summary: '알림 읽음',
    description: '이미 읽은 알림은 처음 읽은 시각을 유지한다.',
    security: bearer,
    request: { params: pathParams({ id: '알림 ID' }) },
    responses: {
      200: ok(notification),
      ...errors(ACTIVE_USER, cause('NOTIFICATION_NOT_FOUND', '없거나 내 알림이 아님')),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/notifications/preferences',
    operationId: 'getMyNotificationPreferences',
    tags,
    summary: '알림 설정',
    description: '내 역할이 받는 알림 종류마다 인앱·이메일 채널의 실제 값과 잠김 여부.',
    security: bearer,
    responses: { 200: ok(notificationPreferences), ...errors(ACTIVE_USER) },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/notifications/preferences',
    operationId: 'putMyNotificationPreferences',
    tags,
    summary: '알림 설정 바꾸기',
    description: '보낸 종류의 보낸 채널만 바꾼다. 응답은 바뀐 뒤의 전체 설정이다.',
    security: bearer,
    request: { body: jsonBody(preferencesBody) },
    responses: { 200: ok(notificationPreferences), ...errors(invalid(), ACTIVE_USER) },
  });
}
