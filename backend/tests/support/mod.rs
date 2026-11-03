use sea_orm::{ConnectOptions, ConnectionTrait, Database, DatabaseConnection};
use sea_orm_migration::MigratorTrait;
use std::ops::Deref;
use uuid::Uuid;

/// 管理单个测试专属的真实数据库 schema，并在结束时尝试清理。
pub struct TestDatabase {
    connection: DatabaseConnection,
    admin_url: String,
    schema: String,
}

impl TestDatabase {
    /// 在测试准备阶段创建隔离 schema 并执行全部迁移。
    pub async fn migrated(prefix: &str) -> Self {
        Self::at_migration(prefix, None).await
    }

    /// 在迁移测试准备阶段创建隔离 schema，并升级到指定步数。
    pub async fn at_migration(prefix: &str, steps: Option<u32>) -> Self {
        let admin_url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL is required");
        let admin = Database::connect(&admin_url).await.unwrap();
        let schema = format!("{prefix}_{}", Uuid::new_v4().simple());
        // 每次使用独立 schema，避免并行测试修改彼此的数据或结构。
        admin
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let mut options = ConnectOptions::new(admin_url.clone());
        options.set_schema_search_path(schema.clone());
        let connection = Database::connect(options).await.unwrap();
        // 在设置 search_path 后迁移，确保表和约束落在当前测试的 schema 中。
        migration::Migrator::up(&connection, steps).await.unwrap();
        Self {
            connection,
            admin_url,
            schema,
        }
    }

    /// 在测试需要独立持有连接句柄时克隆连接池。
    pub fn connection(&self) -> DatabaseConnection {
        self.connection.clone()
    }
}

impl Deref for TestDatabase {
    /// 将测试数据库解引用为供查询使用的连接。
    type Target = DatabaseConnection;
    /// 在测试直接调用数据库操作时借用连接。
    fn deref(&self) -> &Self::Target {
        &self.connection
    }
}

impl Drop for TestDatabase {
    /// 测试结束时通过独立运行时尽力删除专属 schema。
    fn drop(&mut self) {
        let admin_url = self.admin_url.clone();
        let schema = self.schema.clone();
        // Drop 不能直接异步等待；独立线程创建运行时并等待清理结束，避免嵌套当前测试运行时。
        let _ = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            if let Ok(runtime) = runtime {
                // 清理仅针对本测试 schema；连接或删除失败时尽力退出，避免析构错误遮蔽原测试结果。
                runtime.block_on(async move {
                    if let Ok(admin) = Database::connect(admin_url).await {
                        let _ = admin
                            .execute_unprepared(&format!("DROP SCHEMA IF EXISTS {schema} CASCADE"))
                            .await;
                    }
                });
            }
        })
        .join();
    }
}
