# 部署指南

本文说明生产部署、访问模式、环境变量以及上传格式与容量。

[返回项目 README](../../README.md)

## 生产部署

要求安装 Docker Engine 与 Docker Compose v2。复制环境变量示例并替换密码与代理秘密；根据实际访问方式选择下方的本机、可信局域网或 HTTPS 配置：

```bash
cp .env.example .env
docker compose -p movie-harbor up -d --build --wait
```

默认本机入口是 `http://localhost:8080`。公开站位于 `/`，管理后台位于 `/admin/`，API 位于 `/api/`，媒体位于 `/media/`。PostgreSQL 不暴露宿主端口。修改 `APP_PORT` 时，即使仍从本机访问，也必须同步修改 `PUBLIC_ORIGIN` 的端口，例如改为 `http://localhost:9090`；可信局域网请求也只允许使用这个端口。

默认 `ALLOW_INSECURE_LAN_HTTP=false`，配合 `PUBLIC_ORIGIN=http://localhost:8080` 和 `COOKIE_SECURE=false`，只能从本机的 localhost 或环回地址完整操作管理后台。若改用 `http://127.0.0.1:8080`，必须将 `PUBLIC_ORIGIN` 改为这个实际来源；仅打开另一台电脑上的管理页面并不能完成登录和管理操作。

仅在受信任局域网内需要从其他设备管理时，可在 `.env` 中保持 `PUBLIC_ORIGIN=http://localhost:8080` 和 `COOKIE_SECURE=false`，将 `ALLOW_INSECURE_LAN_HTTP=true`，然后执行 `docker compose -p movie-harbor up -d --build --wait` 重新创建容器，使新的环境变量生效；仅执行 `docker compose restart` 不会更新容器环境变量。从另一台电脑访问 `http://192.168.1.20:8080/admin/`，把 `192.168.1.20` 换成服务器的私有数字 IP。允许的 LAN 来源只接受私有 IPv4 或 IPv6 ULA 数字 IP，不接受局域网主机名；端口必须与 `PUBLIC_ORIGIN` 一致。localhost 与 IP 的 Cookie 分开保存，因此需要分别登录。此开关不会自动配置主机防火墙、路由器或网络可达性。

正式部署使用 HTTPS：把 `PUBLIC_ORIGIN` 设置为浏览器实际访问的 `https://` 来源（协议、主机名和非默认端口，不含路径），设置 `COOKIE_SECURE=true`、`ALLOW_INSECURE_LAN_HTTP=false`，并由部署者配置域名和 TLS 终止层。包内 Caddy 只提供 HTTP，不会自动取得证书。

局域网开关允许明文 HTTP，仅适用于受信任局域网；管理员密码和会话 Cookie 在网络传输途中可能被观察或篡改。访客 Wi-Fi、公共网络和公网端口映射不得启用该开关，也不能把它当作公网安全配置；这些环境应使用加密访问。

首次启动时，API 自动执行数据库迁移。只有数据库内尚无管理员时，`ADMIN_NAME` 和 `ADMIN_INITIAL_PASSWORD` 才会创建初始账号；之后修改 `.env` 或重启容器都不会覆盖已有管理员名称和密码。首次登录并修改密码后，应从 `.env` 移除初始凭据或换成无意义的占位值，但其余必填变量仍须保留。

关键环境变量：

| 变量 | 示例默认值 | 说明 |
| --- | --- | --- |
| `APP_PORT` | `8080` | 宿主机入口端口；修改后同步调整 `PUBLIC_ORIGIN`。 |
| `DATABASE_HOST_DIR` | `./data/postgres` | PostgreSQL 宿主机持久目录。 |
| `MEDIA_HOST_DIR` | `./data/media` | 海报和视频宿主机持久目录。 |
| `POSTGRES_DB` / `POSTGRES_USER` | `movie_harbor` | Compose 使用的数据库名与账号。 |
| `POSTGRES_PASSWORD` | 无安全默认值 | 必须替换为随机数据库密码。 |
| `ADMIN_NAME` / `ADMIN_INITIAL_PASSWORD` | `admin` / 无安全默认值 | 仅在空库首次创建管理员时使用。 |
| `PUBLIC_ORIGIN` | `http://localhost:8080` | 默认本机来源；修改 `APP_PORT` 时同步改端口，正式 HTTPS 部署改为实际 `https://` 来源。可信局域网模式保持本机来源。 |
| `COOKIE_SECURE` | `false` | 本机和显式开启的可信局域网 HTTP 使用 `false`；正式 HTTPS 部署设为 `true`。 |
| `ALLOW_INSECURE_LAN_HTTP` | `false` | 默认只允许本机完整操作后台；仅在受信任局域网中显式设为 `true`，允许同端口的私有数字 IP HTTP 管理访问。 |
| `TRUST_PROXY_SECRET` | 无安全默认值 | Caddy 与 API 之间的独立代理认证秘密，至少 32 字节。 |
| `MAX_UPLOAD_BYTES` | `53687091200` | 单文件上限，默认 50 GiB。 |
| `VIDEO_MIME_ALLOWLIST` | `video/mp4,video/webm` | 允许进入结构化格式校验的视频 MIME。 |

