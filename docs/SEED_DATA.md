# 시드 데이터

```bash
cd workbridge-server
npx prisma db seed
# 또는
npm run db:seed
```

시드 실행 시 아래 데이터가 생성됩니다. **모든 계정의 비밀번호는 `password123`입니다.**

## 사용자 (8명)

| 이메일 | 이름 | 역할 | 비고 |
| --- | --- | --- | --- |
| kim@example.com | 김서준 | 의뢰인 | 넥스트랩 (IT/소프트웨어) |
| lee@example.com | 이수현 | 의뢰인 | 브릿지마케팅 (마케팅/광고) |
| choi@example.com | 최민호 | 의뢰인 | 에듀플러스 (교육/에듀테크) |
| park@example.com | 박지윤 | 프리랜서 | 풀스택 5년, React/Node.js |
| jung@example.com | 정하은 | 프리랜서 | 디자인엔지니어 4년, Figma/React |
| han@example.com | 한도윤 | 프리랜서 | 백엔드 7년, Java/Spring/Docker |
| yoon@example.com | 윤서아 | 프리랜서 | 모바일 3년, React Native/Flutter |
| song@example.com | 송민재 | 프리랜서 | AI/ML 6년, Python/TensorFlow |

## 프로젝트 (8개)

| 프로젝트 | 의뢰인 | 상태 | 예산 |
| --- | --- | --- | --- |
| AI 기반 고객 상담 챗봇 개발 | 김서준 | OPEN | 800만원 |
| 반응형 기업 홈페이지 리뉴얼 | 이수현 | OPEN | 500만원 |
| 온라인 강의 플랫폼 MVP 개발 | 최민호 | OPEN | 1,500만원 |
| 헬스케어 모바일 앱 개발 | 김서준 | OPEN | 1,200만원 |
| 소셜 미디어 대시보드 개발 | 이수현 | OPEN | 700만원 |
| 브랜드 아이덴티티 디자인 | 김서준 | OPEN | 300만원 |
| 사내 ERP 시스템 API 개발 | 이수현 | COMPLETED | 1,000만원 |
| 이커머스 관리자 페이지 개발 | 최민호 | IN_PROGRESS | 600만원 |

## 기타 데이터

- **지원 11건** — OPEN 프로젝트에 프리랜서들이 지원한 상태
- **계약 2건** — 완료 프로젝트(한도윤), 진행중 프로젝트(박지윤)
- **결제 2건** — 양쪽 모두 COMPLETED 상태
- **리뷰 2건** — 완료 프로젝트에서 의뢰인↔프리랜서 상호 평가
- **AI 분석 1건** — AI 챗봇 프로젝트 단가 분석 결과
