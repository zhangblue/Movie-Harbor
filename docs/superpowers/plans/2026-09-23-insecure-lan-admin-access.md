# Movie Harbor 局域网 IP 管理访问实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 新增默认关闭的 `ALLOW_INSECURE_LAN_HTTP` 开关；关闭时管理后台仅接受规范 localhost/环回来源，开启时同时允许同端口的 RFC1918 IPv4 或 IPv6 ULA 数字地址通过明文 HTTP 登录、读取和管理内容。

**架构：** `Config` 负责严格解析开关并拒绝含义冲突的启动组合；认证模块持有一个集中式 `OriginPolicy`，对所有受保护管理读请求校验 `Host`，对登录和写请求进一步校验 `Origin`、`Host`、协议、地址范围和端口。前端继续使用同源相对 `/api`，部署层只负责把开关传给 API，并在根 README 与半离线包 README 明示局域网 HTTP 风险。

**技术栈：** Rust、Axum 0.8、`url`、SeaORM、Node.js `node:test`、Docker Compose、Playwright

---

## 文件结构

- 修改 `backend/src/config.rs`：增加开关字段、环境变量解析和启动组合校验，并保留规范 `PUBLIC_ORIGIN` 解析职责。
- 修改 `backend/src/auth/csrf.rs`：定义集中式 `OriginPolicy`，实现 Host 校验、严格同源校验和允许的数字 IP 范围判断。
- 修改 `backend/src/auth/mod.rs`、`backend/src/app.rs`：把构造后的来源策略放进共享认证状态。
- 修改 `backend/src/auth/routes.rs`、`backend/src/auth/session.rs`：在登录、管理读请求和管理写请求的既有认证边界复用来源策略。
- 修改 `backend/tests/auth_test.rs`：覆盖真实 Router 上的局域网登录、会话读取、写操作和拒绝路径。
- 修改 `backend/tests/admin_content_test.rs`、`backend/tests/admin_export_test.rs`、`backend/tests/catalog_test.rs`、`backend/tests/genres_test.rs`、`backend/tests/media_upload_test.rs`、`backend/tests/movies_test.rs`、`backend/tests/series_test.rs`：为测试用 `Config` 显式设置安全默认值 `false`。
- 修改 `.env.example`、`docker-compose.yml`：声明并向 API 传递开关默认值。
- 修改 `tools/offline-package.mjs`：在半离线 Compose 中传递开关，并生成新的局域网访问说明。
- 修改 `tests/compose-storage.test.mjs`、`tests/offline-package.test.mjs`：锁定根 Compose、离线 Compose、覆盖值和包内文档契约。
- 修改 `README.md`：说明两种模式、访问地址、端口一致性、独立登录和明文 HTTP 风险。

### 任务 1：建立安全的启动配置契约

**文件：**
- 修改：`backend/src/config.rs:8-127`
- 修改：`backend/tests/admin_content_test.rs:49-66`
- 修改：`backend/tests/admin_export_test.rs:36-53`
- 修改：`backend/tests/auth_test.rs:24-41`
- 修改：`backend/tests/catalog_test.rs:52-69`
- 修改：`backend/tests/genres_test.rs:39-56`
- 修改：`backend/tests/media_upload_test.rs:525-542`
- 修改：`backend/tests/movies_test.rs:67-84`
- 修改：`backend/tests/series_test.rs:61-78`

- [ ] **步骤 1：为环境变量默认值、严格解析和冲突组合编写失败测试**

在 `backend/src/config.rs` 的测试模块增加以下行为断言；复用现有 `required_values()`，并让每个案例重新构造 map，避免案例间污染：

