use axum::http::HeaderMap;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub fn digest(value: &str) -> String {
    // 会话与 CSRF 的数据库字段只保存 SHA-256 摘要，泄露记录时不能直接复用原始令牌。
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

// 随机且仅 HttpOnly Cookie 可见的会话令牌才是秘密；固定前缀把 CSRF 令牌置于独立派生域。
pub fn token(session_token: &str) -> String {
    digest(&format!("movie-harbor:csrf:v1:{session_token}"))
}

pub fn matches(value: &str, stored_digest: &str) -> bool {
    // 先摘要再以常量时间比较，避免根据首个不匹配位置泄露已存令牌摘要的信息。
    digest(value)
        .as_bytes()
        .ct_eq(stored_digest.as_bytes())
        .into()
}

#[derive(Clone)]
pub struct OriginPolicy {
    configured: url::Url,
    allow_insecure_lan_http: bool,
}

impl OriginPolicy {
    pub fn new(configured: url::Url, allow_insecure_lan_http: bool) -> Self {
        Self {
            configured,
            allow_insecure_lan_http,
        }
    }

    pub fn host_allowed(&self, headers: &HeaderMap) -> bool {
        self.request_origin(headers)
            .is_some_and(|origin| self.origin_allowed(&origin))
    }

    pub fn same_origin(&self, headers: &HeaderMap) -> bool {
        let Some(request_origin) = self.request_origin(headers) else {
            return false;
        };
        let Some(origin) = single_header(headers, axum::http::header::ORIGIN)
            .and_then(crate::config::parse_origin)
        else {
            return false;
        };
        origin.origin() == request_origin.origin() && self.origin_allowed(&origin)
    }

    fn request_origin(&self, headers: &HeaderMap) -> Option<url::Url> {
        // 仅采信唯一 Host，不从转发头推导管理请求的来源。
        let host = single_header(headers, axum::http::header::HOST)?;
        host.parse::<axum::http::uri::Authority>().ok()?;
        crate::config::parse_origin(&format!("{}://{host}", self.configured.scheme()))
    }

    fn origin_allowed(&self, origin: &url::Url) -> bool {
        if origin.origin() == self.configured.origin() {
            return true;
        }
        if !self.allow_insecure_lan_http
            || self.configured.scheme() != "http"
            || origin.scheme() != "http"
            || origin.port_or_known_default() != self.configured.port_or_known_default()
        {
            return false;
        }
        match origin.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private(),
            Some(url::Host::Ipv6(ip)) => {
                ip.is_loopback()
                    || ip.is_unique_local()
                    || ip
                        .to_ipv4_mapped()
                        .is_some_and(|mapped| mapped.is_loopback())
            }
            _ => false,
        }
    }
}

