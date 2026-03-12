# 데이터베이스 모델

- **User** — 사용자 (의뢰인/프리랜서)
- **Project** — 프로젝트 (OPEN → IN_PROGRESS → COMPLETED)
- **Application** — 지원서 (PENDING → ACCEPTED/REJECTED)
- **Contract** — 계약서 (PENDING → ACTIVE → COMPLETED)
- **Payment** — 결제 (PENDING → COMPLETED/FAILED/REFUNDED)
- **Review** — 리뷰 (별점 1-5, 태그)
- **PricingAnalysis** — AI 단가 분석 결과

상세 스키마는 `workbridge-server/prisma/schema.prisma`를 참고하세요.
