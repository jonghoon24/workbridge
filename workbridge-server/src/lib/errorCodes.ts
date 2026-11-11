/**
 * The error codes of the API — the `code` of every error response (`{ error: { code, message } }`).
 *
 * A code is the API's contract with its callers: the client branches on it and picks the text it
 * shows, while `message` is an English sentence for developers and logs that may change at any
 * time (docs/domain/README.md "오류 응답"). So:
 *
 * - **A code is never renamed, removed or reused for another cause.** `test/error-codes.test.ts`
 *   compares this table with a committed list and fails when a code disappears.
 * - **A code fixes its HTTP status.** `AppError` takes the status from here; the throw site never
 *   states it, so one cause cannot go out with two statuses.
 * - **One code per cause the client must tell apart** (a different text or a different action);
 *   causes the client treats the same share one. A request validation failure is always
 *   `VALIDATION_FAILED`, with the field and why in `fields` (`FIELD_ERROR_CODES`).
 * - Naming: UPPER_SNAKE, at most 40 characters. A resource's causes are `<RESOURCE>_<CONDITION>`
 *   (`PROJECT_NOT_FOUND`, `CONTRACT_CANCELLED`); only the platform codes have no resource prefix.
 *
 * `description` (Korean, one line) becomes the code table of the `ErrorCode` schema in the
 * OpenAPI document — the list the client's developers read. Which routes give which codes is in the
 * path registrations (`src/openapi/paths/`).
 */

export type ErrorHttpStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 429 | 500 | 502;

interface ErrorCodeSpec {
  status: ErrorHttpStatus;
  description: string;
}