```rust
#[test]
fn insecure_lan_http_is_disabled_when_omitted_and_strictly_parsed() {
    let values = required_values();
    let config = Config::from_lookup(|name| values.get(name).map(ToString::to_string)).unwrap();
    assert!(!config.allow_insecure_lan_http);

    let mut invalid = values;
    invalid.insert("ALLOW_INSECURE_LAN_HTTP", "yes");
    assert!(matches!(
        Config::from_lookup(|name| invalid.get(name).map(ToString::to_string)),
        Err(ConfigError::Invalid("ALLOW_INSECURE_LAN_HTTP"))
    ));
}

#[test]
fn insecure_lan_http_requires_loopback_http_and_insecure_cookies() {
    for (origin, cookie_secure) in [
        ("https://localhost:8080", "false"),
        ("http://localhost:8080", "true"),
        ("http://192.168.1.20:8080", "false"),
        ("https://harbor.test", "true"),
    ] {
        let mut values = required_values();
        values.insert("ALLOW_INSECURE_LAN_HTTP", "true");
        values.insert("PUBLIC_ORIGIN", origin);
        values.insert("COOKIE_SECURE", cookie_secure);
        assert!(matches!(
            Config::from_lookup(|name| values.get(name).map(ToString::to_string)),
            Err(ConfigError::Invalid("ALLOW_INSECURE_LAN_HTTP"))
        ));
    }
}

#[test]
fn insecure_lan_http_accepts_loopback_http_configuration() {
    for origin in ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"] {
        let mut values = required_values();
        values.insert("ALLOW_INSECURE_LAN_HTTP", "true");
        values.insert("PUBLIC_ORIGIN", origin);
        values.insert("COOKIE_SECURE", "false");
        let config = Config::from_lookup(|name| values.get(name).map(ToString::to_string)).unwrap();
        assert!(config.allow_insecure_lan_http);
    }
}
```

- [ ] **步骤 2：运行精确测试并确认因字段/解析尚不存在而失败**

运行：

```bash
cargo test --package movie-harbor-api config::tests::insecure_lan_http -- --nocapture
```

预期：FAIL，编译器报告 `Config` 没有 `allow_insecure_lan_http` 字段，或测试无法观察新配置行为；失败原因必须是功能尚未实现，而不是测试语法错误。

- [ ] **步骤 3：实现最小配置解析与组合校验**

在 `Config` 增加字段：

```rust
pub allow_insecure_lan_http: bool,
```

在 `from_lookup` 中按缺失为 `false`、非布尔值为新变量错误的规则解析：

```rust
let allow_insecure_lan_http = lookup("ALLOW_INSECURE_LAN_HTTP").map_or(Ok(false), |value| {
    value
        .parse()
        .map_err(|_| ConfigError::Invalid("ALLOW_INSECURE_LAN_HTTP"))
})?;
```

把该值写入 `Config`。在 `validated_origin()` 中先计算现有 `loopback`，再执行以下次序明确的校验：

```rust
if self.allow_insecure_lan_http
    && (self.cookie_secure || origin.scheme() != "http" || !loopback)
{
    return Err(ConfigError::Invalid("ALLOW_INSECURE_LAN_HTTP"));
}
if !self.cookie_secure && !loopback {
    return Err(ConfigError::Invalid("COOKIE_SECURE"));
}
```

这样只有规范来源为 HTTP 环回且 Cookie 非 Secure 时才能开启动态局域网来源；开关关闭时维持原有 HTTPS 和本机 HTTP 规则。

在列出的八个集成测试文件中所有 `Config` 结构体字面量紧邻 `public_origin` 增加：

```rust
allow_insecure_lan_http: false,
```

- [ ] **步骤 4：运行配置单测与全后端无执行编译并确认通过**

运行：

```bash
cargo test --package movie-harbor-api config::tests::insecure_lan_http -- --nocapture
cargo test --workspace --no-run
```

预期：3 个新配置测试 PASS；工作区全部测试目标编译成功，不再遗漏任何 `Config` 字面量。

- [ ] **步骤 5：提交配置契约**

```bash
git add backend/src/config.rs backend/tests/admin_content_test.rs backend/tests/admin_export_test.rs backend/tests/auth_test.rs backend/tests/catalog_test.rs backend/tests/genres_test.rs backend/tests/media_upload_test.rs backend/tests/movies_test.rs backend/tests/series_test.rs
git commit -m "feat: 添加局域网 HTTP 配置开关"
```

### 任务 2：集中实现管理来源策略并接入全部认证路径

