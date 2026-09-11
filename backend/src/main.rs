use movie_harbor_api::{app, config::Config};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let listener = TcpListener::bind(config.listen_addr).await?;

    axum::serve(listener, app::router()).await?;

    Ok(())
}
