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
    pub public_origin: String,
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

        let mut config = Self {
            listen_addr,
            database_url,
            media_dir,
            cookie_secure,
            public_origin: required(&lookup, "PUBLIC_ORIGIN")?,
            max_upload_bytes,
            admin_name: lookup("ADMIN_NAME"),
            admin_initial_password: lookup("ADMIN_INITIAL_PASSWORD"),
        };
        config.public_origin = config.validated_origin()?.origin().ascii_serialization();
        Ok(config)
    }

    /// Validate at both environment parsing and application startup boundaries.
    pub fn validated_origin(&self) -> Result<url::Url, ConfigError> {
        let origin =
            parse_origin(&self.public_origin).ok_or(ConfigError::Invalid("PUBLIC_ORIGIN"))?;
        let loopback = match origin.host() {
            Some(url::Host::Domain("localhost")) => true,
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => {
                ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|ip| ip.is_loopback())
            }
            _ => false,
        };
        if !self.cookie_secure && !loopback {
            return Err(ConfigError::Invalid("COOKIE_SECURE"));
        }
        Ok(origin)
    }
}

/// Parse an HTTP origin, rejecting URL components that do not belong to an origin.
pub(crate) fn parse_origin(value: &str) -> Option<url::Url> {
    if value.contains('\\') || value.chars().any(char::is_whitespace) {
        return None;
    }
    let origin = url::Url::parse(value).ok()?;
    (matches!(origin.scheme(), "http" | "https")
        && origin.host().is_some()
        && origin.username().is_empty()
        && origin.password().is_none()
        && origin.path() == "/"
        && origin.query().is_none()
        && origin.fragment().is_none())
    .then_some(origin)
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

    use super::{Config, ConfigError};

    fn required_values() -> HashMap<&'static str, &'static str> {
        HashMap::from([
            ("LISTEN_ADDR", "127.0.0.1:3000"),
            ("DATABASE_URL", "postgresql://localhost/movie_harbor"),
            ("MEDIA_DIR", "/var/lib/movie-harbor/media"),
            ("COOKIE_SECURE", "true"),
            ("PUBLIC_ORIGIN", "https://harbor.test"),
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

    // Catches startup allowing insecure session cookies outside a loopback deployment.
    #[test]
    fn insecure_cookies_are_rejected_for_non_loopback_public_origins() {
        for origin in [
            "https://harbor.test",
            "http://harbor.test",
            "http://192.168.1.5:3000",
            "http://localhost.evil.test",
            "http://[2001:db8::1]",
            "http://0.0.0.0",
        ] {
            let mut values = required_values();
            values.insert("COOKIE_SECURE", "false");
            values.insert("PUBLIC_ORIGIN", origin);
            assert!(
                matches!(
                    Config::from_lookup(|name| values.get(name).map(ToString::to_string)),
                    Err(ConfigError::Invalid("COOKIE_SECURE"))
                ),
                "accepted insecure origin {origin}"
            );
        }
    }

    // Catches disabling the deliberate local HTTP development exception.
    #[test]
    fn loopback_development_can_disable_secure_cookies() {
        for origin in [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://127.2.3.4",
            "http://[::1]:5173",
            "http://[::ffff:127.0.0.1]:5173",
        ] {
            let mut values = required_values();
            values.insert("COOKIE_SECURE", "false");
            values.insert("PUBLIC_ORIGIN", origin);
            assert!(
                Config::from_lookup(|name| values.get(name).map(ToString::to_string)).is_ok(),
                "rejected development origin {origin}"
            );
        }
    }

    // Catches deriving trusted deployment origins from requests or accepting non-origin URL values.
    #[test]
    fn startup_requires_an_http_origin_without_credentials_path_query_or_fragment() {
        let mut values = required_values();
        values.remove("PUBLIC_ORIGIN");
        assert!(matches!(
            Config::from_lookup(|name| values.get(name).map(ToString::to_string)),
            Err(ConfigError::Missing("PUBLIC_ORIGIN"))
        ));
        for origin in [
            "null",
            "ftp://harbor.test",
            "https://user:pass@harbor.test",
            "https://harbor.test/admin",
            "https://harbor.test?query=1",
            "https://harbor.test#fragment",
        ] {
            values.insert("PUBLIC_ORIGIN", origin);
            assert!(
                matches!(
                    Config::from_lookup(|name| values.get(name).map(ToString::to_string)),
                    Err(ConfigError::Invalid("PUBLIC_ORIGIN"))
                ),
                "accepted invalid origin {origin}"
            );
        }
    }
}