fn single_header(headers: &HeaderMap, name: axum::http::header::HeaderName) -> Option<&str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(host: &str, origin: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("host", host.parse().unwrap());
        headers.insert("origin", origin.parse().unwrap());
        headers
    }

    #[test]
    fn lan_policy_accepts_only_matching_private_numeric_origins_on_the_configured_port() {
        let policy = OriginPolicy::new(url::Url::parse("http://localhost:8080").unwrap(), true);
        for authority in [
            "localhost:8080",
            "127.0.0.1:8080",
            "10.0.0.8:8080",
            "172.16.0.8:8080",
            "172.31.255.254:8080",
            "192.168.1.20:8080",
            "[::1]:8080",
            "[fc00::8]:8080",
            "[fd12:3456::8]:8080",
            "[::ffff:127.0.0.1]:8080",
        ] {
            let mut request = headers(authority, &format!("http://{authority}"));
            assert!(policy.same_origin(&request), "rejected {authority}");
            request.remove("origin");
            assert!(policy.host_allowed(&request), "rejected GET {authority}");
        }
        for authority in [
            "10.0.0.8:8081",
            "10.0.0.8",
            "172.15.255.254:8080",
            "172.32.0.1:8080",
            "169.254.1.8:8080",
            "192.0.2.8:8080",
            "8.8.8.8:8080",
            "224.0.0.1:8080",
            "255.255.255.255:8080",
            "0.0.0.0:8080",
            "[fe80::8]:8080",
            "[2001:db8::8]:8080",
            "[ff02::1]:8080",
            "[::]:8080",
            "[::ffff:192.168.1.20]:8080",
            "printer.local:8080",
        ] {
            let mut request = headers(authority, &format!("http://{authority}"));
            assert!(!policy.same_origin(&request), "accepted {authority}");
            request.remove("origin");
            assert!(!policy.host_allowed(&request), "accepted GET {authority}");
        }
    }

    #[test]
    fn lan_policy_rejects_origin_host_mismatch_and_missing_or_malformed_headers() {
        let policy = OriginPolicy::new(url::Url::parse("http://localhost:8080").unwrap(), true);
        for origin in [
            "http://192.168.1.21:8080",
            "https://192.168.1.20:8080",
            "http://192.168.1.20:8081",
            "null",
            "",
            "http://192.168.1.20:8080/path",
            "http://user@192.168.1.20:8080",
            "http://192.168.1.20:8080?query",
            "http://192.168.1.20:8080#fragment",
            "http://192.168.1.20:8080 http://192.168.1.20:8080",
        ] {
            assert!(
                !policy.same_origin(&headers("192.168.1.20:8080", origin)),
                "accepted {origin}"
            );
        }
        assert!(!policy.same_origin(&HeaderMap::new()));
        assert!(!policy.host_allowed(&HeaderMap::new()));
        for name in ["host", "origin"] {
            let mut missing = headers("192.168.1.20:8080", "http://192.168.1.20:8080");
            missing.remove(name);
            assert!(!policy.same_origin(&missing));
            let mut duplicate = headers("192.168.1.20:8080", "http://192.168.1.20:8080");
            duplicate.append(name, duplicate[name].clone());
            assert!(!policy.same_origin(&duplicate));
            let mut invalid = headers("192.168.1.20:8080", "http://192.168.1.20:8080");
            invalid.insert(name, axum::http::HeaderValue::from_bytes(&[0xff]).unwrap());
            assert!(!policy.same_origin(&invalid));
            if name == "host" {
                assert!(!policy.host_allowed(&duplicate));
                assert!(!policy.host_allowed(&invalid));
            }
        }
        for host in [
            "",
            "192.168.1.20:invalid",
            "192.168.1.20:65536",
            "192.168.1.20:8080/path",
            "user@192.168.1.20:8080",
            "192.168.1.20:8080,192.168.1.20:8080",
        ] {
            let request = headers(host, "http://192.168.1.20:8080");
            assert!(!policy.host_allowed(&request), "accepted {host}");
            assert!(!policy.same_origin(&request), "accepted {host}");
        }
        let mut forwarded = headers("8.8.8.8:8080", "http://192.168.1.20:8080");
        forwarded.insert(
            "forwarded",
            "host=192.168.1.20:8080;proto=http".parse().unwrap(),
        );
        forwarded.insert("x-forwarded-host", "192.168.1.20:8080".parse().unwrap());
        assert!(!policy.host_allowed(&forwarded));
        assert!(!policy.same_origin(&forwarded));
    }

    #[test]
    fn disabled_policy_accepts_only_the_configured_origin() {
        let policy = OriginPolicy::new(url::Url::parse("http://localhost:8080").unwrap(), false);
        assert!(policy.same_origin(&headers("LOCALHOST:8080", "http://localhost:8080")));
        for host in [
            "192.168.1.20:8080",
            "127.0.0.1:8080",
            "[::1]:8080",
            "printer.local:8080",
            "8.8.8.8:8080",
            "localhost:8081",
        ] {
            let mut request = headers(host, &format!("http://{host}"));
            assert!(!policy.same_origin(&request));
            request.remove("origin");
            assert!(!policy.host_allowed(&request));
        }
        let mut configured = headers("localhost:8080", "http://localhost:8080");
        configured.remove("origin");
        assert!(policy.host_allowed(&configured));
    }

    #[test]
    fn lan_policy_requires_http_and_normalizes_default_ports() {
        let policy = OriginPolicy::new(url::Url::parse("https://localhost:8080").unwrap(), true);
        assert!(!policy.same_origin(&headers("192.168.1.20:8080", "https://192.168.1.20:8080")));
        assert!(!policy.host_allowed(&headers("192.168.1.20:8080", "http://192.168.1.20:8080")));
        let policy = OriginPolicy::new(url::Url::parse("http://localhost").unwrap(), true);
        assert!(policy.same_origin(&headers("192.168.1.20:80", "http://192.168.1.20")));
        assert!(policy.same_origin(&headers("192.168.1.20", "http://192.168.1.20:80")));
    }
}
