# Movie Harbor 项目协作约定

## 当前阶段

项目已完成需求设计、UI Demo、生产应用、Docker Compose 部署、半离线发布工具、管理与公开内容分页，以及前后端公共函数整理。修改产品行为、接口、数据结构、媒体生命周期或部署机制前，必须先阅读主设计与主实现计划：

- `docs/superpowers/specs/2026-09-11-self-hosted-media-library-design.md`
- `docs/superpowers/plans/2026-09-11-self-hosted-media-library-implementation.md`

然后按变更领域阅读与本次变更直接相关的最新增量设计与实现计划，不要求读取该分类下所有历史文件。纯文档、格式、注释、已有流程执行和只读审阅只读取直接相关资料。以下索引用于按需选择：

### 内容与界面

- `docs/superpowers/specs/2026-10-10-private-content-and-viewer-accounts-design.md`
- `docs/superpowers/plans/2026-10-10-private-content-and-viewer-accounts.md`

- `docs/superpowers/specs/2026-09-12-series-episode-ux-revision-design.md`
- `docs/superpowers/plans/2026-09-12-series-episode-ux-revision.md`
- `docs/superpowers/specs/2026-09-14-published-series-view-collapse-design.md`
- `docs/superpowers/plans/2026-09-14-published-series-view-collapse.md`
- `docs/superpowers/specs/2026-09-14-season-editor-collapse-design.md`
- `docs/superpowers/plans/2026-09-14-season-editor-collapse.md`
- `docs/superpowers/specs/2026-09-15-admin-and-public-content-pagination-design.md`
- `docs/superpowers/plans/2026-09-15-admin-and-public-content-pagination.md`
- `docs/superpowers/specs/2026-09-16-admin-media-path-and-json-export-design.md`
- `docs/superpowers/plans/2026-09-16-admin-media-path-and-json-export.md`
- `docs/superpowers/plans/2026-09-16-export-year-and-genres.md`

### 媒体、部署与发布

- `docs/superpowers/specs/2026-09-12-media-ownership-and-publishing-design.md`
- `docs/superpowers/plans/2026-09-12-media-ownership-and-publishing.md`
- `docs/superpowers/specs/2026-09-12-host-data-bind-mounts-design.md`
- `docs/superpowers/plans/2026-09-12-host-data-bind-mounts-implementation.md`
- `docs/superpowers/specs/2026-09-12-offline-application-image-bundle-design.md`
- `docs/superpowers/plans/2026-09-12-offline-application-image-bundle.md`
- `docs/superpowers/specs/2026-09-13-default-local-config-design.md`
- `docs/superpowers/plans/2026-09-13-default-local-config.md`
- `docs/superpowers/specs/2026-09-14-hevc-mp4-upload-and-localized-error-design.md`
- `docs/superpowers/plans/2026-09-14-hevc-mp4-upload-and-localized-error.md`
- `docs/superpowers/specs/2026-09-14-high-profile-avcc-compatibility-design.md`
- `docs/superpowers/plans/2026-09-14-high-profile-avcc-compatibility.md`

### 工程与文档

- `docs/superpowers/specs/2026-09-12-readme-guide-design.md`
- `docs/superpowers/specs/2026-09-13-project-documentation-sync-design.md`
- `docs/superpowers/plans/2026-09-13-project-documentation-sync.md`
- `docs/superpowers/specs/2026-09-15-common-function-extraction-design.md`
- `docs/superpowers/plans/2026-09-15-common-function-extraction.md`

需求冲突按以下优先级处理：用户本次明确要求、同领域最新且已确认的增量规格、主规格。当前实现只作为现状证据，不自动覆盖规格。能够按上述优先级消解的冲突直接处理并说明依据；只有无法按优先级消解，且会实质改变结果、数据安全或任务范围的冲突才询问用户。

`demo/` 是已通过用户审核的视觉与交互参考。实现生产页面时应保持其信息层级、深色主题、紧凑表单和操作按钮布局，但不要把 Demo 的原生 DOM 代码直接当作生产架构。

## 技术栈

- 公开站：React、Vite、TypeScript。
- 管理后台：React、Vite、TypeScript，与公开站独立构建。
- 后端：Rust、Axum。
- 数据访问：SeaORM、PostgreSQL。
- 异步运行时与异步文件操作：Tokio。
- 部署：Docker Compose；同一域名下暴露 `/`、`/admin`、`/api` 和 `/media`。

回答库、框架、SDK、API、CLI 或云服务的用法问题，以及选择、修改或排查其 API/CLI 参数、配置和版本差异时，必须先通过 Context7 查询当前官方文档。优先采用稳定版本，除非任务明确要求预览版或候选版本。

