# Movie Harbor 项目协作约定

## 当前阶段

项目已完成需求设计、UI Demo、生产应用、Docker Compose 部署、半离线发布工具、管理与公开内容分页、前后端公共函数整理，以及源码部署的多存储卷媒体支持。任何变更前都必须先阅读主设计与主实现计划：

- `docs/superpowers/specs/2026-09-11-self-hosted-media-library-design.md`
- `docs/superpowers/plans/2026-09-11-self-hosted-media-library-implementation.md`

然后按变更领域阅读对应的增量设计与实现计划：

### 内容与界面

- `docs/superpowers/specs/2026-09-12-series-episode-ux-revision-design.md`
- `docs/superpowers/plans/2026-09-12-series-episode-ux-revision.md`
- `docs/superpowers/specs/2026-09-14-published-series-view-collapse-design.md`
- `docs/superpowers/plans/2026-09-14-published-series-view-collapse.md`
- `docs/superpowers/specs/2026-09-14-season-editor-collapse-design.md`
- `docs/superpowers/plans/2026-09-14-season-editor-collapse.md`
- `docs/superpowers/specs/2026-09-15-admin-and-public-content-pagination-design.md`
- `docs/superpowers/plans/2026-09-15-admin-and-public-content-pagination.md`

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
- `docs/superpowers/specs/2026-09-16-multi-volume-media-storage-design.md`
- `docs/superpowers/plans/2026-09-16-multi-volume-media-storage.md`

### 工程与文档

- `docs/superpowers/specs/2026-09-12-readme-guide-design.md`
- `docs/superpowers/specs/2026-09-13-project-documentation-sync-design.md`
- `docs/superpowers/plans/2026-09-13-project-documentation-sync.md`
- `docs/superpowers/specs/2026-09-15-common-function-extraction-design.md`
- `docs/superpowers/plans/2026-09-15-common-function-extraction.md`

当前实现与日期较新的增量规格覆盖主规格中的旧约定，发生冲突时以当前实现与日期较新的增量规格为准。

`demo/` 是已通过用户审核的视觉与交互参考。实现生产页面时应保持其信息层级、深色主题、紧凑表单和操作按钮布局，但不要把 Demo 的原生 DOM 代码直接当作生产架构。

## 技术栈

- 公开站：React、Vite、TypeScript。
- 管理后台：React、Vite、TypeScript，与公开站独立构建。
- 后端：Rust、Axum。
- 数据访问：SeaORM、PostgreSQL。
- 异步运行时与异步文件操作：Tokio。
- 部署：Docker Compose；同一域名下暴露 `/`、`/admin`、`/api` 和 `/media`。

使用库、框架、SDK、API 或 CLI 前，必须先通过 Context7 查询当前官方文档。优先采用稳定版本，除非任务明确要求预览版或候选版本。

## 实际目录边界

- `frontend/public-web/`：公开浏览、搜索、详情和播放。
- `frontend/admin-web/`：认证、内容管理、题材配置和系统设置。
- `frontend/packages/api-client/`：共享 API 类型与请求封装。
- `frontend/packages/ui/`：共享主题和基础交互组件。
- `frontend/packages/ui/src/pagination.ts`：管理后台与公开站共用的页码窗口算法。
- `backend/`：Axum API、SeaORM entities 与后端测试。
- `backend/src/admin_content/`：电影、剧集统一管理列表的筛选、排序和分页。
- `backend/src/content.rs`：电影、剧集和单集共用的字段、Patch 与生命周期基础规则。
- `backend/src/route_params.rs`：保留各领域错误语义的公共 UUID 路由参数解析。
- `backend/src/media/removal.rs`：媒体暂存、恢复、同步删除及删除事务收尾。
- `backend/src/media/volumes.rs`：卷身份、容量探针、上传预留和多卷存储协调；`storage.rs` 负责单卷内的受控文件操作。
- `backend/migration/`：SeaORM 数据库迁移。
- `tests/`：根 Node 契约测试。
- `tests/e2e/`：Playwright 跨服务验收与安全 runner。
- `tools/`：半离线发布包构建入口与核心工具。
- `tools/storage-compose.mjs` 与 `tools/start-compose.sh`：源码部署的媒体卷标记初始化、Compose 存储覆盖文件生成及启动。
- `tools/upgrade-media-storage.sh` 与 `tools/upgrade-media-storage.mjs`：旧单卷的一次性特权登记与 pending 升级重试；不启动应用服务。
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
- 公开 API 只能返回有效发布内容；草稿和归档内容对访客表现为不存在。
- 视频不自动转码，只接受浏览器可直接播放的文件；首版不管理外挂字幕。
- 电影和剧集允许没有海报；公开页面使用无文字的纯色占位区域。
- 单集不保存简介；公开剧集详情按季、集序号展示名称和时长。
- 管理内容列表和公开内容目录固定每页 20 条，并使用数字页码；管理列表通过 `/api/admin/contents` 统一分页电影与剧集。
- 媒体文件保存在挂载目录，数据库只保存受控文件标识和元数据。
- 文件定位使用 `(storage_volume, storage_key)`；不得按容量或文件存在性猜测所属卷，公开 URL 为 `/media/v<编号>/<受控键>`。
- 各媒体类型按实际可用容量、安全保留空间和进程内上传预留选择健康卷；同一文件系统的逻辑卷共享一次容量采样、保留空间和在途预留，相同容量优先小编号，临时文件与正式文件始终位于同卷。
- 发布后的媒体 URL 是公开地址，不承诺防下载或防盗链。
- 媒体资产在电影海报、电影视频、剧集海报和单集视频槽位之间全局独占，不能共享。
- 删除电影、剧集、季或单集以及替换媒体时，成功响应前必须同步移除对应数据库记录和物理文件。
- 系统不运行周期媒体垃圾回收；启动恢复只处理带持久清单的中断删除或替换，不扫描并删除任意孤立文件。
- 跨卷替换和删除必须按数据库卷编号执行，预提交失败时恢复已隔离的旧文件；启动恢复扫描全部配置卷的持久清单，不跨卷复制文件。

