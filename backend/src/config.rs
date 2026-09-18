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
    /// 必须由后端操作系统账户所有，且不得允许组或其他用户写入。
    /// 以同一账户运行的进程属于存储信任边界。
    pub media_dir: PathBuf,
    pub cookie_secure: bool,
    pub public_origin: String,
    pub trust_proxy_headers: bool,
    pub trusted_proxy_secret: Option<String>,
    pub max_upload_bytes: u64,
    pub allowed_video_mime_types: Vec<String>,
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
        let database_url = database_url(&lookup)?;
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

        if max_upload_bytes == 0 || max_upload_bytes > i64::MAX as u64 {
            return Err(ConfigError::Invalid("MAX_UPLOAD_BYTES"));
        }
        let allowed_video_mime_types =
            parse_video_mime_types(&required(&lookup, "VIDEO_MIME_ALLOWLIST")?)?;

        let trust_proxy_headers = lookup("TRUST_PROXY_HEADERS").map_or(Ok(false), |value| {
            value
                .parse()
                .map_err(|_| ConfigError::Invalid("TRUST_PROXY_HEADERS"))
        })?;
        let trusted_proxy_secret = lookup("TRUST_PROXY_SECRET").filter(|value| !value.is_empty());
        // 信任转发头时必须绑定足够长的共享密钥，避免外部请求伪造代理身份。
        if trust_proxy_headers
            && trusted_proxy_secret
                .as_ref()
                .is_none_or(|secret| secret.len() < 32)
        {
            return Err(ConfigError::Invalid("TRUST_PROXY_SECRET"));
        }
        let mut config = Self {
            listen_addr,
            database_url,
            media_dir,
            cookie_secure,
            public_origin: required(&lookup, "PUBLIC_ORIGIN")?,
            trust_proxy_headers,
            trusted_proxy_secret,
            max_upload_bytes,
            allowed_video_mime_types,
            admin_name: lookup("ADMIN_NAME"),
            admin_initial_password: lookup("ADMIN_INITIAL_PASSWORD"),
        };
        config.public_origin = config.validated_origin()?.origin().ascii_serialization();
        Ok(config)
    }

    /// 在环境解析和应用启动两个边界均校验。
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
            // 非回环部署必须使用安全 Cookie，防止会话标识经 HTTP 暴露。
            return Err(ConfigError::Invalid("COOKIE_SECURE"));
        }
        Ok(origin)
    }
}

fn database_url<F>(lookup: &F) -> Result<String, ConfigError>
where
    F: Fn(&str) -> Option<String>,
{
    // 完整连接 URL 与拆分配置互斥，避免部署环境覆盖后连接到意外的数据库。
    if let Some(value) = lookup("DATABASE_URL").filter(|value| !value.trim().is_empty()) {
        if [
            "DATABASE_HOST",
            "DATABASE_PORT",
            "POSTGRES_DB",
            "POSTGRES_USER",
            "POSTGRES_PASSWORD",
        ]
        .into_iter()
        .any(|name| lookup(name).is_some_and(|component| !component.trim().is_empty()))
        {
            return Err(ConfigError::Invalid("DATABASE_URL"));
        }
        return Ok(value);
    }

    let host = required(lookup, "DATABASE_HOST").map_err(|error| match error {
        ConfigError::Missing(_) => ConfigError::Missing("DATABASE_URL"),
        other => other,
    })?;
    let port = required(lookup, "DATABASE_PORT")?
        .parse::<u16>()
        .map_err(|_| ConfigError::Invalid("DATABASE_PORT"))?;
    let database = required(lookup, "POSTGRES_DB")?;
    if !database
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '-')
    {
        return Err(ConfigError::Invalid("POSTGRES_DB"));
    }

    let username = required(lookup, "POSTGRES_USER")?;
    let password = required(lookup, "POSTGRES_PASSWORD")?;
    let mut url = url::Url::parse("postgresql://localhost")
        .expect("the static PostgreSQL URL should always parse");
    url.set_host(Some(&host))
        .map_err(|_| ConfigError::Invalid("DATABASE_HOST"))?;
    url.set_port(Some(port))
        .map_err(|_| ConfigError::Invalid("DATABASE_PORT"))?;
    // URL setter 不会转义 userinfo 中的原始 `%`，须先编码为 `%25`，防止凭据被按转义序列解码。
    url.set_username(&username.replace('%', "%25"))
        .map_err(|_| ConfigError::Invalid("POSTGRES_USER"))?;
    url.set_password(Some(&password.replace('%', "%25")))
        .map_err(|_| ConfigError::Invalid("POSTGRES_PASSWORD"))?;
    url.set_path(&format!("/{database}"));

    Ok(url.into())
}

fn parse_video_mime_types(value: &str) -> Result<Vec<String>, ConfigError> {
    const BROWSER_VIDEO_TYPES: [&str; 2] = ["video/mp4", "video/webm"];
    // 只接受浏览器可直接播放的格式，避免上传后公开站无法播放媒体。
    let mut result = Vec::new();
    for item in value.split(',').map(str::trim) {
        if item.is_empty()
            || !BROWSER_VIDEO_TYPES.contains(&item)
            || result.iter().any(|existing| existing == item)
        {
            return Err(ConfigError::Invalid("VIDEO_MIME_ALLOWLIST"));
        }
        result.push(item.to_owned());
    }
    if result.is_empty() {
        return Err(ConfigError::Invalid("VIDEO_MIME_ALLOWLIST"));
    }
    Ok(result)
}

