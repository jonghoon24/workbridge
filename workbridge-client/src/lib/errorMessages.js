// 서버 오류 응답({ error: { message } })을 사용자에게 보여 줄 한국어 문구로 바꾸는 공용 변환.
// 서버 문구는 영어이고 docs/BEHAVIOR.md와 서버 테스트에 묶여 있으므로 서버는 그대로 두고 여기서
// 바꾼다. 오류를 화면에 보여 주는 곳은 모두 toUserMessage()를 거친다 — 영어 문구를 그대로
// 보여 주지 않는다.
//
// 판단 순서
// 1. 응답이 없으면(네트워크 끊김, 시간 초과) 연결 안내
// 2. overrides.status[상태 코드]
// 3. 서버 문구: overrides.messages → 공용 표(MESSAGES) → overrides.patterns → 공용 패턴(PATTERNS)
//    → overrides.rewrite. `<필드>: ` 접두어(zod 검증 오류)는 떼고도 비교한다.
// 4. 서버가 이미 한국어로 보낸 문구는 그대로
// 5. 429·413·5xx는 상태 코드별 기본 문구, 그 밖에는 화면이 넘긴 fallback, 없으면 상태 코드별 기본 문구
//
// 서버에 새 AppError 문구를 추가하면 여기 표에도 넣는다(workbridge-server/src의 AppError,
// zod 스키마 src/schemas, 업로드 미들웨어, 레이트 리밋).

const FIELD_PREFIX = /^[A-Za-z.0-9]+: /;
const HANGUL = /[가-힣]/;

const RELOGIN = '로그인이 만료되었습니다. 다시 로그인해 주세요.';
const REFRESH = '이미 처리되었거나 상태가 바뀌었습니다. 새로고침한 뒤 다시 확인해 주세요.';

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

