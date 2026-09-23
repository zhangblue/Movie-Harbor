# Movie Harbor 局域网 IP 管理访问设计

日期：2026-09-23

## 1. 背景与目标

当前默认部署允许通过 `http://localhost:8080` 在服务器本机使用管理后台，但后端会拒绝非环回地址配合不安全 Cookie。即使 Caddy 已监听宿主端口，局域网内其他电脑通过 `http://192.168.x.x:端口/admin/` 打开页面后，也无法完成登录或管理写操作。

本次增加一个默认关闭的显式安全开关。关闭时保持现有本机安全边界；开启时，同一可信局域网中的设备可以通过服务器任意私有 IP 和配置端口访问、登录并操作管理后台，无需逐个登记服务器 IP。

本设计增量修订 `2026-09-13-default-local-config-design.md` 对局域网明文 HTTP 的限制。只在显式开启新开关时采用本文规则；公网和正式部署仍应使用 HTTPS。

## 2. 配置接口

新增环境变量：

```dotenv
ALLOW_INSECURE_LAN_HTTP=false
```

默认值固定为 `false`。标准本机配置保持：

```dotenv
PUBLIC_ORIGIN=http://localhost:8080
COOKIE_SECURE=false
ALLOW_INSECURE_LAN_HTTP=false
```

可信局域网模式使用：

```dotenv
PUBLIC_ORIGIN=http://localhost:8080
COOKIE_SECURE=false
ALLOW_INSECURE_LAN_HTTP=true
```

`PUBLIC_ORIGIN` 继续提供协议和允许端口，并作为本机访问的规范来源。开启局域网模式不要求把 `PUBLIC_ORIGIN` 改成某个固定私有 IP，也不增加逐个 IP 白名单。

布尔值继续采用严格解析，只接受现有配置系统认可的 `true` 和 `false` 形式。配置缺失时按 `false` 处理，以保持现有直接运行和部署行为兼容。

## 3. 开关语义

### 3.1 关闭状态

当 `ALLOW_INSECURE_LAN_HTTP=false` 时：

- `COOKIE_SECURE=false` 只允许 `localhost`、IPv4 环回地址和 IPv6 环回地址。
- 管理 API 只接受与 `PUBLIC_ORIGIN` 精确等价的 `Origin` 和 `Host`。
- 局域网 IP 即使能取得管理前端静态页面，也不能登录、读取管理会话或执行管理写操作。
- 公开站与公开只读 API 的现有可访问性不改变。

### 3.2 开启状态

当 `ALLOW_INSECURE_LAN_HTTP=true` 时，除规范 `PUBLIC_ORIGIN` 外，后端接受满足全部条件的动态局域网来源：

1. 请求使用 `http`。
2. `Origin` 与请求 `Host` 解析后的协议、IP 和端口完全一致。
3. Host 是数字 IP，而不是域名或可被 DNS 重绑定的主机名。
4. IP 属于允许的私有地址范围。
5. 请求端口与 `PUBLIC_ORIGIN` 的有效端口一致。
6. 原有管理员会话、CSRF Token、请求方法和认证规则全部通过。

这样服务器拥有多个私有网卡地址时，不需要逐项登记；同一私有网络内的客户端可使用实际可达的服务器私有 IP。

## 4. 地址范围

局域网开关只允许以下数字地址：

- IPv4 环回：`127.0.0.0/8`。
- IPv4 私有地址：`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`。
- IPv6 环回：`::1`。
- IPv6 唯一本地地址：`fc00::/7`。

即使开关开启，也拒绝：

- 公网 IPv4 和 IPv6 地址。
- 未指定地址 `0.0.0.0` 和 `::`。
- IPv4 链路本地 `169.254.0.0/16` 和 IPv6 链路本地 `fe80::/10`。
- 组播、广播和文档保留地址。
- 任意域名，包括解析到私有 IP 的域名。
- Origin 和 Host 不一致、端口不一致或格式非法的请求。

## 5. 后端边界

配置层把单一 URL 判断扩展为明确的管理来源策略：

- 保留规范 `PUBLIC_ORIGIN`。
- 保存 `allow_insecure_lan_http` 布尔值。
- 提供统一的来源判定方法，供登录、退出、密码修改、媒体上传和所有管理写路由复用。

来源判定不能散落到路由或由前端决定。认证模块继续以服务器配置为权威，不能仅因为请求的 Origin 与 Host 彼此匹配就信任公网或域名来源。

