# Movie Harbor 宿主机数据目录映射设计

## 目标

将生产 `docker-compose.yml` 中 PostgreSQL 数据和上传媒体从 Docker 命名卷改为宿主机绑定目录，使数据能够在启动后直接保存到用户可见、可备份的本地路径。

## 方案选择

- 不采用硬编码绝对路径，因为配置无法跨主机复用。
- 不继续使用命名卷，因为数据不会直接出现在用户指定的普通目录中。
- 采用环境变量加仓库内默认值：`DATABASE_HOST_DIR` 默认 `./data/postgres`，`MEDIA_HOST_DIR` 默认 `./data/media`；用户可在 `.env` 中替换为任意绝对路径。

Compose 使用 bind mount 长格式，并允许首次启动时创建不存在的宿主机目录。相对路径以 Compose 项目目录为基准。

## 服务映射

- `postgres`：将 `DATABASE_HOST_DIR` 读写挂载到 `/var/lib/postgresql/data`。
- `media-init`：将 `MEDIA_HOST_DIR` 读写挂载到 `/media`，沿用 UID `10001` 和 `0700` 权限初始化。
- `api`：将同一个 `MEDIA_HOST_DIR` 读写挂载到 `/media`。
- `caddy`：将同一个 `MEDIA_HOST_DIR` 只读挂载到 `/srv/media`。
- 删除不再使用的顶层 `database_data` 和 `media_data` 命名卷声明。

## 配置与版本库边界

- 在 `.env.example` 增加两个宿主机目录变量及默认示例。
- 在 `.gitignore` 忽略 `/data/`，避免数据库和媒体文件进入 Git。
- 已存在的命名卷不会自动迁移；切换挂载前必须停止服务并单独迁移数据库和媒体数据。

## 验证

- 先用配置级检查证明当前 Compose 仍使用命名卷。
- 修改后运行 `docker compose config`，确认四个服务解析为预期的 bind mount，且 Caddy 媒体挂载为只读。
- 使用临时宿主机目录覆盖两个环境变量运行 Compose 配置检查，避免污染真实数据目录。
- 运行 `git diff --check` 并核对仅修改规格、Compose、环境变量示例和忽略规则。
