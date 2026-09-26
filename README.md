# Movie Harbor

## 项目简介

Movie Harbor 是一个面向个人或小型团队、可自行部署的电影与剧集媒体库。访客无需登录即可浏览、搜索和播放已发布内容；单一管理员通过独立后台维护电影、剧集、季、单集、题材、海报和视频。

## 当前状态

- 产品设计：已确认。
- UI Demo：已确认，保存在 `demo/`。
- 生产应用：已实现，可通过 Docker Compose 自托管。
- 内容列表：管理后台统一分页电影与剧集，公开站与管理后台均固定每页 20 条并支持数字页码。
- 媒体能力：支持同步删除与替换、启动恢复、H.264/HEVC MP4 和 WebM。
- 管理导出：详情展示视频容器内路径，支持一次下载全部内容的只读 JSON。
- 发布工具：支持生成 `linux/arm64` 和 `linux/amd64` 单平台半离线 Docker 部署包，默认使用 `linux/arm64`。

## 核心设计

- 内容支持电影和“剧集 → 季 → 集”两种结构。
- 电影、剧集和单集具有草稿、已发布、已归档状态，只有草稿可以编辑。
- 电影和剧集可不上传海报；缺失或加载失败时显示无文字的纯色占位。
- 单集不保存独立简介，详情页按季、集序号展示名称和时长。
- 访客无需账号；观看进度只保存在当前浏览器。
- 管理后台采用单一管理员账号。
- 视频不自动转码，管理员上传浏览器可直接播放的文件。
- 海报和视频保存在本地持久化媒体目录。
- 首版使用 Docker Compose 面向 NAS、个人服务器或小型 VPS 部署。

## 技术栈

- 公开站与管理后台：React + Vite + TypeScript，分别构建。
- 后端：Rust + Axum。
- 数据库访问：SeaORM + PostgreSQL。
- 异步运行时与文件操作：Tokio。
- 对外入口：同一域名下的 `/`、`/admin`、`/api` 和 `/media`。

## 使用与运维文档

- [部署指南](docs/guides/deployment.md)：生产部署、访问模式、环境变量、上传格式与容量。
- [半离线发布指南](docs/guides/offline-package.md)：构建、校验、目标机部署与升级。
- [内容迁移指南](docs/guides/content-transfer.md)：管理媒体路径、JSON 导出与可恢复导入。
- [媒体与备份指南](docs/guides/media-and-backup.md)：目录权限、同步删除、迁移 v5、一致备份与恢复。

## 开发文档

- [开发指南](docs/guides/development.md)：源码环境、测试与构建、E2E、UI Demo 和目录结构。
- [数据库表设计](docs/guides/database-schema.md)：当前表结构、关系、约束、索引和触发器。

## 产品设计与实现记录

核心文档：

- [产品设计规格](docs/superpowers/specs/2026-09-11-self-hosted-media-library-design.md)
- [主实现计划](docs/superpowers/plans/2026-09-11-self-hosted-media-library-implementation.md)
- [协作约定](AGENTS.md)

当前关键增量：

- [媒体独占归属与发布体验](docs/superpowers/specs/2026-09-12-media-ownership-and-publishing-design.md)
- [宿主机数据目录映射](docs/superpowers/specs/2026-09-12-host-data-bind-mounts-design.md)
- [半离线 Docker 发布包](docs/superpowers/specs/2026-09-12-offline-application-image-bundle-design.md)
- [Linux AMD64 半离线发布包](docs/superpowers/specs/2026-09-23-linux-amd64-offline-package-design.md)
- [本机默认配置一致性](docs/superpowers/specs/2026-09-13-default-local-config-design.md)
- [HEVC MP4 上传与中文错误反馈](docs/superpowers/specs/2026-09-14-hevc-mp4-upload-and-localized-error-design.md)
- [管理与公开内容列表分页](docs/superpowers/specs/2026-09-15-admin-and-public-content-pagination-design.md)
- [前后端公共函数提取](docs/superpowers/specs/2026-09-15-common-function-extraction-design.md)
- [管理媒体路径显示与内容 JSON 导出](docs/superpowers/specs/2026-09-16-admin-media-path-and-json-export-design.md)

完整设计和实施记录位于 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`。

## 首版不包含

- 自动转码和码率自适应。
- 外挂字幕管理。
- 多管理员或角色权限。
- 服务端观看历史、收藏、评分和评论。
- 第三方元数据导入。
- S3、MinIO 等对象存储。
- 防下载、数字版权保护或可靠的防盗链。
