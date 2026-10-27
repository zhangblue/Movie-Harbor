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
- Codex 入库：提供独立 MCP，可检查、转换和上传本地视频，并在分阶段确认后创建与发布内容。
- 发布工具：支持生成 `linux/arm64` 和 `linux/amd64` 单平台半离线 Docker 部署包，默认使用 `linux/arm64`。

## 核心设计

- 内容支持电影和“剧集 → 季 → 集”两种结构。
- 电影、剧集和单集具有草稿、已发布、已归档状态，只有草稿可以编辑。
- 电影和剧集可不上传海报；缺失或加载失败时显示无文字的纯色占位。
- 单集不保存独立简介，详情页按季、集序号展示名称和时长。
- 访客无需账号；观看进度只保存在当前浏览器。
- 管理后台采用单一管理员账号。
- 网站服务端的视频不自动转码，管理员上传浏览器可直接播放的文件。
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
- [视频转换指南](docs/guides/video-conversion.md)：上传前的本机单文件转换、依赖与字幕限制。
- [媒体与备份指南](docs/guides/media-and-backup.md)：目录权限、同步删除、迁移 v5、一致备份与恢复。
- [Codex 视频入库 MCP 安装与使用指南](docs/guides/codex-mcp.md)：全局安装、远程服务配置、实际对话示例、独立密钥、转换、入库与发布确认。

## Codex 视频入库 MCP

MCP 提供以下 24 个可调用函数（工具）。安装、配置与对话示例见 [MCP 安装与使用指南](docs/guides/codex-mcp.md)。

### 文件检查与转换

| 函数 | 作用 |
| --- | --- |
| `inspect_video` | 只读检查本地视频的容器、编码、音轨、字幕轨、秒数时长及上传兼容性，返回需要时的转换方案。 |
| `validate_poster` | 只读检查用户提供的本地海报格式与基本结构；上传后的服务端完整解码是最终校验。 |
| `convert_video` | 单独确认后，将不兼容视频转换为受控目录中的 MP4，保留原视频。 |
| `delete_generated_video` | 仅删除由 MCP 转换生成且文件身份仍匹配的视频，不删除原视频。 |

### 内容与题材查询

| 函数 | 作用 |
| --- | --- |
| `search_movies` | 按名称查询电影候选，返回状态、版本、访问范围、整数分钟时长及海报和视频是否存在；不自动选择或合并。 |
| `search_series` | 按名称查询剧集候选，返回状态、版本、访问范围、海报是否存在及季、集数量；不自动选择或合并。 |
| `get_series_structure` | 只读获取指定剧集的季、单集、集名、秒数时长、状态、版本及视频是否存在。 |
| `list_genres` | 只读列出全部题材，包括启用和停用项。 |

### 创建与元数据维护

| 函数 | 作用 |
| --- | --- |
| `create_genre` | 创建题材；精确同名的启用项直接复用，停用同名项交由管理员处理。 |
| `stage_poster` | 验证并暂存本地海报，返回有有效期的凭证，供创建电影或剧集时绑定海报。 |
| `create_movie` | 使用名称、简介、年份、题材、整数分钟时长和暂存海报凭证创建电影草稿；默认公开，也可选择私密。 |
| `create_series` | 使用名称、简介、年份、题材和暂存海报凭证创建剧集草稿；默认公开，也可选择私密，季和单集需另行创建。 |
| `create_season` | 在指定剧集下按季号创建一个季，使用剧集版本进行并发校验。 |
| `create_episode` | 在指定季下按集号、名称和秒数时长创建单集草稿；时长自动按分钟四舍五入，最少 1 分钟，访问范围继承整剧。 |
| `update_movie_metadata` | 按电影 ID 和版本修改草稿中明确提交的名称、简介、年份、题材或整数分钟时长。 |
| `update_series_metadata` | 按剧集 ID 和版本修改草稿中明确提交的名称、简介、年份或题材。 |
| `update_episode_metadata` | 按剧集、季、单集 ID 和单集版本修改草稿的集号、名称或时长；提交时长时自动按分钟四舍五入，最少 1 分钟。 |

### 视频上传与替换

| 函数 | 作用 |
| --- | --- |
| `upload_movie_video` | 将本地兼容视频流式上传到电影的空视频槽，不覆盖已有视频，不自动发布。 |
| `replace_movie_video` | 按确认计划流式替换电影已有视频，成功后同步移除旧视频，不自动发布。 |
| `upload_episode_video` | 将本地兼容视频流式上传到指定单集的空视频槽，不覆盖已有视频，不自动发布。 |
| `replace_episode_video` | 按确认计划流式替换指定单集已有视频，成功后同步移除旧视频，不自动发布。 |

### 发布

| 函数 | 作用 |
| --- | --- |
| `publish_movie` | 独立确认后发布电影，不改变访问范围或其他元数据。 |
| `publish_episode` | 独立确认后仅发布指定单集，不自动发布父剧集。 |
| `publish_series` | 在单集发布后，再次单独确认发布父剧集；至少需要一个已发布单集。 |

创建与上传前必须先确认完整入库计划；转换、入库和发布分别确认。公开草稿在发布前仍不可见。电影时长使用整数分钟；单集工具接收整数秒，写入时取整为整分钟对应的秒数。通用视频探测和转换保留秒数，所有写操作仍须遵守草稿编辑、版本校验和媒体独占约束。

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

- 服务端自动转码和码率自适应。
- 外挂字幕管理。
- 多管理员或角色权限。
- 服务端观看历史、收藏、评分和评论。
- 第三方元数据导入。
- S3、MinIO 等对象存储。
- 防下载、数字版权保护或可靠的防盗链。
