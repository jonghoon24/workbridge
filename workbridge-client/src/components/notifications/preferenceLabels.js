// 알림 설정의 한국어 라벨. 서버는 type과 category 코드만 준다.
import { toUserMessage } from '@/lib/errorMessages';

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
  CONTRACT_CANCELLED: { label: '계약 철회', description: '상대방이 서명 전 계약을 철회했을 때' },
  MILESTONE_PLAN_UPDATED: { label: '마일스톤 계획 변경', description: '서명 후 마일스톤 계획이 바뀌었을 때' },
  MILESTONE_FUNDED: { label: '마일스톤 결제', description: '의뢰인이 마일스톤 금액을 안전결제로 결제했을 때' },
  MILESTONE_SUBMITTED: { label: '결과물 제출', description: '프리랜서가 결과물을 제출했을 때' },
  MILESTONE_REVISION_REQUESTED: { label: '수정 요청', description: '제출한 결과물에 의뢰인이 수정을 요청했을 때' },
  MILESTONE_APPROVED: { label: '마일스톤 승인', description: '의뢰인이 마일스톤을 승인했을 때' },
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

// 알림 설정의 검증 오류(`preferences.*`)와 탈퇴한 계정은 공용 변환표가 맡는다.
export function describePreferenceError(err, fallback) {
  return toUserMessage(err, fallback);
}