执行仓库已经固定且验证过的命令、运行现有测试脚本，以及普通 `git status`、`git diff`、`git add`、`git commit` 等仓库操作，不要求重复查询 Context7。这只减少资料查询，不扩大文件、网络或外部系统权限。

## 实际目录边界

- `frontend/public-web/`：公开浏览、搜索、详情和播放。
- `frontend/admin-web/`：认证、内容管理、题材配置和系统设置。
- `frontend/packages/api-client/`：共享 API 类型与请求封装。
- `frontend/packages/ui/`：共享主题和基础交互组件。
- `frontend/packages/ui/src/pagination.ts`：管理后台与公开站共用的页码窗口算法。
- `backend/`：Axum API、SeaORM entities 与后端测试。
- `backend/src/admin_content/`：电影、剧集统一管理列表的筛选、排序和分页。
- `backend/src/admin_export/`：已认证管理员全量内容 JSON 导出，在只读可重复读事务中读取一致快照。
- `backend/src/content.rs`：电影、剧集和单集共用的字段、Patch 与生命周期基础规则。
- `backend/src/route_params.rs`：保留各领域错误语义的公共 UUID 路由参数解析。
- `backend/src/media/removal.rs`：媒体暂存、恢复、同步删除及删除事务收尾。
- `backend/migration/`：SeaORM 数据库迁移。
- `tests/`：根 Node 契约测试。
- `tests/e2e/`：Playwright 跨服务验收与安全 runner。
- `tools/`：半离线发布包构建入口与核心工具。
- `dist/offline/`：工具运行后构建生成且被 Git 忽略的半离线归档输出。
- `demo/`：审核通过的静态 UI Demo，不参与生产构建。
- `docs/superpowers/specs/`：已确认的产品与增量设计。
- `docs/superpowers/plans/`：逐任务实现计划。

## 领域约束

- 首版内容形态固定为电影和剧集。
- 剧集层级是“剧集 → 季 → 集”；季只保存季序号，单集名称必须由管理员输入。
- 电影、剧集和单集拥有草稿、已发布、已归档状态；只有草稿允许编辑。
- 已发布内容必须先归档，才能转回草稿或永久删除。
- 不设回收站，永久删除不可恢复。
- 已发布剧集允许新增季和草稿单集，但剧集自身保持只读。
- 有已发布单集的季不可修改季序号或删除。
- 公开 API 只能返回有效发布内容；匿名访客仅能发现公开内容，普通用户登录后可见全部已发布内容。管理员 Cookie 不扩大公开目录范围，普通用户无后台权限；草稿、归档和无权限私密内容统一表现为不存在。
- 电影和整剧拥有独立于生命周期的 `is_private`，所有状态都可用版本号并发校验切换；季和单集不保存访问范围，继承整剧。已有内容和缺少该字段的旧导入文件默认公开。
- 普通用户使用独立账号、Cookie 和会话；用户名不可修改且归一化后唯一。管理员或用户本人改密会原子撤销目标用户全部会话；删除用户级联删除会话。
- 视频不自动转码，只接受浏览器可直接播放的文件；首版不管理外挂字幕。
- 电影和剧集允许没有海报；公开页面使用无文字的纯色占位区域。
- 单集不保存简介；公开剧集详情按季、集序号展示名称和时长。
- 管理内容列表和公开内容目录固定每页 20 条，并使用数字页码；管理列表通过 `/api/admin/contents` 统一分页电影与剧集。
- 管理媒体 `local_path` 只表示由受控存储键派生的容器内路径，不允许客户端提交或修改，也不得进入公共 API。
- 内容 JSON 导出覆盖全部状态，不受筛选、搜索或分页影响；必须由后端读取一致快照，不得改为前端分页聚合或逐条请求详情。`year` 只在电影、剧集层级导出；`genres` 只含按 `sort_order`、ID 稳定排序的题材名称；不得给单集复制父级年份或题材。
- 媒体文件保存在挂载目录，数据库只保存受控文件标识和元数据。
- 媒体 URL 由内容状态、访问范围和会话实时授权。所有媒体请求由 Caddy 先调用后端授权，允许后再提供文件和 Range；管理员可预览各状态媒体。私密响应不进入共享缓存，不承诺防下载或防盗链。
- 媒体资产在电影海报、电影视频、剧集海报和单集视频槽位之间全局独占，不能共享。
- 删除电影、剧集、季或单集以及替换媒体时，成功响应前必须同步移除对应数据库记录和物理文件。
- 系统不运行周期媒体垃圾回收；启动恢复只处理带持久清单的中断删除或替换，不扫描并删除任意孤立文件。

