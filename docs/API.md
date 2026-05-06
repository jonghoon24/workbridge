# API 엔드포인트

## 인증

| Method | Endpoint | 설명 |
| --- | --- | --- |
| POST | `/api/auth/signup` | 회원가입 |
| POST | `/api/auth/login` | 로그인 |
| POST | `/api/auth/logout` | 로그아웃 |
| POST | `/api/auth/refresh` | 토큰 갱신 |
| POST | `/api/auth/select-role` | OAuth 최초 로그인 역할 선택 |
| GET | `/api/auth/google` | Google OAuth 시작 |
| GET | `/api/auth/google/callback` | Google OAuth 콜백 |

## 사용자

| Method | Endpoint | 설명 |
| --- | --- | --- |
| GET | `/api/users/me` | 내 프로필 조회 |
| PATCH | `/api/users/me` | 내 프로필 수정 (multipart) |
| GET | `/api/users/me/applications` | 내 지원 목록 (프리랜서) |
| GET | `/api/users/me/projects` | 내 프로젝트 목록 (의뢰인) |
| GET | `/api/users/:id` | 공개 프로필 조회 |

## 프로젝트

| Method | Endpoint | 설명 |
| --- | --- | --- |
| GET | `/api/projects` | 프로젝트 목록 (검색/필터/정렬/페이징) |
| POST | `/api/projects` | 프로젝트 등록 (의뢰인) |
| GET | `/api/projects/:id` | 프로젝트 상세 |
| PATCH | `/api/projects/:id` | 프로젝트 수정 |
| DELETE | `/api/projects/:id` | 프로젝트 삭제 (소프트 딜리트) |
| PATCH | `/api/projects/:id/status` | 상태 변경 |
| POST | `/api/projects/:id/analyze` | AI 단가 분석 |

## 지원

| Method | Endpoint | 설명 |
| --- | --- | --- |
| POST | `/api/projects/:id/applications` | 프로젝트 지원 (프리랜서) |
| GET | `/api/projects/:id/applications` | 지원자 목록 (의뢰인) |
| PATCH | `/api/projects/:projectId/applications/:appId` | 지원 수락/거절 |

## 계약 & 결제

| Method | Endpoint | 설명 |
| --- | --- | --- |
| GET | `/api/contracts/:id` | 계약서 조회 |
| POST | `/api/contracts/:id/sign` | 계약서 서명 |
| POST | `/api/payments` | 결제 생성 |
| POST | `/api/payments/confirm` | 결제 승인 (토스 검증) |
| GET | `/api/payments` | 결제 내역 |

## 리뷰

| Method | Endpoint | 설명 |
| --- | --- | --- |
| POST | `/api/reviews` | 리뷰 작성 |
| GET | `/api/users/:id/reviews` | 사용자 리뷰 조회 |
