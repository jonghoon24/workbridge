// 알림 설정(BEHAVIOR.md NC2, NC5)의 한국어 라벨. 서버는 type과 category 코드만 준다.
import { describeServerError } from '@/lib/serverErrors';

export const CATEGORY_LABELS = {
  APPLICATION: '지원',
  CONTRACT: '계약',
  MILESTONE: '마일스톤',
  SETTLEMENT: '정산',
  MESSAGE: '메시지',
};

export const CATEGORY_ORDER = ['APPLICATION', 'CONTRACT', 'MILESTONE', 'SETTLEMENT', 'MESSAGE'];

export const TYPE_LABELS = {
  APPLICATION_CREATED: { label: '새 지원자', description: '내 프로젝트에 지원이 들어왔을 때' },
  APPLICATION_ACCEPTED: { label: '지원 수락', description: '내 지원이 수락되었을 때' },
  APPLICATION_REJECTED: { label: '지원 거절', description: '내 지원이 거절되었을 때' },
  PROJECT_STATUS_CHANGED: { label: '모집 마감', description: '지원한 프로젝트의 모집이 마감되었을 때' },
  CONTRACT_ACTIVATED: { label: '계약 체결', description: '양측 서명으로 계약이 시작되었을 때' },
  CONTRACT_COMPLETED: { label: '계약 완료', description: '모든 마일스톤이 승인되었을 때' },
  MILESTONE_PLAN_UPDATED: { label: '마일스톤 계획 변경', description: '서명 후 마일스톤 계획이 바뀌었을 때' },
  MILESTONE_FUNDED: { label: '마일스톤 결제', description: '마일스톤 금액이 예치되었을 때' },
  MILESTONE_SUBMITTED: { label: '산출물 제출', description: '프리랜서가 산출물을 제출했을 때' },
  MILESTONE_REVISION_REQUESTED: { label: '수정 요청', description: '제출한 산출물에 수정 요청이 왔을 때' },
  MILESTONE_APPROVED: { label: '마일스톤 승인', description: '클라이언트가 마일스톤을 승인했을 때' },
  MILESTONE_AUTO_APPROVED: { label: '자동 승인', description: '검수 기간이 지나 자동 승인되었을 때' },
  MILESTONE_AUTO_APPROVE_REMINDER: { label: '자동 승인 임박', description: '자동 승인 48시간 전' },
  MILESTONE_DUE_SOON: { label: '기한 임박', description: '마일스톤 기한 24시간 전' },
  MILESTONE_OVERDUE: { label: '기한 초과', description: '마일스톤 기한이 지났을 때' },
  SETTLEMENT_SCHEDULED: { label: '정산 예정', description: '주간 정산이 만들어졌을 때' },
  SETTLEMENT_PAID: { label: '정산 지급', description: '정산금이 입금되었을 때' },
  SETTLEMENT_ON_HOLD: { label: '정산 보류', description: '지급 계좌가 없어 정산이 보류되었을 때' },
  SETTLEMENT_FAILED: { label: '정산 실패', description: '정산 지급이 반복해서 실패했을 때' },
  MESSAGE_UNREAD_DIGEST: { label: '읽지 않은 메시지 요약', description: '메시지를 10분 넘게 읽지 않았을 때, 대화방마다 1시간에 한 번' },
};

export function typeLabel(type) {
  return TYPE_LABELS[type] || { label: type, description: '' };
}

// 예측 가능한 서버 오류(BEHAVIOR.md NC6, 규칙 12)는 한국어로 바꿔 보여준다. 화면이 보내지 않는 모양 오류 등 나머지는 기본 문구로 대신한다.
const SERVER_ERROR_PATTERNS = [
  [/in-app notifications cannot be disabled$/, '필수 알림은 앱 알림을 끌 수 없습니다.'],
  [/email notifications cannot be disabled$/, '필수 알림은 이메일을 끌 수 없습니다.'],
  [/has no in-app notifications$/, '읽지 않은 메시지 요약은 이메일로만 받을 수 있습니다.'],
  [/Unknown notification type$/, '알 수 없는 알림 종류가 있습니다. 새로고침 후 다시 시도해주세요.'],
  [/Duplicate notification type$/, '같은 알림 종류가 두 번 들어 있습니다. 새로고침 후 다시 시도해주세요.'],
  [/^Account is no longer active$/, '더 이상 사용할 수 없는 계정입니다.'],
];

export function describePreferenceError(err, fallback) {
  return describeServerError(err, fallback, { patterns: SERVER_ERROR_PATTERNS, passthrough: false });
}
