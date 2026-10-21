# WorkBridge - 프리랜서 매칭 플랫폼

의뢰인과 프리랜서를 연결하는 중개 플랫폼입니다. 프로젝트 탐색과 지원, AI 단가 분석, 계약 체결부터 마일스톤 단위의 결제·산출물 제출·검수(반려와 7일 뒤 자동 승인), 수수료를 뗀 주간 정산과 지급 계좌, 계약별 대화방(첨부, 읽음 표시), 포트폴리오·경력과 스킬 기반 추천, 알림 종류별 인앱·이메일 설정까지 외주 프로세스 전체를 다룹니다. 자동 승인·정산·이메일은 Postgres 기반 작업 큐가 처리하고, 이메일은 아직 로그로만 남깁니다.

## 실행 방법

### 1. 서버

```bash
cd workbridge-server
npm install
cp .env.example .env  # 환경변수 설정 (docs/ENV.md 참고)
npx prisma migrate dev --name init
npm run dev
```

서버가 `http://localhost:4000`에서 실행됩니다.

### 2. 클라이언트

```bash
cd workbridge-client
npm install
cp .env.example .env.local  # 환경변수 설정 (docs/ENV.md 참고)
npm run dev
```

클라이언트가 `http://localhost:3000`에서 실행됩니다.

### 3. 시드 데이터 (선택)

```bash
cd workbridge-server
npx prisma db seed
```

시드 데이터 상세 내용은 [docs/SEED_DATA.md](docs/SEED_DATA.md)를 참고하세요.

## 문서

| 문서 | 설명 |
| --- | --- |
| [docs/BEHAVIOR.md](docs/BEHAVIOR.md) | API 동작 명세 (영문, 테스트의 기준) |
| [docs/API.md](docs/API.md) | API 엔드포인트 목록 |
| [docs/DATABASE.md](docs/DATABASE.md) | 데이터베이스 모델과 불변식 |
| [docs/ENV.md](docs/ENV.md) | 환경변수 및 외부 서비스 설정 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Vercel 배포 가이드와 운영 환경의 한계 |
| [docs/SEED_DATA.md](docs/SEED_DATA.md) | 시드 데이터 상세 |
