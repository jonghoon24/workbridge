# WorkBridge - 프리랜서 매칭 플랫폼

의뢰인과 프리랜서를 연결하는 중개 플랫폼입니다. 프로젝트 탐색부터 계약 체결, AI 단가 분석, 대금 결제까지 전체 외주 프로세스를 관리합니다.

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
| [docs/API.md](docs/API.md) | API 엔드포인트 목록 |
| [docs/DATABASE.md](docs/DATABASE.md) | 데이터베이스 모델 |
| [docs/ENV.md](docs/ENV.md) | 환경변수 및 외부 서비스 설정 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Vercel 배포 가이드 |
| [docs/SEED_DATA.md](docs/SEED_DATA.md) | 시드 데이터 상세 |
