-- Run only when no Movie Harbor test process is active. This intentionally matches only the
-- per-suite prefixes created by this repository; it never drops arbitrary non-project schemas.
-- 仅在没有本项目测试进程运行时手动执行；按仓库测试前缀清理独立 schema，避免误删其他项目数据。
DO $cleanup$
DECLARE
    schema_name text;
BEGIN
    FOR schema_name IN
        SELECT nspname
        FROM pg_namespace
        WHERE nspname ~ '^(auth_test|auth_no_store|catalog_[a-z0-9_]+|genres_test|media_cleanup_test|media_upload_test|migration_test|movies_test|series_test)_[0-9a-f]{32}$'
    LOOP
        EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', schema_name);
    END LOOP;
END
$cleanup$;
