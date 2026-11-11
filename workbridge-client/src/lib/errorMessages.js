// 서버 오류 응답({ error: { code, message, fields? } })을 화면에 보여 줄 한국어 문구로 바꾸는 공용 변환.
// 화면은 서버의 오류 코드(code)로 문구를 고르고 분기한다. message는 개발자용 영어 문장이라 바뀔 수 있으므로
// 비교하지도, 화면에 보여 주지도 않는다. 코드 목록과 뜻은 서버의 OpenAPI 문서(ErrorCode 스키마)에 있다.
//
// 판단 순서
// 1. 응답이 없으면(네트워크 끊김, 시간 초과) 연결 안내
// 2. VALIDATION_FAILED: 원인 필드(fields[0])의 경로와 필드 코드로
//    overrides.fields → 공용 FIELD_MESSAGES → overrides.codes.VALIDATION_FAILED → 필드 코드별 기본 문구
// 3. 그 밖의 코드: overrides.codes → 공용 CODE_MESSAGES
// 4. 코드가 없거나 모르는 코드(프록시·플랫폼 오류 등): 429·413·5xx는 상태 코드별 기본 문구, 그 밖에는 화면이 넘긴
//    fallback, 없으면 상태 코드별 기본 문구
//
// 서버에 새 오류 코드가 생기면 CODE_MESSAGES에 문구를 넣는다. `npm run check:error-codes`가 서버의 openapi.json과
// 대조해 빠진 코드와 없어진 코드를 잡는다. 이 파일은 그 검사가 Node로 바로 읽으므로 다른 모듈을 import하지 않는다.

const RELOGIN = '로그인이 만료되었습니다. 다시 로그인해 주세요.';
const REFRESH = '이미 처리되었거나 상태가 바뀌었습니다. 새로고침한 뒤 다시 확인해 주세요.';
const BAD_REQUEST = '요청을 읽지 못했습니다. 새로고침한 뒤 다시 시도해 주세요.';
const LIST_FILTER = '목록 조건이 올바르지 않습니다. 필터를 다시 선택해 주세요.';
const PAYMENT_RETRY = '결제 정보가 올바르지 않습니다. 결제를 다시 진행해 주세요.';

export const NETWORK_ERROR = '서버에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.';

const STATUS_DEFAULTS = {
  400: '입력한 내용을 다시 확인해 주세요.',
  401: RELOGIN,
  403: '이 작업을 할 권한이 없습니다.',
  404: '요청한 정보를 찾을 수 없습니다. 삭제되었거나 주소가 바뀌었을 수 있습니다.',
  405: '지원하지 않는 요청입니다.',
  409: REFRESH,
  410: '더 이상 제공하지 않는 기능입니다.',
  413: '파일이 너무 큽니다. 크기를 줄이거나 나눠서 다시 올려 주세요.',
  429: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
};
const SERVER_ERROR = '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';

/**
 * 오류 코드 → 한국어. 상태 코드별 기본 문구로 충분한 코드는 STATUS_DEFAULT_CODES에 둔다.
 * VALIDATION_FAILED는 필드로 고른다(FIELD_MESSAGES).
 */