**文件：**
- 修改：`backend/src/auth/csrf.rs:1-44`
- 修改：`backend/src/auth/mod.rs:15-27`
- 修改：`backend/src/app.rs:18-36`
- 修改：`backend/src/auth/routes.rs:21-69`
- 修改：`backend/src/auth/session.rs:89-102`
- 测试：`backend/src/auth/csrf.rs`
- 测试：`backend/tests/auth_test.rs`

- [ ] **步骤 1：为来源策略的地址、端口和请求头矩阵编写失败单测**

在 `backend/src/auth/csrf.rs` 增加测试模块，创建 `http://localhost:8080` 的策略，并用真实 `HeaderMap` 覆盖以下表格：

```rust
#[test]
fn lan_policy_accepts_only_matching_private_numeric_origins_on_the_configured_port() {
    let policy = OriginPolicy::new(
        url::Url::parse("http://localhost:8080").unwrap(),
        true,
    );
    for authority in [
        "127.0.0.1:8080",
        "10.0.0.8:8080",
        "172.16.0.8:8080",
        "172.31.255.254:8080",
        "192.168.1.20:8080",
        "[::1]:8080",
        "[fc00::8]:8080",
        "[fd12:3456::8]:8080",
    ] {
        assert!(policy.same_origin(&headers(authority, &format!("http://{authority}"))), "rejected {authority}");
    }

    for authority in [
        "10.0.0.8:8081",
        "172.15.255.254:8080",
        "172.32.0.1:8080",
        "169.254.1.8:8080",
        "192.0.2.8:8080",
        "224.0.0.1:8080",
        "255.255.255.255:8080",
        "0.0.0.0:8080",
        "[fe80::8]:8080",
        "[2001:db8::8]:8080",
        "[ff02::1]:8080",
        "[::]:8080",
        "printer.local:8080",
    ] {
        assert!(!policy.same_origin(&headers(authority, &format!("http://{authority}"))), "accepted {authority}");
    }
}

#[test]
fn lan_policy_rejects_origin_host_mismatch_and_missing_or_malformed_headers() {
    let policy = OriginPolicy::new(
        url::Url::parse("http://localhost:8080").unwrap(),
        true,
    );
    assert!(!policy.same_origin(&headers("192.168.1.20:8080", "http://192.168.1.21:8080")));
    assert!(!policy.same_origin(&headers("192.168.1.20:8080", "https://192.168.1.20:8080")));
    assert!(!policy.same_origin(&headers("192.168.1.20:8080", "http://192.168.1.20:8081")));
    assert!(!policy.same_origin(&HeaderMap::new()));

    let mut duplicate = headers("192.168.1.20:8080", "http://192.168.1.20:8080");
    duplicate.append("origin", "http://192.168.1.20:8080".parse().unwrap());
    assert!(!policy.same_origin(&duplicate));
}

#[test]
fn disabled_policy_accepts_only_the_configured_origin() {
    let policy = OriginPolicy::new(
        url::Url::parse("http://localhost:8080").unwrap(),
        false,
    );
    assert!(policy.same_origin(&headers("localhost:8080", "http://localhost:8080")));
    assert!(!policy.same_origin(&headers("192.168.1.20:8080", "http://192.168.1.20:8080")));
}
```

测试辅助函数必须分别插入 `Host` 和 `Origin`；再单独断言 `host_allowed()` 在不带 Origin 的管理 GET 上接受配置 Host/允许的私有 IP，拒绝关闭状态下的私有 IP及所有公网、域名和错端口 Host。

- [ ] **步骤 2：运行来源策略精确单测并确认失败**

运行：

```bash
cargo test --package movie-harbor-api auth::csrf::tests::lan_policy -- --nocapture
cargo test --package movie-harbor-api auth::csrf::tests::disabled_policy -- --nocapture
```

预期：FAIL，编译器报告 `OriginPolicy` 或 `host_allowed` 尚不存在。

- [ ] **步骤 3：实现集中式 `OriginPolicy`**

在 `backend/src/auth/csrf.rs` 定义可克隆策略：