数据库连接必须二选一：直接运行 API 时可只设置 `DATABASE_URL`；Compose 使用 `DATABASE_HOST`、`DATABASE_PORT`、`POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD` 这组分项变量。为避免迁移和运行时误连不同数据库，两种方式同时出现时 API 会拒绝启动。

登录限流默认只信任 API 连接的对端地址，并忽略客户端提供的 `X-Forwarded-For`。标准 Compose 不向宿主机暴露 API，由 Caddy 覆盖该请求头为实际客户端地址，并用独立的 `TRUST_PROXY_SECRET` 向 API 认证代理身份。请把示例值替换为至少 32 字节的随机秘密且不要复用其他密码。仅当 API 只能由持有该秘密且会覆盖（而非追加）该请求头的受信反向代理访问时才可开启 `TRUST_PROXY_HEADERS`；直接暴露 API 时必须保持关闭。

本机、可信局域网和正式 HTTPS 的来源、Cookie 与传输边界见上方部署说明。使用域名、公共网络或公网访问时，必须由部署者提供加密入口，并确保 `PUBLIC_ORIGIN` 与浏览器实际来源一致。

常用运维命令：

```bash
docker compose -p movie-harbor ps
docker compose -p movie-harbor logs -f api caddy
docker compose -p movie-harbor restart
docker compose -p movie-harbor pull
docker compose -p movie-harbor up -d --build --wait
```

`docker compose down` 不会删除当前通过 bind mount 保存的数据库和媒体目录；真正的数据边界是 `DATABASE_HOST_DIR` 与 `MEDIA_HOST_DIR` 指向的宿主机路径。不要在未完成一致备份时删除、清空或改指这两个目录。

## 内容访问与会话

电影和整部剧集可分别设置公开或私密，切换无需改变发布状态。匿名访客只能浏览、搜索和播放已发布公开内容；普通用户登录后可查看全部已发布内容。季与单集继承整剧访问范围，草稿或归档单集仍不可观看。后台“用户管理”可添加普通用户、修改密码和删除用户；用户名不可修改，用户名不区分大小写。公开站的普通用户登录与管理员登录相互独立，管理员会话不扩大公开目录可见范围。

所有 `/media/*` 请求（包括海报、HEAD、条件请求与 Range）都在 Caddy 读取文件前进行后端授权。授权根据受控存储键查找唯一媒体所有者，并实时核验发布状态、访问范围和会话；允许后由 Caddy 发送文件，不由 API 读取大视频。无权限、无归属或异常路径统一返回 `404`。目录、详情和媒体响应使用 `Cache-Control: private, no-store`，认证响应使用 `no-store`；反向代理或 CDN 不应覆盖它们或缓存授权结果。切换私密、归档、改密或删除用户后的新请求立即使用新权限；已经传出的字节无法撤回。

管理员 Cookie `mh_session` 和普通用户 Cookie `mh_viewer_session` 都使用 `Path=/`、`HttpOnly`、`SameSite=Lax`，`Secure` 由 `COOKIE_SECURE` 控制。管理员 Cookie 扩大路径是为了后台海报与视频预览；公共目录只识别普通用户会话。升级后的管理员登录、退出及改密流程会清除旧 `/api/admin` 路径 Cookie，避免同名 Cookie 共存。修改普通用户密码会在同一事务中撤销该用户全部会话，包括当前设备；用户自助改密须验证当前密码。删除用户也会级联撤销全部会话。

媒体授权接口 `/api/media/authorize` 仅供受信 Caddy 内部调用，外部请求返回 `404`；不得绕过 Caddy 直接暴露媒体挂载目录。现有的来源校验、代理秘密和 HTTPS 要求同样适用于普通用户登录及写操作。

## 上传格式与容量

- 海报：JPEG、PNG、WebP。后端同时检查扩展名、MIME 和实际图片内容。
- 支持 WebM。
- 支持 H.264 MP4。
- 支持 HEVC MP4 的 `hvc1`、`hev1` 样本项。
- 实际播放能力仍取决于访问者浏览器和操作系统对 HEVC 的支持；服务不会自动转码。
- `MAX_UPLOAD_BYTES` 是单文件上限，默认值为 50 GiB（`53687091200` 字节），不是媒体库总容量或推荐文件大小。规划磁盘时需同时预留正式媒体、上传临时文件和替换期间新旧文件的空间。
- `/media` 在每次请求时授权，并支持浏览器 Range 请求；不提供防下载、DRM 或可靠防盗链。

数据目录权限、迁移 v5 和备份恢复见[媒体与备份指南](media-and-backup.md)；使用发布包部署见[半离线发布指南](offline-package.md)。
