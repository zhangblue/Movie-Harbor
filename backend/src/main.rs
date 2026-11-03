use migration::MigratorTrait;
use movie_harbor_api::{app, config::Config};
use tokio::net::TcpListener;

#[tokio::main]
// 加载配置、连接数据库并启动 HTTP 服务，作为后端进程入口调用。
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let db = sea_orm::Database::connect(&config.database_url).await?;
    // 迁移、管理员初始化和媒体恢复必须先成功，随后才监听请求，避免未就绪状态对外服务。
    migration::Migrator::up(&db, None).await?;
    let router = app::build(db, &config).await?;
    let listener = TcpListener::bind(config.listen_addr).await?;

    axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;

    Ok(())
}