```rust
#[derive(Clone)]
pub struct OriginPolicy {
    configured: url::Url,
    allow_insecure_lan_http: bool,
}

impl OriginPolicy {
    pub fn new(configured: url::Url, allow_insecure_lan_http: bool) -> Self {
        Self { configured, allow_insecure_lan_http }
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
        let host = single_header(headers, axum::http::header::HOST)?;
        host.parse::<axum::http::uri::Authority>().ok()?;
        crate::config::parse_origin(&format!("{}://{host}", self.configured.scheme()))
    }

    fn origin_allowed(&self, origin: &url::Url) -> bool {
        if origin.origin() == self.configured.origin() {
            return true;
        }
        if !self.allow_insecure_lan_http
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
                    || ip.to_ipv4_mapped().is_some_and(|mapped| mapped.is_loopback())
            }
            _ => false,
        }
    }
}

fn single_header(
    headers: &HeaderMap,
    name: axum::http::header::HeaderName,
) -> Option<&str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    values.next().is_none().then_some(value)
}
```

实现时按以下安全约束核对上述代码：

1. 读取唯一可解析的 `Host`/`Authority`，用规范来源协议构造请求来源。
2. 规范化后与 `configured.origin()` 完全相等则接受。
3. 仅当开关开启、规范协议是 `http`、请求来源协议是 `http`、有效端口与规范来源 `port_or_known_default()` 相等时进入动态分支。
4. 动态分支只接受 `url::Host::Ipv4` 的 `is_loopback() || is_private()`，或 `url::Host::Ipv6` 的 `is_loopback() || is_unique_local()`；这些正向条件排除 unspecified、link-local、multicast、文档地址、全局广播和所有 `Domain`。IPv4-mapped IPv6 只延续现有的 mapped-loopback 兼容，不把 mapped-private 当成新白名单。

`same_origin()` 必须先调用相同的 Host 解析，再通过 `crate::config::parse_origin` 解析 Origin；要求两个解析后来源完全相等，并且该来源通过与 `host_allowed()` 相同的可信来源判断。不要读取 `Forwarded` 或 `X-Forwarded-Host`。

- [ ] **步骤 4：为 Router 级局域网管理流程编写失败测试**

在 `backend/tests/auth_test.rs` 增加一个可指定 `Host` 的请求辅助函数，并写两个数据库集成测试：

```rust
#[tokio::test]
async fn enabled_lan_http_allows_private_ip_login_session_and_write() {
    let db = database().await;
    let mut cfg = config();
    cfg.cookie_secure = false;
    cfg.public_origin = "http://localhost:8080".into();
    cfg.allow_insecure_lan_http = true;
    let app = app::build(db, &cfg).await.unwrap();

    let login = request_for_authority(
        &app,
        "POST",
        "/api/admin/login",
        json!({"name":"Admin","password":"initial-password"}),
        "192.168.1.20:8080",
        None,
        None,
        Some("http://192.168.1.20:8080"),
    ).await;
    assert_eq!(login.status(), StatusCode::OK);
    let set_cookie = login.headers()["set-cookie"].to_str().unwrap();
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("SameSite=Lax"));
    assert!(!set_cookie.contains("; Secure"));
    let cookie = set_cookie.split(';').next().unwrap().to_owned();
    let csrf = body(login).await["csrf_token"].as_str().unwrap().to_owned();

    let session = request_for_authority(
        &app, "GET", "/api/admin/session", json!(null),
        "192.168.1.20:8080", Some(&cookie), None, None,
    ).await;
    assert_eq!(session.status(), StatusCode::OK);

    let changed = request_for_authority(
        &app,
        "POST",
        "/api/admin/password",
        json!({"current_password":"initial-password","new_password":"replacement-password"}),
        "192.168.1.20:8080",
        Some(&cookie),
        Some(&csrf),
        Some("http://192.168.1.20:8080"),
    ).await;
    assert_eq!(changed.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn lan_http_rejects_disabled_public_domain_wrong_port_and_mismatched_origin() {
    let db = database().await;
    let mut cfg = config();
    cfg.cookie_secure = false;
    cfg.public_origin = "http://localhost:8080".into();
    let disabled = app::build(db.clone(), &cfg).await.unwrap();
    assert_eq!(
        request_for_authority(
            &disabled,
            "POST",
            "/api/admin/login",
            json!({"name":"Admin","password":"initial-password"}),
            "192.168.1.20:8080",
            None,
            None,
            Some("http://192.168.1.20:8080"),
        ).await.status(),
        StatusCode::FORBIDDEN,
    );

    cfg.allow_insecure_lan_http = true;
    let enabled = app::build(db, &cfg).await.unwrap();
    for (host, origin) in [
        ("8.8.8.8:8080", "http://8.8.8.8:8080"),
        ("printer.local:8080", "http://printer.local:8080"),
        ("192.168.1.20:8081", "http://192.168.1.20:8081"),
        ("192.168.1.20:8080", "http://192.168.1.21:8080"),
    ] {
        assert_eq!(
            request_for_authority(
                &enabled,
                "POST",
                "/api/admin/login",
                json!({"name":"Admin","password":"initial-password"}),
                host,
                None,
                None,
                Some(origin),
            ).await.status(),
            StatusCode::FORBIDDEN,
        );
    }

    let allowed = request_for_authority(
        &enabled,
        "POST",
        "/api/admin/login",
        json!({"name":"Admin","password":"initial-password"}),
        "192.168.1.20:8080",
        None,
        None,
        Some("http://192.168.1.20:8080"),
    ).await;
    let cookie = allowed.headers()["set-cookie"]
        .to_str().unwrap().split(';').next().unwrap().to_owned();
    assert_eq!(
        request_for_authority(
            &enabled,
            "GET",
            "/api/admin/session",
            json!(null),
            "8.8.8.8:8080",
            Some(&cookie),
            None,
            None,
        ).await.status(),
        StatusCode::FORBIDDEN,
    );
}
```

