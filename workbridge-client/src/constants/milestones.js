// 서버 명세(BEHAVIOR.md M8, M10, M18)의 한도. 화면 검사는 안내용이고 최종 판단은 서버가 한다.
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

// rule 12 첨부 정책(이미지, PDF, ZIP, 텍스트, 오피스 문서, HWP)
export const ATTACHMENT_ACCEPT =
  'image/*,.pdf,.zip,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.hwp';

export const PAYMENT_STATUS_LABELS = {
  PENDING: '결제 대기',
  COMPLETED: '결제 완료',
  FAILED: '결제 실패',
  REFUNDED: '환불됨',
};

export const CONTRACT_STATUS_LABELS = {
  PENDING: '서명 대기',
  ACTIVE: '계약 진행 중',
  COMPLETED: '완료',
};