export const CODE_MESSAGES = {
  // 요청·인증
  MALFORMED_BODY: BAD_REQUEST,
  MALFORMED_REQUEST: BAD_REQUEST,
  UNSUPPORTED_MEDIA_TYPE: BAD_REQUEST,
  PAYLOAD_TOO_LARGE: STATUS_DEFAULTS[413],
  AUTH_REQUIRED: '로그인이 필요합니다.',
  TOKEN_INVALID: RELOGIN,
  REFRESH_TOKEN_INVALID: RELOGIN,
  INVALID_CREDENTIALS: '이메일 또는 비밀번호가 올바르지 않습니다.',
  ACCOUNT_INACTIVE: '더 이상 사용할 수 없는 계정입니다.',
  FORBIDDEN_ROLE: '이 기능을 사용할 권한이 없습니다.',
  FORBIDDEN_RESOURCE: '이 작업을 할 권한이 없습니다.',
  PROFILE_INCOMPLETE: '프로필을 먼저 완성해 주세요.',
  RATE_LIMITED: STATUS_DEFAULTS[429],

  // 파일·첨부
  FILE_TOO_LARGE: '파일이 너무 큽니다. 크기를 줄여 다시 올려 주세요.',
  FILE_TYPE_UNSUPPORTED: '지원하지 않는 파일 형식입니다. 이미지, PDF, ZIP, 텍스트, 오피스 문서, HWP만 올릴 수 있습니다.',
  TOO_MANY_FILES: '파일은 한 번에 1개만 올릴 수 있습니다.',
  UPLOAD_FAILED: '파일 업로드에 실패했습니다. 잠시 후 다시 시도해 주세요.',
  STORAGE_UNAVAILABLE: '파일 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  UPLOAD_NOT_FOUND: '파일 업로드가 만료되었습니다. 다시 보내면 파일을 새로 올립니다.',
  FILE_NOT_UPLOADED: '파일 업로드가 끝나지 않았습니다. 다시 시도해 주세요.',
  ATTACHMENT_NOT_FOUND: '첨부 파일을 찾을 수 없습니다. 삭제된 메시지의 파일일 수 있습니다.',

  // 계정
  USER_NOT_FOUND: '회원 정보를 찾을 수 없습니다.',
  EMAIL_ALREADY_IN_USE: '이미 가입된 이메일입니다. 로그인하거나 다른 이메일을 사용해 주세요.',
  ROLE_ALREADY_SELECTED: '이미 역할을 선택했습니다.',
  PASSWORD_NOT_SET: 'Google 계정으로 가입한 회원은 비밀번호를 변경할 수 없습니다.',
  CURRENT_PASSWORD_INCORRECT: '현재 비밀번호가 올바르지 않습니다.',
  PASSWORD_ALREADY_CHANGED: '비밀번호가 이미 변경되었습니다. 새로고침한 뒤 다시 시도해 주세요.',
  WITHDRAWAL_BLOCKED: '진행 중인 계약이나 받지 않은 정산이 있어 탈퇴할 수 없습니다.',
  REAUTH_REQUIRED: 'Google로 다시 로그인해 확인해 주세요.',
  REAUTH_INVALID: 'Google 확인이 만료되었거나 이 계정에 연결된 Google 계정이 아닙니다. 다시 확인해 주세요.',

  // 포트폴리오·경력·지급 계좌
  PORTFOLIO_ITEM_NOT_FOUND: '이미 삭제된 포트폴리오입니다.',
  PORTFOLIO_LIMIT_REACHED: '포트폴리오는 최대 20개까지 등록할 수 있습니다.',
  PORTFOLIO_ORDER_MISMATCH: '다른 곳에서 포트폴리오가 바뀌었습니다. 새로고침한 뒤 다시 시도해 주세요.',
  CAREER_NOT_FOUND: '이미 삭제된 경력입니다.',
  CAREER_LIMIT_REACHED: '경력은 최대 30개까지 등록할 수 있습니다.',
  PAYOUT_ACCOUNT_LOCKED: '지급이 처리되는 중에는 계좌를 바꾸거나 삭제할 수 없습니다. 잠시 후 다시 시도해 주세요.',

  // 프로젝트·지원
  PROJECT_NOT_FOUND: '프로젝트를 찾을 수 없습니다. 삭제되었을 수 있습니다.',
  PROJECT_TERMS_LOCKED: '지원자가 있는 프로젝트는 예산과 모집 기간을 바꿀 수 없습니다.',
  PROJECT_HAS_ACTIVE_CONTRACT: '진행 중이거나 서명 대기 중인 계약이 있는 프로젝트는 삭제할 수 없습니다.',
  PROJECT_HAS_CONTRACT_RECORD:
    '계약 기록이 있는 프로젝트는 상대방의 기록이라 삭제할 수 없습니다. 모집을 끝내려면 모집 마감을 이용해 주세요.',
  PROJECT_STATUS_TRANSITION_INVALID: '지금 상태에서는 이 작업을 할 수 없습니다. 새로고침한 뒤 다시 확인해 주세요.',
  REOPEN_BLOCKED_BY_CONTRACT: '서명 대기 중인 계약이 있어 다시 모집할 수 없습니다. 계약을 철회한 뒤 다시 시도해 주세요.',
  PROJECT_NOT_ACCEPTING_APPLICATIONS: '지금은 지원을 받지 않는 프로젝트입니다.',
  APPLICATION_NOT_FOUND: '지원 내역을 찾을 수 없습니다.',
  APPLICATION_ALREADY_EXISTS: '이미 지원한 프로젝트입니다. 내 지원 현황에서 확인할 수 있습니다.',
  APPLICATION_ALREADY_PROCESSED: '이미 처리된 지원입니다. 새로고침한 뒤 다시 확인해 주세요.',
  CONTRACT_ALREADY_EXISTS: '이 프로젝트에는 이미 계약이 있습니다.',

  // 계약·마일스톤
  CONTRACT_NOT_FOUND: '계약을 찾을 수 없습니다.',
  CONTRACT_CANCELLED: '이미 철회된 계약입니다.',
  CONTRACT_NOT_CANCELLABLE: '양측이 서명해 이미 시작된 계약이라 철회할 수 없습니다.',
  CONTRACT_ALREADY_COMPLETED: '완료된 계약은 다시 서명할 수 없습니다.',
  CONTRACT_NOT_ACTIVE: '양측이 서명해 계약이 시작된 뒤에 결제할 수 있습니다.',
  CONTRACT_NOT_COMPLETED: '계약이 완료된 뒤에 리뷰를 작성할 수 있습니다.',
  MANUAL_COMPLETION_REMOVED: '계약은 모든 마일스톤이 승인되면 자동으로 완료됩니다.',
  MILESTONE_NOT_FOUND: '마일스톤을 찾을 수 없습니다.',
  MILESTONE_PLAN_INVALID: '마일스톤 계획의 금액 합계가 계약 금액과 같아야 서명할 수 있습니다.',
  MILESTONE_PLAN_LOCKED: '계약이 시작된 뒤에는 마일스톤 계획을 바꿀 수 없습니다.',
  MILESTONE_NOT_AWAITING_SUBMISSION: '지금은 결과물을 제출할 수 없는 마일스톤입니다. 새로고침한 뒤 다시 확인해 주세요.',
  MILESTONE_NOT_AWAITING_REVIEW: '검수 대기 중인 마일스톤이 아닙니다. 새로고침한 뒤 다시 확인해 주세요.',

  // 결제
  PAYMENT_NOT_FOUND: '결제 정보를 찾을 수 없습니다.',
  EARLIER_MILESTONE_UNFUNDED: '앞 순서의 마일스톤부터 결제해 주세요.',
  MILESTONE_ALREADY_FUNDED: '이미 결제된 마일스톤입니다.',
  MILESTONE_REFUNDED: '환불된 마일스톤은 결제할 수 없습니다.',
  PAYMENT_ALREADY_PROCESSED: '이미 처리된 결제입니다.',
  PAYMENT_AMOUNT_MISMATCH: '결제 금액이 마일스톤 금액과 다릅니다.',
  PAYMENT_VERIFICATION_FAILED: '결제 승인에 실패했습니다. 결제 내역을 확인한 뒤 다시 시도해 주세요.',
  PAYMENT_BYPASS_DISABLED: '이 환경에서는 개발용 결제 완료를 사용할 수 없습니다.',

  // 리뷰·정산·알림·메시지
  REVIEWEE_INVALID: '리뷰 대상이 올바르지 않습니다.',
  REVIEW_ALREADY_EXISTS: '이미 리뷰를 작성한 계약입니다.',
  SETTLEMENT_NOT_FOUND: '정산 내역을 찾을 수 없습니다.',
  NOTIFICATION_NOT_FOUND: '알림을 찾을 수 없습니다.',
  CONVERSATION_NOT_FOUND: '대화방을 찾을 수 없습니다.',
  CONVERSATION_CLOSED: '대화가 종료된 대화방입니다. 이전 메시지는 계속 볼 수 있습니다.',
  COUNTERPART_INACTIVE: '상대방이 탈퇴하여 더 이상 메시지를 보낼 수 없습니다.',
  MESSAGE_NOT_FOUND: '메시지를 찾을 수 없습니다.',
  MESSAGE_DELETE_WINDOW_EXPIRED: '보낸 지 5분이 지난 메시지는 삭제할 수 없습니다.',
};