`request_for_authority` 复用现有 `Request::builder()` 和 `ConnectInfo("127.0.0.1:12345")` 构造方式，但把原来固定的 `host: harbor.test` 改为函数参数；按参数选择性加入 Cookie、`X-CSRF-Token` 和 Origin。测试必须通过 `app::build` 返回的 Router 调用 `oneshot`，覆盖登录 handler、认证中间件和写授权，而不是只调用策略函数。

- [ ] **步骤 5：运行 Router 精确测试并确认失败**

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --package movie-harbor-api --test auth_test 'lan_http_' -- --nocapture
```

预期：FAIL；来源策略尚未进入 `AuthState` 或路由仍使用单一 `PUBLIC_ORIGIN`，私有 IP 登录返回 `403 Forbidden`。

- [ ] **步骤 6：把策略接入认证状态、管理读请求、登录和写请求**

执行以下一致的类型变更：

```rust
// backend/src/auth/mod.rs
pub origin_policy: csrf::OriginPolicy,

// backend/src/app.rs
origin_policy: crate::auth::csrf::OriginPolicy::new(
    public_origin,
    config.allow_insecure_lan_http,
),

// backend/src/auth/session.rs
pub fn authorize_write(
    current: &CurrentSession,
    headers: &HeaderMap,
    origin_policy: &csrf::OriginPolicy,
) -> Result<(), AuthError>
```

登录 handler 调用 `state.origin_policy.same_origin(&headers)`；写授权调用同一个 `same_origin()`。`require_session` 在读取 Cookie 或执行业务 handler 之前调用 `state.origin_policy.host_allowed(request.headers())`，不允许时返回 `403 Forbidden`；GET/HEAD/OPTIONS 仍不要求 Origin 或 CSRF，其他方法继续执行完整 CSRF 校验。这样禁止的 LAN Host 即使人工带入有效 Cookie 也不能读取管理会话，公开 API 不受这层中间件影响。

- [ ] **步骤 7：运行策略、认证和后端完整测试**

运行：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
```

预期：全部退出码为 0；新策略单测和 Router 集成测试 PASS；既有严格来源、CSRF、限流、上传和内容生命周期测试无回归。

- [ ] **步骤 8：提交管理来源策略**

```bash
git add backend/src/auth/csrf.rs backend/src/auth/mod.rs backend/src/app.rs backend/src/auth/routes.rs backend/src/auth/session.rs backend/tests/auth_test.rs
git commit -m "feat: 允许显式开启局域网管理访问"
```