// 서버 문구 전체(또는 필드 접두어를 뗀 문구) → 한국어
const MESSAGES = {
  // 인증·계정
  'Invalid credentials': '이메일 또는 비밀번호가 올바르지 않습니다.',
  'Email and password are required': '이메일과 비밀번호를 입력해 주세요.',
  'All fields are required': '필수 항목을 모두 입력해 주세요.',
  'Email already in use': '이미 가입된 이메일입니다. 로그인하거나 다른 이메일을 사용해 주세요.',
  'Role must be CLIENT or FREELANCER': '역할을 선택해 주세요.',
  'Role has already been selected': '이미 역할을 선택했습니다.',
  'Authentication required': '로그인이 필요합니다.',
  'Invalid or expired token': RELOGIN,
  'Invalid or expired refresh token': RELOGIN,
  'Refresh token not found': RELOGIN,
  'User not found': '회원 정보를 찾을 수 없습니다.',
  'Account is no longer active': '더 이상 사용할 수 없는 계정입니다.',
  'Insufficient permissions': '이 기능을 사용할 권한이 없습니다.',
  'Not authorized': '이 작업을 할 권한이 없습니다.',
  'Too many requests. Try again later.': STATUS_DEFAULTS[429],
  '프로필을 먼저 완성해주세요': '프로필을 먼저 완성해 주세요.',

  // 프로젝트
  'Project not found': '프로젝트를 찾을 수 없습니다. 삭제되었을 수 있습니다.',
  'Only clients can view their projects': '의뢰인 회원만 볼 수 있는 화면입니다.',
  'Only freelancers can view their bookmarks': '북마크는 프리랜서 회원만 사용할 수 있습니다.',
  'Only freelancers can view their applications': '지원 현황은 프리랜서 회원만 볼 수 있습니다.',
  'recruitmentStartDate cannot be after deadline': '모집 시작일은 마감일보다 늦을 수 없습니다.',
  'Cannot change budget or recruitment dates after applications have been submitted':
    '지원자가 있는 프로젝트는 예산과 모집 기간을 바꿀 수 없습니다.',
  'limit must be a positive integer': '목록 조건이 올바르지 않습니다.',
  'AI analysis did not return a response': 'AI 분석 결과를 받지 못했습니다. 잠시 후 다시 시도해 주세요.',
  'AI analysis did not return valid feature pricing': 'AI 분석 결과를 받지 못했습니다. 잠시 후 다시 시도해 주세요.',

  // 지원
  'You have already applied to this project': '이미 지원한 프로젝트입니다. 내 지원 현황에서 확인할 수 있습니다.',
  'Project is not accepting applications': '지금은 지원을 받지 않는 프로젝트입니다.',
  'Project deadline has passed': '모집 마감일이 지난 프로젝트입니다.',
  'Application not found': '지원 내역을 찾을 수 없습니다.',
  'This application has already been processed': '이미 처리된 지원입니다. 새로고침한 뒤 다시 확인해 주세요.',
  'A contract already exists for this project': '이 프로젝트에는 이미 계약이 있습니다.',

  // 프로젝트·지원·결제 요청 검증(zod). 본문 오류는 `<필드>: <문장>`이라 접두어를 뗀 문장으로
  // 매핑한다. 목록 쿼리 오류(`page: must be an integer`)는 문구가 필드마다 같아서 접두어까지 포함한
  // 전체 문구로 매핑한다.
  'Project title is required': '프로젝트명을 입력해 주세요.',
  'Project title must be a string': '프로젝트명을 다시 입력해 주세요.',
  'Project description is required': '프로젝트 설명을 입력해 주세요.',
  'Project description must be a string': '프로젝트 설명을 다시 입력해 주세요.',
  'Category is required': '카테고리를 선택해 주세요.',
  'Category must be a string': '카테고리를 다시 선택해 주세요.',
  'Budget is required': '예산을 입력해 주세요.',
  'Budget must be a non-negative whole number of won': '예산은 0원 이상의 원 단위 정수로 입력해 주세요.',
  'Deadline is required': '마감일을 선택해 주세요.',
  'Deadline must be a valid date': '마감일을 다시 선택해 주세요.',
  'Recruitment start date must be a valid date': '모집 시작일을 다시 선택해 주세요.',
  'Required skills must be a string or a list of strings': '필요 기술을 다시 선택해 주세요.',
  'Project status is required': '바꿀 프로젝트 상태를 선택해 주세요.',
  'Project status must be one of UPCOMING, OPEN, IN_PROGRESS, COMPLETED, CANCELLED, CLOSED':
    '바꿀 프로젝트 상태가 올바르지 않습니다.',
  'Cover letter is required': '지원서를 입력해 주세요.',
  'Cover letter must be a string': '지원서를 다시 입력해 주세요.',
  'Expected rate is required': '제안 금액을 입력해 주세요.',
  'Expected rate must be a positive whole number of won': '제안 금액은 1원 이상의 원 단위 정수로 입력해 주세요.',
  'Expected duration is required': '예상 기간을 입력해 주세요.',
  'Expected duration must be a string': '예상 기간을 다시 입력해 주세요.',
  'Status is required': '처리 방법을 선택해 주세요.',
  'Status must be one of ACCEPTED, REJECTED': '처리 방법이 올바르지 않습니다.',
  'Milestone ID is required': '결제할 마일스톤 정보가 없습니다.',
  'Milestone ID must be a string': '결제할 마일스톤 정보가 올바르지 않습니다.',
  'Payment key is required': '결제 정보가 올바르지 않습니다. 결제를 다시 진행해 주세요.',
  'Order ID is required': '결제 정보가 올바르지 않습니다. 결제를 다시 진행해 주세요.',
  'Amount is required': '결제 정보가 올바르지 않습니다. 결제를 다시 진행해 주세요.',
  'Amount must be a positive whole number of won': '결제 금액이 올바르지 않습니다.',
  'minBudget: must be a number': '최소 예산은 숫자로 입력해 주세요.',
  'minBudget: must be at least 0': '최소 예산은 0원 이상으로 입력해 주세요.',
  'maxBudget: must be a number': '최대 예산은 숫자로 입력해 주세요.',
  'maxBudget: must be at least 0': '최대 예산은 0원 이상으로 입력해 주세요.',
  'minBudget: must not be greater than maxBudget': '최소 예산이 최대 예산보다 클 수 없습니다.',
  'sort: must be one of latest, deadline, budget': '정렬 조건이 올바르지 않습니다.',
  'status: must be one of ALL, UPCOMING, OPEN, CLOSED': '프로젝트 상태 조건이 올바르지 않습니다.',
  'skills: must be a string or a list of strings': '기술 조건이 올바르지 않습니다.',
  ...Object.fromEntries(
    [
      'page: must be an integer',
      'page: must be at least 1',
      'page: must be at most 1000000',
      'limit: must be an integer',
      'limit: must be at least 1',
      ...['page', 'limit', 'sort', 'status', 'search', 'category', 'minBudget', 'maxBudget'].map(
        (field) => `${field}: must be a single value`,
      ),
    ].map((message) => [message, '목록 조건이 올바르지 않습니다. 필터를 다시 선택해 주세요.']),
  ),

  // 계약·마일스톤 계획
  'Contract not found': '계약을 찾을 수 없습니다.',
  'Cannot sign a contract without a valid milestone plan':
    '마일스톤 계획의 금액 합계가 계약 금액과 같아야 서명할 수 있습니다.',
  'A completed contract cannot be signed again': '완료된 계약은 다시 서명할 수 없습니다.',
  'Contracts are completed automatically when every milestone is approved':
    '계약은 모든 마일스톤이 승인되면 자동으로 완료됩니다.',
  'Milestone plan is locked once the contract is active': '계약이 시작된 뒤에는 마일스톤 계획을 바꿀 수 없습니다.',
  'Amount must be a whole number of won': '금액은 원 단위 정수로 입력해 주세요.',
  'Due date must be a YYYY-MM-DD date': '기한을 선택해 주세요.',
  'Due date cannot be in the past': '기한은 오늘 이후로 선택해 주세요.',
  'Due dates must not decrease': '기한은 앞 마일스톤보다 빠를 수 없습니다.',

  // 결제
  'Payment verification failed': '결제 승인에 실패했습니다. 결제 내역을 확인한 뒤 다시 시도해 주세요.',
  'Payment not found': '결제 정보를 찾을 수 없습니다.',
  'Payment has already been processed': '이미 처리된 결제입니다.',
  'Payment already completed for this milestone': '이미 결제가 끝난 마일스톤입니다.',
  'Payment cannot be created for this milestone': '이 마일스톤은 지금 결제할 수 없습니다.',
  'Payment cannot be completed for a refunded milestone': '환불된 마일스톤은 결제를 완료할 수 없습니다.',
  'Payment amount does not match the contract amount': '결제 금액이 마일스톤 금액과 다릅니다.',
  'Payment bypass is disabled': '이 환경에서는 개발용 결제 완료를 사용할 수 없습니다.',
  'Milestone not found': '마일스톤을 찾을 수 없습니다.',
  'Milestone is already funded': '이미 결제된 마일스톤입니다.',
  'Earlier milestones must be funded first': '앞 순서의 마일스톤부터 결제해 주세요.',
  'Contract must be active to proceed with payment': '양측이 서명해 계약이 시작된 뒤에 결제할 수 있습니다.',

  // 결과물 제출·검수
  'Milestone is not awaiting a submission': '지금은 결과물을 제출할 수 없는 마일스톤입니다. 새로고침한 뒤 다시 확인해 주세요.',
  'Milestone is not awaiting review': '검수 대기 중인 마일스톤이 아닙니다. 새로고침한 뒤 다시 확인해 주세요.',
  'Message is required': '내용을 입력해 주세요.',
  'Message must be at most 5000 characters': '내용은 5,000자 이하로 입력해 주세요.',
  'At most 5 links are allowed': '링크는 최대 5개까지 넣을 수 있습니다.',
  'Links must be http or https URLs': '링크는 http:// 또는 https://로 시작하는 주소여야 합니다.',
  'Reason must be at least 10 characters': '수정 요청 사항을 10자 이상 입력해 주세요.',
  'Reason must be at most 2000 characters': '수정 요청 사항은 2,000자 이하로 입력해 주세요.',

  // 리뷰
  'You have already reviewed this contract': '이미 리뷰를 작성한 계약입니다.',
  'Reviews can only be written after project completion': '계약이 완료된 뒤에 리뷰를 작성할 수 있습니다.',
  'Rating must be between 1 and 5': '별점은 1점에서 5점 사이로 선택해 주세요.',
  'Invalid reviewee': '리뷰 대상이 올바르지 않습니다.',

  // 정산·지급 계좌
  'Settlement not found': '정산 내역을 찾을 수 없습니다.',
  'Account holder must match your name': '예금주가 회원 이름과 같아야 합니다. 본인 명의 계좌만 등록할 수 있습니다.',
  'Account holder is required': '예금주를 입력해 주세요.',
  'Account number must be 10 to 14 digits': '계좌번호는 숫자 10~14자리로 입력해 주세요.',
  'Unknown bank code': '은행을 선택해 주세요.',
  'Payout account cannot be changed while a payout is processing':
    '지급이 처리되는 중에는 계좌를 바꾸거나 삭제할 수 없습니다. 잠시 후 다시 시도해 주세요.',

  // 알림
  'Notification not found': '알림을 찾을 수 없습니다.',

  // 메시지
  'Conversation not found': '대화방을 찾을 수 없습니다.',
  'Message not found': '메시지를 찾을 수 없습니다.',
  'Messages can only be deleted within 5 minutes': '보낸 지 5분이 지난 메시지는 삭제할 수 없습니다.',
  'Message or attachment is required': '메시지를 입력하거나 파일을 첨부해 주세요.',
  'This conversation is closed': '대화가 종료된 대화방입니다. 이전 메시지는 계속 볼 수 있습니다.',
  'The other participant is no longer active': '상대방이 탈퇴하여 더 이상 메시지를 보낼 수 없습니다.',
  'Use either before or after, not both': '메시지 목록 조건이 올바르지 않습니다.',

  // 포트폴리오·경력·프로필
  'Portfolio is limited to 20 items': '포트폴리오는 최대 20개까지 등록할 수 있습니다.',
  'Careers are limited to 30 entries': '경력은 최대 30개까지 등록할 수 있습니다.',
  'Must list each of your portfolio items exactly once': '다른 곳에서 포트폴리오가 바뀌었습니다. 새로고침한 뒤 다시 시도해 주세요.',
  'Portfolio item not found': '이미 삭제된 포트폴리오입니다.',
  'Career not found': '이미 삭제된 경력입니다.',
  'Title is required': '제목을 입력해 주세요.',
  'Title must be at most 100 characters': '제목은 100자 이하로 입력해 주세요.',
  'Description must be at most 2000 characters': '설명은 2,000자 이하로 입력해 주세요.',
  'URL must be an http or https URL': '링크는 http:// 또는 https://로 시작하는 주소여야 합니다.',
  'Role must be at most 100 characters': '역할은 100자 이하로 입력해 주세요.',
  'At most 10 skills are allowed': '기술은 최대 10개까지 선택할 수 있습니다.',
  'Each skill must be at most 50 characters': '기술 이름은 50자 이하여야 합니다.',
  'Skills must be strings': '기술을 다시 선택해 주세요.',
  'Month must be a YYYY-MM month': '연월 형식이 올바르지 않습니다.',
  'Month cannot be in the future': '이번 달 이후는 선택할 수 없습니다.',
  'End month must not be before start month': '종료 월은 시작 월보다 빠를 수 없습니다.',
  'Start month is required with an end month': '종료 월을 입력하려면 시작 월도 입력해 주세요.',
  'Company is required': '회사명을 입력해 주세요.',
  'Company must be at most 100 characters': '회사명은 100자 이하로 입력해 주세요.',
  'Position is required': '직책을 입력해 주세요.',
  'Position must be at most 100 characters': '직책은 100자 이하로 입력해 주세요.',
  'Cannot upload and remove an image at once': '이미지 교체와 삭제를 동시에 할 수 없습니다.',

  // 업로드
  'File upload failed': '파일 업로드에 실패했습니다. 잠시 후 다시 시도해 주세요.',
  'Malformed multipart body': '파일을 읽지 못했습니다. 다시 첨부해 주세요.',
  'Only image files are allowed': '이미지 파일만 올릴 수 있습니다.',
  'File too large': '파일이 너무 큽니다. 크기를 줄여 다시 올려 주세요.',
  'request entity too large': STATUS_DEFAULTS[413],
  'Request Entity Too Large': STATUS_DEFAULTS[413],
};