/** 화면 문구 없이 상태 코드별 기본 문구(또는 화면의 fallback)로 충분한 코드. */
export const STATUS_DEFAULT_CODES = ['VALIDATION_FAILED', 'ROUTE_NOT_FOUND', 'INTERNAL_ERROR', 'INTERNAL_TOKEN_INVALID'];

/** 필드 코드별 기본 문구 — 필드 표에 없을 때. */
const FIELD_CODE_DEFAULTS = {
  REQUIRED: '필수 항목을 입력해 주세요.',
  INVALID: '입력 형식이 올바르지 않습니다. 다시 확인해 주세요.',
  TOO_SMALL: '입력한 값이 너무 작거나 짧습니다. 다시 확인해 주세요.',
  TOO_LARGE: '입력한 값이 너무 크거나 깁니다. 다시 확인해 주세요.',
  NOT_UNIQUE: '같은 항목이 두 번 들어 있습니다. 다시 확인해 주세요.',
  CONFLICT: '함께 입력한 값과 맞지 않습니다. 다시 확인해 주세요.',
  NOT_ALLOWED: '바꿀 수 없는 항목입니다. 새로고침한 뒤 다시 시도해 주세요.',
};

const WON_POSITIVE = (label) => `${label}은 1원 이상의 원 단위 정수로 입력해 주세요.`;
const MONTH = {
  INVALID: '연월 형식이 올바르지 않습니다.',
  TOO_LARGE: '이번 달 이후는 선택할 수 없습니다.',
};
const END_MONTH = { ...MONTH, CONFLICT: '종료 월은 시작 월보다 빠를 수 없습니다.' };
const HTTP_LINK = '링크는 http:// 또는 https://로 시작하는 주소여야 합니다.';
const MAX_FILES = '파일은 최대 5개까지 첨부할 수 있습니다.';

