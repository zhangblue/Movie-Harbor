use std::{
    env,
    fmt::{self, Display, Formatter},
    net::SocketAddr,
    path::PathBuf,
};

#[derive(Clone)]
pub struct Config {
    pub listen_addr: SocketAddr,
    pub database_url: String,
    pub media_dir: PathBuf,
    pub cookie_secure: bool,
    pub max_upload_bytes: u64,
    pub admin_name: Option<String>,
    pub admin_initial_password: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    Missing(&'static str),
    Invalid(&'static str),
}

impl Display for ConfigError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing(name) => {
                write!(formatter, "missing required environment variable {name}")
            }
            Self::Invalid(name) => {
                write!(formatter, "invalid value for environment variable {name}")
            }
        }
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| env::var(name).ok())
    }

    fn from_lookup<F>(lookup: F) -> Result<Self, ConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let listen_addr = required(&lookup, "LISTEN_ADDR").and_then(|value| {
            value
                .parse()
                .map_err(|_| ConfigError::Invalid("LISTEN_ADDR"))
        })?;
        let database_url = required(&lookup, "DATABASE_URL")?;
        let media_dir = PathBuf::from(required(&lookup, "MEDIA_DIR")?);
        let cookie_secure = required(&lookup, "COOKIE_SECURE").and_then(|value| {
            value
                .parse()
                .map_err(|_| ConfigError::Invalid("COOKIE_SECURE"))
        })?;
        let max_upload_bytes = required(&lookup, "MAX_UPLOAD_BYTES").and_then(|value| {
            value
                .parse::<u64>()
                .map_err(|_| ConfigError::Invalid("MAX_UPLOAD_BYTES"))
        })?;

        if max_upload_bytes == 0 {
            return Err(ConfigError::Invalid("MAX_UPLOAD_BYTES"));
        }

        Ok(Self {
            listen_addr,
            database_url,
            media_dir,
            cookie_secure,
            max_upload_bytes,
            admin_name: lookup("ADMIN_NAME"),
            admin_initial_password: lookup("ADMIN_INITIAL_PASSWORD"),
        })
    }
}

fn required<F>(lookup: &F, name: &'static str) -> Result<String, ConfigError>
where
    F: Fn(&str) -> Option<String>,
{
    lookup(name)
        .filter(|value| !value.trim().is_empty())
        .ok_or(ConfigError::Missing(name))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::Config;

    fn required_values() -> HashMap<&'static str, &'static str> {
        HashMap::from([
            ("LISTEN_ADDR", "127.0.0.1:3000"),
            ("DATABASE_URL", "postgresql://localhost/movie_harbor"),
            ("MEDIA_DIR", "/var/lib/movie-harbor/media"),
            ("COOKIE_SECURE", "true"),
            ("MAX_UPLOAD_BYTES", "1048576"),
            ("ADMIN_NAME", "admin"),
        ])
    }

    #[test]
    fn defers_initial_credentials_to_database_initialization() {
        let mut values = required_values();
        values.remove("ADMIN_NAME");
        assert!(Config::from_lookup(|name| values.get(name).map(ToString::to_string)).is_ok());
    }
}