## 宿主数据目录

- `DATABASE_HOST_DIR` 默认 `./data/postgres`，映射 PostgreSQL 的 `/var/lib/postgresql/data`。
- `MEDIA_HOST_DIR` 默认 `./data/media`，支持分号分隔的有序目录数组；多卷使用绝对路径，禁止空项、重复、替换、删除或重排已有项，只允许在末尾追加。
- 各卷映射 API 的 `/media/volumes/<编号>` 与 Caddy 只读的 `/srv/media/volumes/<编号>`，API 的 `MEDIA_DIRS` 由生成配置写入；每卷必须有匹配的 `.movie-harbor-volume.json` 标记。
- 部署目录（`.env` 所在目录）内的 `.movie-harbor-storage-state.json` 保存卷路径登记，须与全部数据共同备份；普通重启不得重建已有卷标记，登记缺失/损坏和原路径替换/重排/删除须在写标记或启动 Docker 前失败。
- 旧单卷权限升级必须先停止旧服务并完成一致备份，再显式运行 `./tools/upgrade-media-storage.sh --confirm-existing-volume-zero`；只接纳一个原路径，已有正常登记拒绝再次升级。普通启动遇到 pending 必须失败关闭，只能由专用入口核对原根身份后继续。
- 专用升级先持久保存 pending，再校验卷根和 marker；只有确认原 marker 缺失并持久记录发布许可后才可创建新 marker。拒绝根/marker 符号链接或特殊文件、错误标记、同路径替换及缺少真实旧版目录结构的空挂载点，不得通过普通重启自动认领。
- 媒体根统一使用 UID/GID `10001:10001`、权限 `0711`，非秘密卷标记为 `0644`；`.incoming`、`.quarantine`、`.operations` 保持 `0700`，不得递归 chmod/chown 或改变原媒体文件。
- `MEDIA_DISK_RESERVE_BYTES` 必须为正整数，默认每卷 10 GiB。缺盘、卷标记错误或数据库引用未配置卷时拒绝启动，不自动创建空卷冒充原盘。
- 数据库与全部媒体卷（含标记与恢复清单）必须作为同一一致性备份集；从既有命名卷部署切换到 bind mount 不会自动迁移数据。既有单目录升级为卷 0，不移动原文件。

## 半离线发布边界

- 首版只支持 `linux/arm64`。
- 归档只内置 API、公开站、管理后台三个自研运行镜像。
- 目标机仍须从 Docker Hub 获取固定版本 `postgres:17-alpine`、`caddy:2.10-alpine` 和 `alpine:3.22`。
- 包不包含源码、真实 `.env`、凭据、数据库或媒体数据。
- 输出固定在被 Git 忽略的 `dist/offline/`，构建工具拒绝覆盖同名产物。

## 开发工作流

- 按实现计划中的任务顺序推进，每个任务形成可独立测试和审查的交付物。
- 新功能、修复和行为变更必须先编写失败测试，确认失败原因后再实现最少代码。
- 后端路由测试优先使用 `Router::oneshot`；事务、迁移和约束测试使用真实 PostgreSQL。
- 文件上传必须使用 Tokio 流式写入临时文件，校验成功后原子替换，禁止把大视频完整载入内存。
- 状态转换和删除约束必须在后端执行，不能只依赖前端隐藏按钮。
- 保持公开站、管理后台和后端 API 边界清晰，不跨目录复制业务逻辑。
- 新增功能前先检查现有公共边界：后端优先复用 `content.rs`、`route_params.rs` 和 `media/removal.rs`；前端优先复用 API 客户端、内容编辑辅助函数、剧集排序函数和共享页码算法。只有语义与变化原因一致的逻辑才提取，禁止建立无边界的全局 `utils`。
- 不实现设计规格明确列出的首版非目标。
- 不要修改或删除与当前任务无关的用户文件。

## 完成前验证

根据变更范围执行以下命令的相关子集；只有运行并读取整组命令的最新输出后，才能声称完整交付通过：

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

涉及跨服务流程或部署时，还必须运行 Docker Compose 和 Playwright 端到端测试。E2E runner 自行创建带随机所有权标记的 Compose 项目、数据库目录、`media-0` 和 `media-1`，生成卷身份与覆盖文件，必须覆盖全部生产存储变量；清理仅允许本次运行根目录内已验证身份的目录，不得改用生产默认的 `data/postgres` 或 `data/media`。相同文件系统的真实容量按卷 0 确定性选择；跨卷容量差异由 Rust 注入 `CapacityProbe` 验证，不向生产增加伪造容量环境变量或 API。不在文档中加入固定的数据库测试服务强制清理命令，以免误伤并行任务。