/**
 * 검증 실패의 공용 문구: 필드 경로(숫자 단계는 뺀다: `milestones.2.amount` → `milestones.amount`) → 필드 코드 → 문구.
 * 값이 문자열이면 그 필드의 모든 코드에 같은 문구다. 같은 경로가 화면마다 다른 뜻이면(`status`, 프로젝트의
 * `title`·`description`) 그 화면이 overrides.fields로 바꾼다. 폼이 같은 검사를 먼저 하므로 대부분 안전망이다.
 */
export const FIELD_MESSAGES = {
  // 회원가입·로그인·역할·비밀번호
  email: { REQUIRED: '이메일을 입력해 주세요.', INVALID: '올바른 이메일 주소를 입력해 주세요.' },
  password: { REQUIRED: '비밀번호를 입력해 주세요.', TOO_SMALL: '비밀번호는 8자 이상이어야 합니다.', INVALID: '비밀번호를 다시 입력해 주세요.' },
  name: { REQUIRED: '이름을 입력해 주세요.', INVALID: '이름을 다시 입력해 주세요.' },
  role: { REQUIRED: '역할을 선택해 주세요.', INVALID: '역할을 선택해 주세요.', TOO_LARGE: '역할은 100자 이하로 입력해 주세요.' },
  currentPassword: { REQUIRED: '현재 비밀번호를 입력해 주세요.', INVALID: '현재 비밀번호를 다시 입력해 주세요.' },
  newPassword: {
    REQUIRED: '새 비밀번호를 입력해 주세요.',
    TOO_SMALL: '비밀번호는 8자 이상이어야 합니다.',
    CONFLICT: '새 비밀번호는 현재 비밀번호와 달라야 합니다.',
    INVALID: '새 비밀번호를 다시 입력해 주세요.',
  },
  reauthToken: 'Google로 다시 로그인해 확인해 주세요.',

  // 프로필
  experienceYears: '경력은 0 이상의 정수(년 단위)로 입력해 주세요.',
  hourlyRate: {
    INVALID: WON_POSITIVE('시간당 단가'),
    TOO_SMALL: WON_POSITIVE('시간당 단가'),
    TOO_LARGE: '시간당 단가는 1억 원 이하로 입력해 주세요.',
  },
  skills: {
    INVALID: '기술을 다시 선택해 주세요.',
    TOO_LARGE: '기술은 최대 10개, 각 50자 이하로 선택해 주세요.',
  },
  removeImage: '이미지 교체와 삭제를 동시에 할 수 없습니다.',

  // 포트폴리오·경력
  title: { REQUIRED: '제목을 입력해 주세요.', INVALID: '제목을 다시 입력해 주세요.', TOO_LARGE: '제목은 100자 이하로 입력해 주세요.' },
  description: { INVALID: '설명을 다시 입력해 주세요.', TOO_LARGE: '설명은 2,000자 이하로 입력해 주세요.' },
  url: HTTP_LINK,
  startedAt: MONTH,
  endedAt: END_MONTH,
  startDate: { ...MONTH, REQUIRED: '시작 월을 선택해 주세요.' },
  endDate: END_MONTH,
  company: { REQUIRED: '회사명을 입력해 주세요.', TOO_LARGE: '회사명은 100자 이하로 입력해 주세요.' },
  position: { REQUIRED: '직책을 입력해 주세요.', TOO_LARGE: '직책은 100자 이하로 입력해 주세요.' },
  employmentType: '고용 형태를 선택해 주세요.',

  // 프로젝트·지원
  category: { REQUIRED: '카테고리를 선택해 주세요.', INVALID: '카테고리를 다시 선택해 주세요.' },
  budget: { REQUIRED: '예산을 입력해 주세요.', INVALID: WON_POSITIVE('예산'), TOO_SMALL: WON_POSITIVE('예산') },
  deadline: {
    REQUIRED: '마감일을 선택해 주세요.',
    INVALID: '마감일을 다시 선택해 주세요.',
    TOO_SMALL: '마감일은 오늘 이후로 선택해 주세요.',
    NOT_ALLOWED: '마감일은 다시 모집할 때만 바꿀 수 있습니다.',
    CONFLICT: '모집 시작일은 마감일보다 늦을 수 없습니다.',
  },
  recruitmentStartDate: { INVALID: '모집 시작일을 다시 선택해 주세요.', CONFLICT: '모집 시작일은 마감일보다 늦을 수 없습니다.' },
  requiredSkills: '필요 기술을 다시 선택해 주세요.',
  coverLetter: { REQUIRED: '지원서를 입력해 주세요.', INVALID: '지원서를 다시 입력해 주세요.' },
  expectedRate: { REQUIRED: '희망 금액을 입력해 주세요.', INVALID: WON_POSITIVE('희망 금액'), TOO_SMALL: WON_POSITIVE('희망 금액') },
  expectedDuration: { REQUIRED: '예상 기간을 입력해 주세요.', INVALID: '예상 기간을 다시 입력해 주세요.' },

  // 목록 조건(쿼리)
  page: LIST_FILTER,
  limit: LIST_FILTER,
  sort: '정렬 조건이 올바르지 않습니다.',
  minBudget: {
    INVALID: '최소 예산은 숫자로 입력해 주세요.',
    TOO_SMALL: '최소 예산은 0원 이상으로 입력해 주세요.',
    CONFLICT: '최소 예산이 최대 예산보다 클 수 없습니다.',
  },
  maxBudget: { INVALID: '최대 예산은 숫자로 입력해 주세요.', TOO_SMALL: '최대 예산은 0원 이상으로 입력해 주세요.' },
  q: '검색어는 100자 이하로 입력해 주세요.',

  // 계약·마일스톤·결과물
  milestones: {
    REQUIRED: '마일스톤은 1~10개여야 합니다.',
    INVALID: '마일스톤은 1~10개여야 합니다.',
    TOO_LARGE: '마일스톤은 1~10개여야 합니다.',
    CONFLICT: '마일스톤 금액의 합계가 계약 금액과 같아야 합니다.',
  },
  'milestones.title': { REQUIRED: '제목을 입력해 주세요.', INVALID: '제목을 다시 입력해 주세요.', TOO_LARGE: '제목은 100자 이하로 입력해 주세요.' },
  'milestones.description': { INVALID: '설명을 다시 입력해 주세요.', TOO_LARGE: '설명은 2,000자 이하로 입력해 주세요.' },
  'milestones.amount': {
    REQUIRED: '금액은 원 단위 정수로 입력해 주세요.',
    INVALID: '금액은 원 단위 정수로 입력해 주세요.',
    TOO_SMALL: '금액은 10,000원 이상이어야 합니다.',
  },
  'milestones.dueDate': {
    REQUIRED: '기한을 선택해 주세요.',
    INVALID: '기한을 선택해 주세요.',
    TOO_SMALL: '기한은 오늘 이후로 선택해 주세요.',
    CONFLICT: '기한은 앞 마일스톤보다 빠를 수 없습니다.',
  },
  message: { REQUIRED: '내용을 입력해 주세요.', TOO_LARGE: '내용은 5,000자 이하로 입력해 주세요.' },
  links: { TOO_LARGE: '링크는 최대 5개까지 넣을 수 있습니다.', INVALID: HTTP_LINK },
  reason: {
    REQUIRED: '수정 요청 사항을 10자 이상 입력해 주세요.',
    TOO_SMALL: '수정 요청 사항을 10자 이상 입력해 주세요.',
    TOO_LARGE: '수정 요청 사항은 2,000자 이하로 입력해 주세요.',
  },

  // 첨부
  files: { REQUIRED: '첨부할 파일을 선택해 주세요.', TOO_LARGE: MAX_FILES },
  uploadIds: { TOO_LARGE: MAX_FILES, NOT_UNIQUE: '같은 파일이 두 번 첨부되었습니다. 파일을 다시 선택해 주세요.' },

  // 결제
  milestoneId: { REQUIRED: '결제할 마일스톤 정보가 없습니다.', INVALID: '결제할 마일스톤 정보가 올바르지 않습니다.' },
  paymentKey: PAYMENT_RETRY,
  orderId: PAYMENT_RETRY,
  amount: { REQUIRED: PAYMENT_RETRY, INVALID: '결제 금액이 올바르지 않습니다.', TOO_SMALL: '결제 금액이 올바르지 않습니다.' },

  // 리뷰
  contractId: '리뷰할 계약 정보가 없습니다. 새로고침한 뒤 다시 시도해 주세요.',
  revieweeId: '리뷰 대상 정보가 없습니다. 새로고침한 뒤 다시 시도해 주세요.',
  rating: { REQUIRED: '별점을 선택해 주세요.', INVALID: '별점은 1점에서 5점 사이로 선택해 주세요.', TOO_SMALL: '별점은 1점에서 5점 사이로 선택해 주세요.', TOO_LARGE: '별점은 1점에서 5점 사이로 선택해 주세요.' },
  content: { REQUIRED: '리뷰 내용을 입력해 주세요.', INVALID: '리뷰 내용을 다시 입력해 주세요.' },
  tags: '태그를 다시 선택해 주세요.',

  // 지급 계좌
  bankCode: '은행을 선택해 주세요.',
  accountNumber: '계좌번호는 숫자 10~14자리로 입력해 주세요.',
  holderName: {
    REQUIRED: '예금주를 입력해 주세요.',
    CONFLICT: '예금주가 회원 이름과 같아야 합니다. 본인 명의 계좌만 등록할 수 있습니다.',
  },

  // 메시지
  body: { REQUIRED: '메시지를 입력하거나 파일을 첨부해 주세요.', TOO_LARGE: '내용은 5,000자 이하로 입력해 주세요.' },
  before: { INVALID: '메시지를 찾을 수 없습니다. 새로고침해 주세요.', CONFLICT: '메시지 목록 조건이 올바르지 않습니다.' },
  after: { INVALID: '메시지를 찾을 수 없습니다. 새로고침해 주세요.' },

  // 알림 설정
  preferences: '알림 설정을 저장하지 못했습니다. 새로고침한 뒤 다시 시도해 주세요.',
  'preferences.type': {
    REQUIRED: '알 수 없는 알림 종류가 있습니다. 새로고침한 뒤 다시 시도해 주세요.',
    INVALID: '알 수 없는 알림 종류가 있습니다. 새로고침한 뒤 다시 시도해 주세요.',
    NOT_UNIQUE: '같은 알림 종류가 두 번 들어 있습니다. 새로고침한 뒤 다시 시도해 주세요.',
  },
  'preferences.inApp': { NOT_ALLOWED: '이 알림은 앱 알림 설정을 바꿀 수 없습니다.' },
  'preferences.email': { NOT_ALLOWED: '필수 알림은 이메일을 끌 수 없습니다.' },
};

