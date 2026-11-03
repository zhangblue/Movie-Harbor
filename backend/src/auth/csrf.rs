use axum::http::HeaderMap;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

// 计算令牌摘要，供会话凭据保存与比较时调用。
pub fn digest(value: &str) -> String {
    // 会话与 CSRF 的数据库字段只保存 SHA-256 摘要，泄露记录时不能直接复用原始令牌。
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

// 随机且仅 HttpOnly Cookie 可见的会话令牌才是秘密；固定前缀把 CSRF 令牌置于独立派生域。
// 从会话令牌派生 CSRF 令牌，供会话创建和认证时调用。
pub fn token(session_token: &str) -> String {
    digest(&format!("movie-harbor:csrf:v1:{session_token}"))
}

// 比较令牌与保存的摘要，供写请求授权时调用。
pub fn matches(value: &str, stored_digest: &str) -> bool {
    // 先摘要再以常量时间比较，避免根据首个不匹配位置泄露已存令牌摘要的信息。
    digest(value)
        .as_bytes()
        .ct_eq(stored_digest.as_bytes())
        .into()
}

#[derive(Clone)]
// 保存请求来源策略，供认证与写请求同源校验使用。
pub struct OriginPolicy {
    configured: url::Url,
    allow_insecure_lan_http: bool,
}

impl OriginPolicy {
    // 构建来源策略，供应用启动时根据配置调用。
    pub fn new(configured: url::Url, allow_insecure_lan_http: bool) -> Self {
        Self {
            configured,
            allow_insecure_lan_http,
        }
    }

    // 校验请求主机是否符合策略，供认证中间件调用。
    pub fn host_allowed(&self, headers: &HeaderMap) -> bool {
        self.request_origin(headers)
            .is_some_and(|origin| self.origin_allowed(&origin))
    }

    // 校验请求来源与主机，供写请求授权时调用。
    pub fn same_origin(&self, headers: &HeaderMap) -> bool {
        let Some(request_origin) = self.request_origin(headers) else {
            return false;
        };
        let Some(origin) =
            single_header(headers, axum::http::header::ORIGIN).and_then(parse_request_origin)
        else {
            return false;
        };
        origin.origin() == request_origin.origin() && self.origin_allowed(&origin)
    }

    // 提取并解析请求来源，供来源策略校验调用。
    fn request_origin(&self, headers: &HeaderMap) -> Option<url::Url> {
        // 仅采信唯一 Host，不从转发头推导管理请求的来源。
        let host = single_header(headers, axum::http::header::HOST)?;
        parse_request_origin(&format!("{}://{host}", self.configured.scheme()))
    }

    // 判断来源是否符合配置与局域网例外，供同源校验调用。
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

// 严格解析请求来源，供来源策略读取请求头时调用。
fn parse_request_origin(value: &str) -> Option<url::Url> {
    // 请求头必须先满足来源文法，不能让 URL 解析器补斜杠、清理路径或丢弃空 userinfo。
    // 配置来源仍使用既有解析规则；这里只收紧浏览器发来的 Host/Origin。
    let (_, authority) = value.split_once("://")?;
    if authority.contains(['@', '/', '\\', '?', '#']) {
        return None;
    }
    authority.parse::<axum::http::uri::Authority>().ok()?;
    crate::config::parse_origin(value)
}

// 提取唯一合法请求头，供来源与主机校验调用。
fn single_header(headers: &HeaderMap, name: axum::http::header::HeaderName) -> Option<&str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 构造 Host 和 Origin 请求头，供来源策略测试复用。
    fn headers(host: &str, origin: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("host", host.parse().unwrap());
        headers.insert("origin", origin.parse().unwrap());
        headers
    }

    #[test]
    // 验证局域网例外只接受匹配端口的私网数字来源，供来源策略测试运行。
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
    // 验证来源与主机不匹配及无效请求头均被拒绝，供来源策略测试运行。
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
    // 验证主机和来源中的用户凭据被拒绝，供请求语法测试运行。
    fn request_syntax_rejects_userinfo_in_host_and_origin() {
        let policy = OriginPolicy::new(url::Url::parse("http://localhost:8080").unwrap(), true);
        for authority in [
            "@192.168.1.20:8080",
            ":@192.168.1.20:8080",
            "user@192.168.1.20:8080",
            "@localhost:8080",
            "@[fd12:3456::8]:8080",
        ] {
            let request = headers(authority, "http://192.168.1.20:8080");
            assert!(!policy.host_allowed(&request), "accepted Host {authority}");
            assert!(!policy.same_origin(&request), "accepted Host {authority}");
            assert!(
                !policy.same_origin(&headers(
                    "192.168.1.20:8080",
                    &format!("http://{authority}")
                )),
                "accepted Origin {authority}"
            );
        }
    }

    #[test]
    // 验证缺少双斜杠的来源被拒绝，供请求语法测试运行。
    fn request_syntax_rejects_origins_without_two_scheme_slashes() {
        let policy = OriginPolicy::new(url::Url::parse("http://localhost:8080").unwrap(), true);
        for origin in [
            "http:192.168.1.20:8080",
            "http:/192.168.1.20:8080",
            "http:localhost:8080",
        ] {
            assert!(
                !policy.same_origin(&headers("192.168.1.20:8080", origin)),
                "accepted {origin}"
            );
        }
    }

    #[test]
    // 验证来源中的额外斜杠或路径被拒绝，供请求语法测试运行。
    fn request_syntax_rejects_origins_with_extra_slashes_or_paths() {
        let policy = OriginPolicy::new(url::Url::parse("http://localhost:8080").unwrap(), true);
        for origin in [
            "http:///192.168.1.20:8080",
            "http:////192.168.1.20:8080",
            "http://192.168.1.20:8080/",
            "http://192.168.1.20:8080/.",
            "http://192.168.1.20:8080/a/..",
            "http://192.168.1.20:8080/%2e",
        ] {
            assert!(
                !policy.same_origin(&headers("192.168.1.20:8080", origin)),
                "accepted {origin}"
            );
        }
    }

    #[test]
    // 验证合法 IPv6 大小写和默认端口归一化，供请求语法测试运行。
    fn request_syntax_keeps_legal_ipv6_case_and_default_port_normalization() {
        let policy = OriginPolicy::new(url::Url::parse("HTTPS://HARBOR.TEST:443/").unwrap(), false);
        assert!(policy.same_origin(&headers("HARBOR.TEST:443", "HTTPS://harbor.test")));
        let policy = OriginPolicy::new(url::Url::parse("http://localhost:80/").unwrap(), true);
        assert!(policy.same_origin(&headers("[FD12:3456::8]:80", "HTTP://[fd12:3456::8]")));
    }

    #[test]
    // 验证关闭局域网例外时只接受配置的来源，供来源策略测试运行。
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
    // 验证局域网例外要求 HTTP 并归一化默认端口，供来源策略测试运行。
    fn lan_policy_requires_http_and_normalizes_default_ports() {
        let policy = OriginPolicy::new(url::Url::parse("https://localhost:8080").unwrap(), true);
        assert!(!policy.same_origin(&headers("192.168.1.20:8080", "https://192.168.1.20:8080")));
        assert!(!policy.host_allowed(&headers("192.168.1.20:8080", "http://192.168.1.20:8080")));
        let policy = OriginPolicy::new(url::Url::parse("http://localhost").unwrap(), true);
        assert!(policy.same_origin(&headers("192.168.1.20:80", "http://192.168.1.20")));
        assert!(policy.same_origin(&headers("192.168.1.20", "http://192.168.1.20:80")));
    }
}