export const ERROR_CODES = {
  // -------------------------------------------------------------------------------------------
  // Platform: any route, or the guards in front of it
  // -------------------------------------------------------------------------------------------
  VALIDATION_FAILED: { status: 400, description: '요청 검증 실패. 원인 필드와 이유는 `fields`에 있다' },
  MALFORMED_BODY: { status: 400, description: '본문을 읽지 못함 — JSON이 깨졌거나 multipart 본문이 깨졌거나 예상 밖의 파일 필드' },
  MALFORMED_REQUEST: { status: 400, description: '경로의 퍼센트 인코딩이 깨져 경로 파라미터를 읽지 못함' },
  PAYLOAD_TOO_LARGE: { status: 413, description: 'JSON 본문이 너무 큼(100KB)' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, description: '본문의 문자셋이나 `Content-Encoding`을 지원하지 않음' },
  AUTH_REQUIRED: { status: 401, description: '`Authorization: Bearer <토큰>` 헤더가 없음' },
  TOKEN_INVALID: { status: 401, description: 'Access Token이 위조됐거나 만료됨' },
  REFRESH_TOKEN_INVALID: { status: 401, description: 'Refresh Token이 없거나 위조·만료됐거나 그 사용자가 없음' },
  INVALID_CREDENTIALS: { status: 401, description: '이메일이나 비밀번호가 틀림' },
  ACCOUNT_INACTIVE: { status: 401, description: '탈퇴(소프트 삭제)한 사용자' },
  FORBIDDEN_ROLE: { status: 403, description: '이 역할(의뢰인/프리랜서)은 쓸 수 없는 기능' },
  FORBIDDEN_RESOURCE: { status: 403, description: '호출자의 리소스가 아니거나 호출자가 당사자가 아님' },
  PROFILE_INCOMPLETE: { status: 403, description: '역할의 프로필 필수 항목이 비어 있음' },
  ROUTE_NOT_FOUND: { status: 404, description: '일치하는 경로나 메서드가 없음(설정이 없어 숨긴 경로도 같다)' },
  RATE_LIMITED: { status: 429, description: '요청 한도 초과. `Retry-After` 초 뒤에 다시 시도' },
  INTERNAL_ERROR: { status: 500, description: '서버 버그. 원인은 응답에 싣지 않고 서버 로그에만 남긴다' },
  INTERNAL_TOKEN_INVALID: { status: 403, description: '`X-Internal-Token`이 없거나 틀림' },

  // -------------------------------------------------------------------------------------------
  // Files and attachments
  // -------------------------------------------------------------------------------------------
  FILE_TOO_LARGE: { status: 413, description: '파일 하나가 한도(첨부 10MB, 이미지 5MB)를 넘음' },
  FILE_TYPE_UNSUPPORTED: { status: 400, description: '허용하지 않는 파일 형식' },
  TOO_MANY_FILES: { status: 400, description: 'multipart 이미지 업로드에 파일이 너무 많음' },
  UPLOAD_FAILED: { status: 502, description: '저장소(Supabase Storage)에 올리거나 업로드 URL을 만들지 못함' },
  STORAGE_UNAVAILABLE: { status: 502, description: '저장소(Supabase Storage)에서 파일을 확인하거나 다운로드 URL을 만들지 못함' },
  UPLOAD_NOT_FOUND: { status: 400, description: '내가 이 대상에 받은 업로드가 아니거나, 만료됐거나, 이미 붙음' },
  FILE_NOT_UPLOADED: { status: 400, description: '업로드 URL로 파일을 올리지 않음' },
  ATTACHMENT_NOT_FOUND: { status: 404, description: '없는 첨부 파일' },

  // -------------------------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------------------------
  USER_NOT_FOUND: { status: 404, description: '없거나 삭제된 사용자' },
  EMAIL_ALREADY_IN_USE: { status: 409, description: '이미 가입된 이메일' },
  ROLE_ALREADY_SELECTED: { status: 400, description: '역할을 이미 고름' },
  PASSWORD_NOT_SET: { status: 409, description: '비밀번호가 없는 계정(Google로만 가입)' },
  CURRENT_PASSWORD_INCORRECT: { status: 400, description: '현재 비밀번호가 틀림' },
  PASSWORD_ALREADY_CHANGED: { status: 409, description: '확인하는 사이에 비밀번호가 이미 바뀜' },
  WITHDRAWAL_BLOCKED: { status: 409, description: '진행 중인 계약이나 받지 않은 정산이 있어 탈퇴할 수 없음' },
  REAUTH_REQUIRED: { status: 400, description: 'Google 재인증 토큰이 없음' },
  REAUTH_INVALID: { status: 400, description: 'Google 재인증 토큰이 틀렸거나 만료됐거나 다른 계정·목적의 것' },

  // -------------------------------------------------------------------------------------------
  // Portfolio, careers, payout account
  // -------------------------------------------------------------------------------------------
  PORTFOLIO_ITEM_NOT_FOUND: { status: 404, description: '없거나 남의 포트폴리오 항목' },
  PORTFOLIO_LIMIT_REACHED: { status: 409, description: '포트폴리오 개수 한도' },
  PORTFOLIO_ORDER_MISMATCH: { status: 400, description: '순서 목록이 지금 포트폴리오 항목과 정확히 같지 않음(다른 곳에서 바뀜)' },
  CAREER_NOT_FOUND: { status: 404, description: '없거나 남의 경력' },
  CAREER_LIMIT_REACHED: { status: 409, description: '경력 개수 한도' },
  PAYOUT_ACCOUNT_LOCKED: { status: 409, description: '지급이 처리되는 중이라 계좌를 바꾸거나 지울 수 없음' },

  // -------------------------------------------------------------------------------------------
  // Projects and applications
  // -------------------------------------------------------------------------------------------
  PROJECT_NOT_FOUND: { status: 404, description: '없거나 삭제된 프로젝트' },
  PROJECT_TERMS_LOCKED: { status: 400, description: '지원이 있는 프로젝트의 예산·모집 일정을 바꾸려 함' },
  PROJECT_HAS_ACTIVE_CONTRACT: { status: 409, description: '진행 중이거나 서명 대기 중인 계약이 있어 삭제할 수 없음' },
  PROJECT_HAS_CONTRACT_RECORD: { status: 409, description: '계약 기록이 있어 삭제할 수 없음' },
  PROJECT_STATUS_TRANSITION_INVALID: { status: 400, description: '지금 상태에서 허용되지 않는 상태 변경' },
  REOPEN_BLOCKED_BY_CONTRACT: { status: 409, description: '취소되지 않은 계약이 있어 다시 모집할 수 없음' },
  PROJECT_NOT_ACCEPTING_APPLICATIONS: { status: 400, description: '모집 중이 아닌 프로젝트' },
  APPLICATION_NOT_FOUND: { status: 404, description: '없거나 이 프로젝트의 것이 아닌 지원' },
  APPLICATION_ALREADY_EXISTS: { status: 409, description: '이미 지원한 프로젝트(철회된 계약의 당사자 포함)' },
  APPLICATION_ALREADY_PROCESSED: { status: 409, description: '이미 수락·거절된 지원' },
  CONTRACT_ALREADY_EXISTS: { status: 409, description: '이 프로젝트에 이미 계약이 있음' },

  // -------------------------------------------------------------------------------------------
  // Contracts and milestones
  // -------------------------------------------------------------------------------------------
  CONTRACT_NOT_FOUND: { status: 404, description: '없거나 프로젝트가 삭제된 계약' },
  CONTRACT_CANCELLED: { status: 409, description: '철회된 계약' },
  CONTRACT_NOT_CANCELLABLE: { status: 409, description: '서명 대기 중인 계약만 철회할 수 있음' },
  CONTRACT_ALREADY_COMPLETED: { status: 400, description: '완료된 계약은 다시 서명할 수 없음' },
  CONTRACT_NOT_ACTIVE: { status: 400, description: '양측이 서명한 진행 중 계약이 아님' },
  CONTRACT_NOT_COMPLETED: { status: 400, description: '완료되지 않은 계약' },
  MANUAL_COMPLETION_REMOVED: { status: 410, description: '계약은 모든 마일스톤이 승인되면 자동으로 완료된다(수동 완료 없음)' },
  MILESTONE_NOT_FOUND: { status: 404, description: '없거나 프로젝트가 삭제된 마일스톤' },
  MILESTONE_PLAN_INVALID: { status: 400, description: '유효한 마일스톤 계획(금액 합계 = 계약 금액)이 없어 서명할 수 없음' },
  MILESTONE_PLAN_LOCKED: { status: 409, description: '계약이 시작되어 마일스톤 계획을 바꿀 수 없음' },
  MILESTONE_NOT_AWAITING_SUBMISSION: { status: 409, description: '결과물을 제출할 수 있는 상태가 아닌 마일스톤' },
  MILESTONE_NOT_AWAITING_REVIEW: { status: 409, description: '검수 대기 중이 아닌 마일스톤' },

  // -------------------------------------------------------------------------------------------
  // Payments
  // -------------------------------------------------------------------------------------------
  PAYMENT_NOT_FOUND: { status: 404, description: '없는 결제 주문' },
  EARLIER_MILESTONE_UNFUNDED: { status: 400, description: '앞 순서의 마일스톤이 아직 결제되지 않음' },
  MILESTONE_ALREADY_FUNDED: { status: 409, description: '이미 결제된 마일스톤' },
  MILESTONE_REFUNDED: { status: 409, description: '환불된 마일스톤이라 결제할 수 없음' },
  PAYMENT_ALREADY_PROCESSED: { status: 409, description: '이미 처리됐거나 다른 요청이 처리 중인 결제' },
  PAYMENT_AMOUNT_MISMATCH: { status: 400, description: '결제 금액이 주문 금액과 다름' },
  PAYMENT_VERIFICATION_FAILED: {
    status: 400,
    description: '결제 승인을 끝내지 못함 — 토스페이먼츠 승인 실패·금액 불일치, 또는 승인 뒤 처리 중의 다른 실패(알려진 버그 #3)',
  },
  PAYMENT_BYPASS_DISABLED: { status: 403, description: '이 환경에서는 개발용 결제 완료를 쓸 수 없음' },

  // -------------------------------------------------------------------------------------------
  // Reviews, settlements, notifications
  // -------------------------------------------------------------------------------------------
  REVIEWEE_INVALID: { status: 400, description: '리뷰 대상이 계약의 상대방이 아님' },
  REVIEW_ALREADY_EXISTS: { status: 409, description: '이미 리뷰한 계약' },
  SETTLEMENT_NOT_FOUND: { status: 404, description: '없는 정산' },
  NOTIFICATION_NOT_FOUND: { status: 404, description: '없거나 남의 알림' },

  // -------------------------------------------------------------------------------------------
  // Conversations
  // -------------------------------------------------------------------------------------------
  CONVERSATION_NOT_FOUND: { status: 404, description: '없거나 프로젝트가 삭제된 대화방' },
  CONVERSATION_CLOSED: { status: 409, description: '대화가 종료된 대화방' },
  COUNTERPART_INACTIVE: { status: 409, description: '상대방이 탈퇴함' },
  MESSAGE_NOT_FOUND: { status: 404, description: '없거나 이미 삭제된 메시지' },
  MESSAGE_DELETE_WINDOW_EXPIRED: { status: 409, description: '보낸 지 5분이 지나 삭제할 수 없는 메시지' },
} as const satisfies Record<string, ErrorCodeSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Every code, in table order. */
export const ALL_ERROR_CODES = Object.keys(ERROR_CODES) as ErrorCode[];

/**
 * Why a field failed validation — `fields[].code` of a `VALIDATION_FAILED`. `validate()` derives it
 * from the zod issue; a custom issue states it with `params: { fieldCode }` (`fieldIssue()` in
 * `src/schemas/common.ts`).
 */
export const FIELD_ERROR_CODES = [
  /** Missing or empty. */
  'REQUIRED',
  /** Wrong type, format or value. */
  'INVALID',
  /** Below the minimum — a number, a length, a count, or a date before today. */
  'TOO_SMALL',
  /** Above the maximum — a number, a length, a count, or a month after this one. */
  'TOO_LARGE',
  /** The same value twice in a list. */
  'NOT_UNIQUE',
  /** Does not fit another field or a neighbouring item (an end before its start, …). */
  'CONFLICT',
  /** Well-formed, but not allowed for this item (a locked notification channel, a deadline outside a reopen). */
  'NOT_ALLOWED',
] as const;

export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];

/** One field of a `VALIDATION_FAILED`: its dotted path (`milestones.2.amount`, `''` for the whole body) and why. */
export interface FieldViolation {
  path: string;
  code: FieldErrorCode;
}
