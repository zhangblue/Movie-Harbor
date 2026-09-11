use sea_orm::{ConnectOptions, ConnectionTrait, Database, DatabaseConnection};
use sea_orm_migration::MigratorTrait;
use std::ops::Deref;
use uuid::Uuid;

pub struct TestDatabase {
    connection: DatabaseConnection,
    admin_url: String,
    schema: String,
}

impl TestDatabase {
    pub async fn migrated(prefix: &str) -> Self {
        let admin_url = std::env::var("TEST_DATABASE_URL").expect("TEST_DATABASE_URL is required");
        let admin = Database::connect(&admin_url).await.unwrap();
        let schema = format!("{prefix}_{}", Uuid::new_v4().simple());
        admin
            .execute_unprepared(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        let mut options = ConnectOptions::new(admin_url.clone());
        options.set_schema_search_path(schema.clone());
        let connection = Database::connect(options).await.unwrap();
        migration::Migrator::up(&connection, None).await.unwrap();
        Self {
            connection,
            admin_url,
            schema,
        }
    }

    pub fn connection(&self) -> DatabaseConnection {
        self.connection.clone()
    }
}

impl Deref for TestDatabase {
    type Target = DatabaseConnection;
    fn deref(&self) -> &Self::Target {
        &self.connection
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        let admin_url = self.admin_url.clone();
        let schema = self.schema.clone();
        let _ = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            if let Ok(runtime) = runtime {
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