// 값이 들어간 서버 문구. 두 번째 칸은 문자열이나 (정규식 매치) => 문자열.
const PATTERNS = [
  [/^Unsupported file type/, '지원하지 않는 파일 형식입니다. 이미지, PDF, ZIP, 텍스트, 오피스 문서, HWP만 올릴 수 있습니다.'],
  [/^Too many files \(max (\d+)\)$/, (m) => `파일은 최대 ${m[1]}개까지 첨부할 수 있습니다.`],
  [/^File too large \(max (\d+)MB\)$/, (m) => `파일은 개당 ${m[1]}MB 이하여야 합니다.`],
  [
    /^Milestone amounts must add up to the contract amount \((\d+)\)$/,
    (m) => `마일스톤 금액의 합계가 계약 금액(${Number(m[1]).toLocaleString('ko-KR')}원)과 같아야 합니다.`,
  ],
  [/^Cannot transition from /, '지금 상태에서는 이 작업을 할 수 없습니다. 새로고침한 뒤 다시 확인해 주세요.'],
  [/must be a valid date$/, '날짜를 다시 선택해 주세요.'],
  [/must be a (positive integer|non-negative number)$/, '숫자를 올바르게 입력해 주세요.'],
  [/Message not found in this conversation$/, '메시지를 찾을 수 없습니다. 새로고침해 주세요.'],
];

