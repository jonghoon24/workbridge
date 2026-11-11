// 메시지 화면 전용 상수와 헬퍼. 공용 lib/format.js는 수정하지 않고 가져다 쓴다.
import { formatDate, toKstDateInput } from '@/lib/format';
import { toUserMessage } from '@/lib/errorMessages';

// 메시지 입력 한도. 화면 검사는 안내용이고 최종 판단은 서버가 한다.
export const MESSAGE_LIMITS = {
  bodyMax: 5000,
  filesMax: 5,
  fileMaxBytes: 10 * 1024 * 1024,
  deleteWindowMs: 5 * 60 * 1000,
  pageSize: 30,
};

// 열린 대화방은 5초, 안 읽은 수 배지는 30초.
export const THREAD_POLL_MS = 5000;
export const BADGE_POLL_MS = 30000;
// 목록 화면은 명세에 주기가 없다. 배지보다 자주, 스레드보다 드물게.
export const LIST_POLL_MS = 10000;

// 스레드를 읽었거나 메시지를 보냈을 때 헤더 배지와 대화방 목록이 바로 다시 세도록 알린다.
export const MESSAGES_CHANGED_EVENT = 'messages:changed';

export function notifyMessagesChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MESSAGES_CHANGED_EVENT));
}

export const CLOSED_REASON_TEXT = {
  CONTRACT_CLOSED: '계약 완료 후 30일이 지나 대화가 종료되었습니다. 이전 메시지는 계속 볼 수 있습니다.',
  COUNTERPART_INACTIVE: '상대방이 탈퇴하여 더 이상 메시지를 보낼 수 없습니다.',
};

// 철회된 계약의 대화방도 철회한 때부터 같은 기간 동안만 보낼 수 있다(서버의 closedReason은 같은 CONTRACT_CLOSED).
export const CANCELLED_CONTRACT_CLOSED_TEXT = '계약 철회 후 30일이 지나 대화가 종료되었습니다. 이전 메시지는 계속 볼 수 있습니다.';

/** 보낼 수 없는 이유의 안내 문구. 계약 상태에 따라 완료와 철회를 구분한다. */
export function closedReasonText(closedReason, contractStatus) {
  if (closedReason === 'CONTRACT_CLOSED' && contractStatus === 'CANCELLED') return CANCELLED_CONTRACT_CLOSED_TEXT;
  return CLOSED_REASON_TEXT[closedReason] || '이 대화방에는 메시지를 보낼 수 없습니다.';
}

// 메시지 화면에서만 다르게 안내할 서버 오류. 나머지는 공용 변환표가 맡는다.
const ERROR_TEXT = {
  CONVERSATION_CLOSED: CLOSED_REASON_TEXT.CONTRACT_CLOSED,
  COUNTERPART_INACTIVE: CLOSED_REASON_TEXT.COUNTERPART_INACTIVE,
  FORBIDDEN_RESOURCE: '이 대화방에 접근할 권한이 없습니다.',
  FILE_TOO_LARGE: '파일은 개당 10MB 이하여야 합니다.',
};

export function messageErrorText(err, fallback) {
  return toUserMessage(err, fallback, { codes: ERROR_TEXT });
}

// 메시지 옆 시각: 오늘이면 "오후 3:05", 아니면 날짜까지.
export function formatMessageTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// 목록의 마지막 메시지 시각: 오늘이면 시각, 아니면 날짜.
export function formatListTime(value) {
  if (!value) return '';
  return isSameKstDay(value, new Date()) ? formatMessageTime(value) : formatDate(value);
}

export function isSameKstDay(a, b) {
  return toKstDateInput(a) === toKstDateInput(b);
}

export function formatDayDivider(value) {
  return new Date(value).toLocaleDateString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
}

// 목록 미리보기 한 줄.
export function previewText(message) {
  if (!message) return '아직 메시지가 없습니다';
  if (message.deleted) return '삭제된 메시지입니다';
  if (message.body) return message.body.replace(/\s+/g, ' ');
  if (message.attachments?.length) {
    const [first, ...rest] = message.attachments;
    return rest.length ? `파일 ${first.fileName} 외 ${rest.length}개` : `파일 ${first.fileName}`;
  }
  return '';
}

// 서버가 준 readByCounterpart는 응답 시점 값이다. 상대 워터마크가 그 뒤에 올라가도 바로
// 표시되도록 대화방 상세의 counterpartLastReadAt으로 다시 계산한다(삭제 판정과 같은 비교).
export function isReadByCounterpart(message, counterpartLastReadAt) {
  if (message.readByCounterpart === null || message.readByCounterpart === undefined) return null;
  if (message.readByCounterpart) return true;
  if (!counterpartLastReadAt) return false;
  return new Date(counterpartLastReadAt).getTime() >= new Date(message.createdAt).getTime();
}

// 같은 id는 뒤에 온 것(최신 상태)으로 바꾸고 (createdAt, id) 오름차순을 유지한다.
export function mergeMessages(current, incoming) {
  const byId = new Map(current.map((m) => [m.id, m]));
  incoming.forEach((m) => byId.set(m.id, m));
  return [...byId.values()].sort((a, b) => {
    const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