## 宿主数据目录

- `DATABASE_HOST_DIR` 默认 `./data/postgres`，映射 PostgreSQL 的 `/var/lib/postgresql/data`。
- `MEDIA_HOST_DIR` 默认 `./data/media`，同时映射 API 的 `/media` 和 Caddy 的只读 `/srv/media`。
- 完整灾难恢复，以及任何可能同时改变数据库与媒体的操作，必须把数据库和媒体作为同一一致性备份集。
- 仅升级应用且保证媒体目录不变时，可以只创建数据库和部署文件安全备份，但不得称为完整灾备。如果迁移前置条件要求媒体一致备份，则必须暂停并取得媒体备份明确授权。
- 从既有命名卷部署切换到 bind mount 不会自动迁移数据。

## 半离线发布边界

- 半离线发布支持 `linux/arm64` 和 `linux/amd64`，不传平台参数时默认 `linux/arm64`。
- 每个归档只包含一个目标平台的三个自研镜像，不生成多架构单包或镜像清单。
- 归档只内置 API、公开站、管理后台三个自研运行镜像。
- 目标机仍须从 Docker Hub 获取固定版本 `postgres:17-alpine`、`caddy:2.10-alpine` 和 `alpine:3.22`。
- 包不包含源码、真实 `.env`、凭据、数据库或媒体数据。
- 输出固定在被 Git 忽略的 `dist/offline/`，构建工具拒绝覆盖同名产物。

## 开发工作流

- 当任务已有经用户确认的实现计划时，按计划中的任务顺序推进，每个任务形成可独立测试和审查的交付物。诊断、审阅和小型维护任务可以直接执行；改变多个组件或引入新的产品行为时，仍先完成设计和计划。
- 可执行代码的新功能、修复和行为变更必须先编写失败测试，确认失败原因后再实现最少代码。文档、Skill、静态配置和一次性运维规则采用与风险相符的契约测试、链接校验、schema 校验、构建或聚焦检查，不为满足形式要求编写无意义测试。
- 后端路由测试优先使用 `Router::oneshot`；事务、迁移和约束测试使用真实 PostgreSQL。
- 文件上传必须使用 Tokio 流式写入临时文件，校验成功后原子替换，禁止把大视频完整载入内存。
- 状态转换和删除约束必须在后端执行，不能只依赖前端隐藏按钮。
- 保持公开站、管理后台和后端 API 边界清晰，不跨目录复制业务逻辑。
- 新增功能前先检查现有公共边界：后端优先复用 `content.rs`、`route_params.rs` 和 `media/removal.rs`；前端优先复用 API 客户端、内容编辑辅助函数、剧集排序函数和共享页码算法。只有语义与变化原因一致的逻辑才提取，禁止建立无边界的全局 `utils`。
- 不实现设计规格明确列出的首版非目标。
- 不要修改或删除与当前任务无关的用户文件。

## 完成前验证

按实际变更范围运行足以验证本次工作的检查。无关检查不需要执行，也不需要为跳过无关检查向用户确认。只有实际运行并读取最新输出的检查才能报告为通过，不得将未运行的检查计入通过范围。

| 变更类型 | 必须执行的相关验证 |
| --- | --- |
| Rust 代码或迁移 | `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings` 与相关 Rust 测试；涉及数据库约束、事务或迁移时使用真实 PostgreSQL。 |
| 前端代码 | 受影响 workspace 的测试与构建；覆盖全部 workspace 时使用 `npm test --workspaces` 和 `npm run build --workspaces`。 |
| 根工具或契约 | 相关 Node 测试；覆盖根契约和 E2E runner 安全规则时使用 `node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs`。 |
| 修改跨服务代码、部署配置或发布工具 | 隔离的 Docker Compose 与 Playwright E2E：`npm run test:e2e`。 |
| 只执行已发布且已验证的部署包 | 使用项目部署 Skill 的生产验收，不要求重新运行本地构建与 E2E。 |
| 仅文档或 Skill | 相关文档契约（例如 `node --test tests/documentation.test.mjs`）、链接校验、适用的 Skill 校验和 `git diff --check`。 |

所有变更提交前均执行 `git diff --check`。Rust 数据库测试可用 `docker compose -f docker-compose.test.yml up -d postgres` 启动测试服务，再用 `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace` 执行相关测试；可按变更范围聚焦测试目标。

E2E runner 自行创建隔离的 Compose 项目和数据目录，不得改用生产默认的 `data/postgres` 或 `data/media`。不在文档中加入固定的数据库测试服务强制清理命令，以免误伤并行任务。
