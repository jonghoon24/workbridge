// 서버 명세의 한도. 화면 검사는 안내용이고 최종 판단은 서버가 한다.
export const MILESTONE_LIMITS = {
  minCount: 1,
  maxCount: 10,
  minAmount: 10000,
  titleMax: 100,
  descriptionMax: 2000,
  messageMax: 5000,
  linksMax: 5,
  linkMax: 2000,
  filesMax: 5,
  fileMaxBytes: 10 * 1024 * 1024,
  reasonMin: 10,
  reasonMax: 2000,
};

// 첨부 정책(이미지, PDF, ZIP, 텍스트, 오피스 문서, HWP)
export const ATTACHMENT_ACCEPT =
  'image/*,.pdf,.zip,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.hwp';

export const PAYMENT_STATUS_LABELS = {
  PENDING: '결제 대기',
  COMPLETED: '결제 완료',
  FAILED: '결제 실패',
  REFUNDED: '환불됨',
};

export const MILESTONE_STATUS_LABELS = {
  PENDING: '결제 대기',
  FUNDED: '작업 중',
  SUBMITTED: '검수 대기',
  REVISION_REQUESTED: '수정 요청',
  APPROVED: '승인 완료',
};

export const SETTLEMENT_STATUS_LABELS = {
  SCHEDULED: '지급 예정',
  PROCESSING: '지급 처리 중',
  PAID: '지급 완료',
  FAILED: '지급 실패',
  ON_HOLD: '지급 보류',
};

// 지급 시도는 최대 3회. 남은 시도가 있는 FAILED는 재시도 대기다.
export const MAX_PAYOUT_ATTEMPTS = 3;

export const CONTRACT_STATUS_LABELS = {
  PENDING: '서명 대기',
  ACTIVE: '계약 진행 중',
  COMPLETED: '완료',
};