当开关开启时，启动配置必须仍为 `COOKIE_SECURE=false`、`PUBLIC_ORIGIN` 使用 `http` 且主机是 localhost 或环回 IP。若与 HTTPS、Secure Cookie 或非环回规范来源混用，后端应拒绝启动，避免一个含义不清的混合模式。

管理 Cookie 继续使用 `HttpOnly`、`SameSite=Lax` 和 `/api/admin` 路径。局域网 HTTP 模式下不带 `Secure`；浏览器按主机隔离 Cookie，因此 localhost 与服务器 IP 需要分别登录，会话不会共享。

## 6. 前端与代理行为

管理前端继续使用同源相对路径访问 `/api`，无需把服务器 IP 编译进前端。Caddy 继续通过 `${APP_PORT:-8080}:80` 暴露入口，因此局域网客户端使用服务器私有 IP 和相同宿主端口即可访问。

前端无需维护 IP 白名单。若静态管理页面通过不允许的 Host 被取得，随后的会话或登录 API 会拒绝请求，页面不得显示任何已认证管理数据。

本次不自动发现服务器 IP、不修改防火墙、不配置路由器端口映射，也不把服务暴露到公网。

## 7. 部署与发布包

以下配置来源必须同步增加默认值：

- 根 `.env.example`：显式写入 `ALLOW_INSECURE_LAN_HTTP=false`。
- `docker-compose.yml`：API 环境使用 `${ALLOW_INSECURE_LAN_HTTP:-false}`。
- `tools/offline-package.mjs`：生成的离线 Compose 使用相同回退。
- 包内 README：说明如何开启、如何取得服务器私有 IP，以及只能在可信局域网使用。
- 根 README：同时说明本机默认和局域网模式。

半离线包的镜像平台、白名单、校验和、联网要求、归档结构和数据目录行为不改变。

## 8. 安全说明

局域网明文 HTTP 不提供传输加密。管理员密码、Cookie 和上传内容可能被同一网络路径上的恶意设备观察或篡改。因此：

- 开关必须默认关闭并由部署者显式开启。
- 只适用于受信任的家庭或办公局域网。
- 不得在访客 Wi-Fi、公共网络、校园共享网络或公网端口映射环境使用。
- 如果网络并非完全可信，应改用 HTTPS、VPN 或受信反向代理，不应依赖本开关。
- `TRUST_PROXY_SECRET`、密码、CSRF、登录限流和媒体权限边界不因本功能放宽。

## 9. 测试策略

实现必须遵循测试驱动开发，至少覆盖：

- 缺失或 `false` 时保持现有 localhost/环回允许、局域网 IP 拒绝行为。
- `true` 时接受三段 RFC1918 IPv4 地址和 IPv6 ULA，且端口与规范来源一致。
- `true` 时仍拒绝公网、未指定、链路本地、组播、广播、保留地址和域名。
- `true` 与 HTTPS、Secure Cookie 或非环回规范 `PUBLIC_ORIGIN` 混用时拒绝启动。
- 登录通过私有 IP 来源后签发不含 `Secure` 的 `HttpOnly`、`SameSite=Lax` Cookie。
- 私有 IP 下正确 Cookie、CSRF、Origin 和 Host 可以执行管理写操作。
- Origin/Host、端口或 CSRF 任一不匹配时仍拒绝。
- `.env.example`、生产 Compose 和离线 Compose 均传递相同默认值及显式覆盖值。
- 半离线包白名单、镜像平台与秘密排除测试不回归。
- 完整 Rust、前端、Node 契约、构建和 Playwright E2E 相关流程通过。

## 10. 验收标准

- 默认配置升级后仍只能通过本机环回来源完整操作后台。
- 开启开关后，局域网内其他电脑可以通过服务器私有 IP 和配置端口登录、上传、编辑、发布、归档和删除内容。
- 同时保留 localhost 的完整管理能力，但 localhost 与 IP 分别登录。
- 不需要为每个服务器私有 IP 增加配置项。
- 公网或不允许的地址不能利用开关通过管理来源校验。
- 用户文档清楚给出配置示例、访问 URL 和明文 HTTP 风险。

## 11. 非目标

- 公网 IP 或任意域名上的明文 HTTP 管理。
- 自动 TLS、IP 证书、域名证书或浏览器证书分发。
- VPN、零信任网络或外部身份认证集成。
- 自动识别网络可信度、客户端网段或服务器全部网卡。
- 跨 localhost 与 IP 共享浏览器 Cookie 或登录会话。
- 更改公开站、公开 API、内容生命周期、媒体格式或存储协议。
