//! 媒体写事务与启动恢复共用的 PostgreSQL 事务锁。
use super::MediaError;
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, DatabaseTransaction, DbErr,
    IsolationLevel, Statement, TransactionTrait,
};

/// 固定的 Movie Harbor 媒体恢复命名空间，与实际资产表 OID 共同标识同一组媒体事务。
const MEDIA_LOCK_NAMESPACE: i32 = i32::from_be_bytes(*b"MHMR");

/// 为媒体变更或启动恢复开启事务，在同一连接取得事务锁，直到提交或回滚才释放。
pub(crate) async fn begin(db: &DatabaseConnection) -> Result<DatabaseTransaction, DbErr> {
    // 部署使用单个活动 API。涉及文件的调用方先持有进程内媒体锁，再取数据库锁，最后取行锁；
    // 仅操作数据库的调用方跳过文件锁。新实例必须等旧实例留下的数据库事务结束才能恢复。
    let tx = db
        .begin_with_config(Some(IsolationLevel::ReadCommitted), None)
        .await?;
    // regclass 在本事务连接的 search_path 中解析。锁后的查询另发 SQL，READ COMMITTED
    // 因而从取得锁后的新快照读取资产登记和内容引用，不会沿用等待前的数据库状态。
    tx.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT pg_advisory_xact_lock($1, 'media_asset'::regclass::int)",
        [MEDIA_LOCK_NAMESPACE.into()],
    ))
    .await?;
    Ok(tx)
}

/// 启动恢复先取得新版事务锁，再等待升级前已写过资产表的旧事务结束。
pub(crate) async fn begin_recovery(db: &DatabaseConnection) -> Result<DatabaseTransaction, DbErr> {
    let tx = begin(db).await?;
    // 旧版未申请 advisory 锁，但在写 media_asset 时已取得 ROW EXCLUSIVE；
    // 同一连接上的 SHARE 锁返回后，恢复查询的新快照才能反映这些事务的最终结果。
    // 表名固定取自后端实体映射，与上方 regclass 使用同一 search_path。
    tx.execute_unprepared(r#"LOCK TABLE "media_asset" IN SHARE MODE"#)
        .await?;
    Ok(tx)
}

/// 交还恢复结果前显式结束数据库事务，文件或凭证校验失败时也须等表锁释放。
pub(crate) async fn finish_recovery(
    tx: DatabaseTransaction,
    result: Result<(), MediaError>,
) -> Result<(), MediaError> {
    match result {
        Ok(()) => Ok(tx.commit().await?),
        Err(error) => {
            tx.rollback().await?;
            Err(error)
        }
    }
}
