-- Supabase는 `public` 스키마를 Data API(PostgREST)로 공개한다. RLS가 꺼진 테이블은 프로젝트 URL과
-- anon(publishable) 키만 있으면 누구나 읽고 쓸 수 있다. 앱은 Data API를 쓰지 않고 Prisma가 테이블
-- 소유자로 접속하므로(소유자는 RLS를 우회한다) 정책 없이 RLS만 켠다: anon·authenticated 역할은
-- 아무 행도 보지 못하고, 앱 동작은 그대로다. `_prisma_migrations`를 포함해 이 스키마의 모든 테이블에 건다.
-- 접속 역할이 소유하지 않은 테이블(확장이 만든 테이블 등)은 ALTER할 수 없어 마이그레이션 전체가 실패하므로
-- 건너뛰고 NOTICE만 남긴다.
-- 이후 새 테이블은 그 테이블을 만드는 마이그레이션에서 켠다(docs/DATABASE.md "행 단위 보안").
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT tablename, tableowner FROM pg_tables WHERE schemaname = current_schema()
  LOOP
    IF t.tableowner <> current_user THEN
      RAISE NOTICE 'skip RLS on %.% (owner %)', current_schema(), t.tablename, t.tableowner;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', current_schema(), t.tablename);
  END LOOP;
END
$$;