### 任务 3：同步生产 Compose 与半离线发布契约

**文件：**
- 修改：`.env.example:1-13`
- 修改：`docker-compose.yml:45-60`
- 修改：`tools/offline-package.mjs:250-390`
- 测试：`tests/compose-storage.test.mjs`
- 测试：`tests/offline-package.test.mjs`

- [ ] **步骤 1：先扩展部署契约测试**

在 `tests/compose-storage.test.mjs` 的 `expectedDefaults` 增加：

```js
ALLOW_INSECURE_LAN_HTTP: "false",
```

在 Compose 源码断言中增加：

```js
assert.match(source, /ALLOW_INSECURE_LAN_HTTP: \$\{ALLOW_INSECURE_LAN_HTTP:-false\}/);
```

在显式覆盖测试传入 `ALLOW_INSECURE_LAN_HTTP: "true"` 并断言 API 环境为 `"true"`。

在 `tests/offline-package.test.mjs` 的本地回退对象、完整 API 环境对象和包内说明测试中分别增加：

```js
ALLOW_INSECURE_LAN_HTTP: "${ALLOW_INSECURE_LAN_HTTP:-false}",
```

以及文档断言：默认关闭、开启命令为 `ALLOW_INSECURE_LAN_HTTP=true`、示例地址包含 `http://192.168.1.20:8080/admin/`、仅允许私有数字 IP、localhost 与 IP 分别登录、不得用于公网或不可信网络。

- [ ] **步骤 2：运行 Node 精确测试并确认失败**

运行：

```bash
node --test tests/compose-storage.test.mjs tests/offline-package.test.mjs
```

预期：FAIL，报告根示例、生产 Compose、离线 Compose 和包内 README 尚未包含新变量或新说明。

- [ ] **步骤 3：传递相同的默认值和覆盖值**

在 `.env.example` 的 `COOKIE_SECURE=false` 后增加：

```dotenv
ALLOW_INSECURE_LAN_HTTP=false
```

在 `docker-compose.yml` API 环境与 `renderCompose()` 的 API 环境中增加：

```yaml
ALLOW_INSECURE_LAN_HTTP: ${ALLOW_INSECURE_LAN_HTTP:-false}
```

JavaScript 对象中的值保持字符串形式 `"${ALLOW_INSECURE_LAN_HTTP:-false}"`。不要修改 Caddy 端口、镜像平台、发布白名单、归档内容或秘密处理。

- [ ] **步骤 4：更新包内 README 生成器**

将 `renderBundleReadme()` 的访问说明改成三个清晰模式：

1. 默认 `ALLOW_INSECURE_LAN_HTTP=false`：仅 `http://localhost:8080/admin/` 或规范环回来源可完整管理。
2. 可信局域网：保持 `PUBLIC_ORIGIN=http://localhost:8080`、`COOKIE_SECURE=false`，设置 `ALLOW_INSECURE_LAN_HTTP=true`，重启后通过服务器私有数字 IP，例如 `http://192.168.1.20:8080/admin/`；自定义 `APP_PORT` 时同步修改 `PUBLIC_ORIGIN` 端口。
3. 域名、公网或不可信网络：使用实际 `https://` 来源、`COOKIE_SECURE=true`、`ALLOW_INSECURE_LAN_HTTP=false` 和外部 TLS/VPN；不得用新开关替代传输加密。

同时写明只接受 RFC1918/ULA 数字 IP、不接受域名，且 localhost 与 IP Cookie 隔离，需要分别登录。

- [ ] **步骤 5：运行部署契约与发布工具完整单测**

运行：

```bash
node --test tests/compose-storage.test.mjs tests/offline-package.test.mjs
node --test
git diff --check
```

预期：全部退出码为 0；离线包的镜像平台、文件白名单、校验和、秘密排除和双架构契约继续通过。

- [ ] **步骤 6：提交部署配置**

```bash
git add .env.example docker-compose.yml tools/offline-package.mjs tests/compose-storage.test.mjs tests/offline-package.test.mjs
git commit -m "feat: 传递局域网管理访问配置"
```

### 任务 4：完成用户文档与跨服务验收

