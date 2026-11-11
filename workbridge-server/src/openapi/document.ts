import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';

import { buildRegistry } from './registry';

/** Tag order and descriptions — the sidebar of `/api/docs`. */
const TAGS = [
  { name: 'Auth', description: '가입, 로그인, 토큰 갱신, 구글 OAuth' },
  { name: 'Users', description: '내 프로필과 공개 프로필, 내 지원·북마크·프로젝트' },
  { name: 'Account', description: '회원 탈퇴(비밀번호 변경은 Auth)' },
  { name: 'Portfolio & careers', description: '프리랜서의 포트폴리오와 경력' },
  { name: 'Payout account', description: '프리랜서의 정산 지급 계좌' },
  { name: 'Projects', description: '프로젝트 등록·탐색·북마크' },
  { name: 'Applications', description: '지원과 수락·거절(수락하면 계약이 생긴다)' },
  { name: 'Recommendations', description: '기술 기반 추천' },
  { name: 'Contracts', description: '계약 조회와 서명' },
  { name: 'Milestones', description: '마일스톤 계획, 결과물 제출, 승인·수정 요청' },
  { name: 'Payments', description: '마일스톤 결제(토스페이먼츠)' },
  { name: 'Settlements', description: '프리랜서 주간 정산' },
  { name: 'Reviews', description: '완료된 계약의 상호 리뷰' },
  { name: 'Notifications', description: '인앱 알림과 채널 설정' },
  { name: 'Conversations', description: '계약별 대화방과 메시지' },
  { name: 'Internal', description: '운영용. JWT가 아닌 `X-Internal-Token`으로 지킨다' },
  { name: 'System', description: '헬스 체크' },
];

const DESCRIPTION = [
  'WorkBridge(프리랜서 매칭 플랫폼) 서버 API. 이 문서는 요청 검증에 쓰는 zod 스키마(`src/schemas/`)와',
  '`src/openapi/`의 응답 스키마에서 생성된다(`npm run openapi`).',
  '',
  '- 오류는 언제나 `{ "error": { "code": "…", "message": "…" } }`다. **분기는 `code`로 한다** — `message`는 개발자용 영어 문장이라 바뀔 수 있다. '
    + '코드의 뜻은 `ErrorCode` 스키마, 경로마다 내는 코드는 그 경로의 응답에 있다.',
  '- 요청 값이 틀리면 400 `VALIDATION_FAILED`이고 `fields`(`[{ path, code }]`)에 원인 필드를 준다. 지금은 첫 번째 오류 하나다. '
    + '요청 스키마 검사에서 난 것은 `message`가 `<필드>: <메시지>`다.',
  '- `Content-Type: application/json` 본문이 JSON으로 읽히지 않으면 경로와 상관없이 인증·검증보다 먼저 400 `MALFORMED_BODY`다. '
    + '본문이 너무 크면 413 `PAYLOAD_TOO_LARGE`, 일치하는 경로가 없으면 404 `ROUTE_NOT_FOUND`다.',
  '- 금액은 원 단위 정수, 시각은 ISO 8601(UTC)이다. 날짜 계산은 KST(UTC+9)로 한다.',
  '- 문서에 없는 500은 서버 버그다.',
].join('\n');

/** The OpenAPI 3.1 document of the whole API. Pure: no database, no environment variables. */
export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(buildRegistry().definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'WorkBridge API',
      version: '1.0.0',
      description: DESCRIPTION,
    },
    servers: [{ url: '/', description: '이 서버' }],
    tags: TAGS,
  });
}