/** 응답의 오류 코드. 응답이 없거나 코드가 없으면 null. */
export function errorCode(err) {
  return err?.response?.data?.error?.code ?? null;
}

/** VALIDATION_FAILED의 원인 필드({ path, code }). 아니면 null. */
export function fieldViolation(err) {
  if (errorCode(err) !== 'VALIDATION_FAILED') return null;
  return err.response.data.error.fields?.[0] ?? null;
}

/** `milestones.2.amount` → `milestones.amount`. */
export function fieldKey(path) {
  return String(path || '').split('.').filter((part) => !/^\d+$/.test(part)).join('.');
}

function lookupField(table, key, fieldCode) {
  const entry = table?.[key];
  if (typeof entry === 'string') return entry;
  return entry?.[fieldCode] ?? null;
}

/** 원인 필드 하나의 문구. 표에 없으면 null. */
export function fieldMessage(violation, overrides = {}) {
  if (!violation) return null;
  const key = fieldKey(violation.path);
  return lookupField(overrides.fields, key, violation.code) ?? lookupField(FIELD_MESSAGES, key, violation.code);
}

function statusDefault(status) {
  if (status >= 500) return SERVER_ERROR;
  return STATUS_DEFAULTS[status] || null;
}

/**
 * Axios 오류를 화면에 보여 줄 한국어 문구로 바꾼다.
 *
 * overrides
 * - codes: { CODE: '…' }                      이 화면에서만 다르게 안내할 오류 코드
 * - fields: { path: '…' | { FIELD_CODE: '…' } } 이 화면에서만 다른 뜻인 필드(검증 실패)
 */
export function toUserMessage(err, fallback, overrides = {}) {
  const response = err?.response;
  if (!response) return err?.request || err?.code === 'ECONNABORTED' ? NETWORK_ERROR : fallback || SERVER_ERROR;

  const status = response.status;
  const code = errorCode(err);

  if (code === 'VALIDATION_FAILED') {
    const violation = fieldViolation(err);
    return (
      fieldMessage(violation, overrides)
      ?? overrides.codes?.VALIDATION_FAILED
      ?? FIELD_CODE_DEFAULTS[violation?.code]
      ?? STATUS_DEFAULTS[400]
    );
  }

  const known = code ? overrides.codes?.[code] ?? CODE_MESSAGES[code] : null;
  if (known) return known;

  if (status === 429 || status === 413 || status >= 500) return statusDefault(status);
  return fallback || statusDefault(status) || SERVER_ERROR;
}