**文件：**
- 修改：`README.md:80-155`
- 验证：`tests/e2e/run.mjs`
- 验证：`tests/e2e/*.spec.ts`

- [ ] **步骤 1：先写 README 内容契约并确认失败**

在 `tests/compose-storage.test.mjs` 增加读取根 `README.md` 的测试，断言至少包含：

```js
assert.match(readme, /ALLOW_INSECURE_LAN_HTTP/);
assert.match(readme, /默认[^。\n]*false[^。\n]*localhost/);
assert.match(readme, /http:\/\/192\.168\.1\.20:8080\/admin\//);
assert.match(readme, /私有[^。\n]*数字 IP/);
assert.match(readme, /localhost[^。\n]*分别登录/);
assert.match(readme, /明文 HTTP[^。\n]*(受信任|可信)[^。\n]*局域网/);
assert.match(readme, /(公网|公共网络|访客 Wi-Fi)[^。\n]*(不得|不要|禁用)/);
```

运行：

```bash
node --test tests/compose-storage.test.mjs
```

预期：FAIL，根 README 尚未描述新开关和完整安全边界。

- [ ] **步骤 2：更新根部署说明**

修改生产部署入口说明、关键环境变量表、安全说明和半离线部署注释：

- 默认示例保持 `PUBLIC_ORIGIN=http://localhost:8080`、`COOKIE_SECURE=false`、`ALLOW_INSECURE_LAN_HTTP=false`，明确只能从本机完整操作后台。
- 增加可信局域网示例，说明把 `.env` 中开关改为 `true` 后重启 Compose，并从另一台电脑打开 `http://192.168.1.20:8080/admin/`；`192.168.1.20` 替换为服务器私有 IP。
- 说明 `APP_PORT` 变化时 `PUBLIC_ORIGIN` 端口必须同步，允许的 LAN 请求也只能使用该端口。
- 说明只接受私有数字 IP，不接受局域网主机名；localhost 与 IP 分别登录。
- 保留 HTTPS 正式部署路径，并醒目标注管理员密码和 Cookie 在明文 HTTP 网络路径上可能被观察或篡改，访客 Wi-Fi、公共网络和公网端口映射不得启用。

- [ ] **步骤 3：运行文档契约、前端测试和构建**

运行：

```bash
node --test tests/compose-storage.test.mjs tests/offline-package.test.mjs
npm test --workspaces
npm run build --workspaces
```

预期：全部退出码为 0；两个前端仍通过同源相对 `/api` 工作，无需编译服务器 IP。

- [ ] **步骤 4：执行跨服务 Docker Compose 与 Playwright 验收**

先启动项目规定的隔离测试数据库，再运行完整验证：

```bash
docker compose -f docker-compose.test.yml up -d postgres
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
npm test --workspaces
npm run build --workspaces
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
npm run test:e2e
git diff --check
```

预期：整组命令使用最新工作树全部退出码为 0。Playwright runner 继续使用自己的隔离 Compose 项目和临时数据目录；不得改用生产 `data/postgres` 或 `data/media`，也不得清理其他并行任务的 Compose 资源。

- [ ] **步骤 5：人工核对配置解析结果与变更范围**

运行：

```bash
docker compose --env-file .env.example config --format json
rg -n 'ALLOW_INSECURE_LAN_HTTP|192\.168\.1\.20:8080|明文 HTTP|分别登录' .env.example docker-compose.yml README.md tools/offline-package.mjs tests backend/src
git status --short
git diff --stat
```

预期：解析后的 API 环境包含 `ALLOW_INSECURE_LAN_HTTP=false`；所有配置入口和文档用词一致；变更只涉及本计划列出的来源策略、配置、测试与文档文件，没有前端业务改动或发布平台回归。

- [ ] **步骤 6：提交文档与最终验收结果**

```bash
git add README.md tests/compose-storage.test.mjs
git commit -m "docs: 说明局域网管理访问模式"
```

提交后确认 `git status --short` 为空，并记录最终提交 SHA、完整验证命令结果以及任何外部环境限制。若完整验证存在失败，不得声称任务完成，也不得合并或推送。