/// 解析 HTTP Origin，拒绝不属于 Origin 的 URL 组成部分。
pub(crate) fn parse_origin(value: &str) -> Option<url::Url> {
    // 公开来源只能是纯 HTTP Origin，避免凭据或路径混入同源与 Cookie 判断。
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
            ("VIDEO_MIME_ALLOWLIST", "video/mp4,video/webm"),
            ("ADMIN_NAME", "admin"),
        ])
    }

    #[test]
    fn database_url_cannot_be_combined_with_component_settings() {
        let mut values = required_values();
        values.insert("DATABASE_HOST", "db");
        let result = Config::from_lookup(|name| values.get(name).map(|value| (*value).to_owned()));
        assert!(matches!(result, Err(ConfigError::Invalid("DATABASE_URL"))));
    }

    #[test]
    fn trusted_proxy_headers_are_explicit_and_strictly_parsed() {
        let values = required_values();
        let config = Config::from_lookup(|name| values.get(name).map(ToString::to_string)).unwrap();
        assert!(!config.trust_proxy_headers);

        let mut values = required_values();
        values.insert("TRUST_PROXY_HEADERS", "true");
        assert!(matches!(
            Config::from_lookup(|name| values.get(name).map(ToString::to_string)),
            Err(ConfigError::Invalid("TRUST_PROXY_SECRET"))
        ));
        values.insert("TRUST_PROXY_SECRET", "test-proxy-secret-at-least-32-bytes");
        let config = Config::from_lookup(|name| values.get(name).map(ToString::to_string)).unwrap();
        assert!(config.trust_proxy_headers);

        values.insert("TRUST_PROXY_HEADERS", "yes");
        assert!(matches!(
            Config::from_lookup(|name| values.get(name).map(ToString::to_string)),
            Err(ConfigError::Invalid("TRUST_PROXY_HEADERS"))
        ));
    }

    // 防止启用浏览器不支持的媒体类型，或静默接受空白名单。
    #[test]
    fn video_mime_allowlist_accepts_only_supported_unique_types() {
        let mut values = required_values();
        for invalid in [
            "",
            "application/octet-stream",
            "video/mp4,video/mp4",
            "video/ogg",
        ] {
            values.insert("VIDEO_MIME_ALLOWLIST", invalid);
            assert!(matches!(
                Config::from_lookup(|name| values.get(name).map(ToString::to_string)),
                Err(ConfigError::Missing("VIDEO_MIME_ALLOWLIST"))
                    | Err(ConfigError::Invalid("VIDEO_MIME_ALLOWLIST"))
            ));
        }
        values.insert("VIDEO_MIME_ALLOWLIST", "video/mp4, video/webm");
        let config = Config::from_lookup(|name| values.get(name).map(ToString::to_string)).unwrap();
        assert_eq!(config.allowed_video_mime_types, ["video/mp4", "video/webm"]);
        assert!(matches!(
            crate::media::UploadPolicy::new(1024, ["video/ogg"]),
            Err(crate::media::MediaError::UnsupportedType)
        ));
    }

    // 防止允许无法写入持久化 byte_size 列的值。
    #[test]
    fn maximum_upload_size_must_fit_the_database_integer() {
        let mut values = required_values();
        values.insert("MAX_UPLOAD_BYTES", "9223372036854775808");
        assert!(matches!(
            Config::from_lookup(|name| values.get(name).map(ToString::to_string)),
            Err(ConfigError::Invalid("MAX_UPLOAD_BYTES"))
        ));
        assert!(matches!(
            crate::media::UploadPolicy::new(i64::MAX as u64 + 1, ["video/mp4"]),
            Err(crate::media::MediaError::TooLarge)
        ));
    }

    #[test]
    fn defers_initial_credentials_to_database_initialization() {
        let mut values = required_values();
        values.remove("ADMIN_NAME");
        assert!(Config::from_lookup(|name| values.get(name).map(ToString::to_string)).is_ok());
    }

    // 确认拆分配置中的用户名和密码正确编码，保留 URL 分隔符与原始百分号的字面含义。
    #[test]
    fn database_components_are_encoded_into_a_connection_url() {
        let mut values = required_values();
        values.remove("DATABASE_URL");
        values.extend([
            ("DATABASE_HOST", "postgres"),
            ("DATABASE_PORT", "5432"),
            ("POSTGRES_DB", "movie_harbor"),
            ("POSTGRES_USER", "movie@harbor"),
            ("POSTGRES_PASSWORD", "p@ss:/?#%word"),
        ]);
        let config = Config::from_lookup(|name| values.get(name).map(ToString::to_string)).unwrap();
        let url = url::Url::parse(&config.database_url).unwrap();
        assert_eq!(url.host_str(), Some("postgres"));
        assert_eq!(url.port(), Some(5432));
        assert_eq!(url.username(), "movie%40harbor");
        assert_eq!(url.password(), Some("p%40ss%3A%2F%3F%23%25word"));
        assert_eq!(url.path(), "/movie_harbor");
    }

    // 防止启动时允许在非回环部署中使用不安全的会话 Cookie。
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

    // 防止意外移除本地 HTTP 开发环境的明确例外。
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

    // 防止从请求推导受信任部署来源，或接受非 Origin 的 URL 值。
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