function applyPattern(patterns, text) {
  for (const [pattern, replacement] of patterns) {
    const match = pattern.exec(text);
    if (match) return typeof replacement === 'function' ? replacement(match) : replacement;
  }
  return null;
}

/** 서버 문구 하나를 한국어로. 표에 없으면 null. */
export function translateServerMessage(message, { messages = {}, patterns = [] } = {}) {
  if (!message) return null;
  const bare = message.replace(FIELD_PREFIX, '');
  return (
    messages[message] ??
    messages[bare] ??
    MESSAGES[message] ??
    MESSAGES[bare] ??
    applyPattern(patterns, bare) ??
    applyPattern(PATTERNS, bare) ??
    null
  );
}

function statusDefault(code) {
  if (code >= 500) return SERVER_ERROR;
  return STATUS_DEFAULTS[code] || null;
}

/**
 * Axios 오류를 화면에 보여 줄 한국어 문구로 바꾼다.
 *
 * overrides
 * - status: { 413: '…' }               상태 코드로 가장 먼저 판단한다(화면마다 다른 안내).
 * - messages: { 'Server message': '…' } 공용 표보다 먼저 비교한다.
 * - patterns: [[/정규식/, '…']]
 * - rewrite: (message) => '…' | null   위에서 못 바꾼 문구를 화면이 직접 고친다.
 */
export function toUserMessage(err, fallback, overrides = {}) {
  const { status = {}, messages, patterns, rewrite } = overrides;
  const response = err?.response;
  if (!response) return err?.request || err?.code === 'ECONNABORTED' ? NETWORK_ERROR : fallback || SERVER_ERROR;

  const code = response.status;
  if (code && status[code]) return status[code];

  const message = response.data?.error?.message;
  const translated = translateServerMessage(message, { messages, patterns }) ?? rewrite?.(message) ?? null;
  if (translated) return translated;
  if (message && HANGUL.test(message)) return message;

  if (code === 429 || code === 413 || code >= 500) return statusDefault(code);
  return fallback || statusDefault(code) || SERVER_ERROR;
}
