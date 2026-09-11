use migration::MigratorTrait;
use movie_harbor_api::{app, config::Config};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let db = sea_orm::Database::connect(&config.database_url).await?;
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
