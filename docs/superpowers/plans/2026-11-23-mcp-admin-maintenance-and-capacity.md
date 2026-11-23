# MCP 管理维护与上传容量保护实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Movie Harbor MCP 增加统一访问范围、海报、缺视频查询、系统概览和生命周期工具，并在所有视频上传前后端实施按新文件大小计算的容量保护。

**架构：** MCP 保持原子工具边界，通过现有精确管理接口和一个新的缺视频分页接口完成管理操作；后端只扩大逐条列出的 MCP 路由白名单。容量保护分为 MCP 传输前预检和媒体存储锁内权威复核，管理后台与 MCP 都声明真实视频字节数，服务端在消费流前检查容量并在流结束时核对实际大小。

**技术栈：** TypeScript 6、Node.js ESM、Model Context Protocol TypeScript SDK 2.3、Zod 4；Rust 2024、Axum 0.8、SeaORM 1.1、Tokio、PostgreSQL；React 19、Vite 8、Vitest、Playwright。

**规格：** `docs/superpowers/specs/2026-11-23-mcp-admin-maintenance-and-capacity-design.md`

## 全局约束

- 五项能力必须保持独立原子工具，禁止增加一键维护或批量修复工具。
- `set_content_visibility` 只支持 `movie|series`；季和单集继续继承整剧访问范围。
- `set_content_poster` 只支持补传或替换电影、整剧海报，不得提供删除语义，且目标必须为草稿。
- `list_missing_videos` 必须显式传 `content_type=movie|series`，固定每页 20 条，不提供混合返回。
- `transition_content_lifecycle` 支持 `movie|series|episode`，但只有 `published -> draft` 自动执行“归档 → 草稿”。
- 删除 MCP 工具 `publish_movie`、`publish_series`、`publish_episode`，不保留别名；后端发布路由保持不变。
- 容量判定固定为 `available_bytes >= new_video_bytes + reserve_bytes`，`reserve_bytes` 当前为 10 GiB；溢出、容量未知或不可接受上传均拒绝。
- 容量只按最终新视频大小计算，不估算转换产物、Multipart 开销、临时文件或新旧文件峰值，替换时不抵扣旧视频。
- 海报和视频继续使用 Tokio 流式读写、服务端完整校验、受控存储键和同步原子替换，不得把大文件读入内存。
- 所有写工具要求 `confirmed: true`、乐观版本和精确层级；工具确认不能替代后端认证、状态或版本校验。
- MCP 仍禁止删除、用户管理、密码、导出、备份和任意系统接口。
- 所有新增或修改的命名函数、类型、DTO、测试和关键调用点同步维护中文注释。
- 每个任务先写失败测试并确认失败原因，再实现最少代码；每个任务独立提交。

## 审查重点（Review Focus）

- `published -> draft` 的第二个请求失败或响应未知时，用户必须看到部分完成/状态未知，不能误以为内容仍已发布；任务 1 的部分完成测试钉住此行为。
- 单集生命周期请求中的剧集、季或单集 ID 被交叉替换时，必须在任何写操作前拒绝；任务 1 的层级归属测试覆盖。
- 缺视频查询遇到空剧集、同名剧集、重复季集号边界或翻页时，必须稳定返回真实单集而不遗漏或虚构；任务 3 的真实 PostgreSQL 分页排序测试覆盖。
- 声明文件大小小于实际流、加法溢出或容量读取失败时，必须在最早安全阶段拒绝并保留旧视频；任务 5 的存储与路由测试覆盖。
- 两个并发视频上传不能共享同一过期容量快照；任务 5 使用可控容量读取器和存储锁顺序断言覆盖。

---

## 文件结构

### MCP

- 创建 `mcp/src/schemas/admin-maintenance.ts`：五个新工具及系统概览、缺视频分页的 Zod 契约。
- 创建 `mcp/src/tools/content-maintenance.ts`：访问范围和统一生命周期工具。
- 创建 `mcp/src/tools/posters.ts`：本机海报补传与原子替换工具。
- 创建 `mcp/src/tools/admin-query.ts`：缺视频查询和只读系统概览工具。
- 删除 `mcp/src/tools/publishing.ts`：移除被统一生命周期工具覆盖的三个旧发布工具。
- 修改 `mcp/src/server.ts`：注册新工具、移除旧发布注册并更新工作流提示。
- 修改 `mcp/src/services/movie-harbor-client.ts`：受控 `PUT` 和视频声明大小请求头。
- 修改 `mcp/src/tools/{movies,series,synopsis,uploads}.ts`：后续动作改指向统一生命周期工具；上传工具执行容量预检。
- 修改 `mcp/tests/{client,server,content-tools,synopsis-tools,upload-publish-tools}.test.ts`：更新旧契约并覆盖容量预检。
- 创建 `mcp/tests/admin-maintenance-tools.test.ts`：五个新工具的聚焦契约和失败路径。

### 后端

- 修改 `backend/src/auth/mcp.rs`：增加精确 PUT、海报、缺视频、概览和单集状态路由白名单。
- 修改 `backend/src/admin_content/{dto,query,routes}.rs`：新增缺视频判别式分页 DTO、查询和路由。
- 修改 `backend/src/media/{mod,routes,storage,upload}.rs`：解析声明大小、锁内容量复核、实际大小核对和稳定错误。
- 修改 `backend/tests/{mcp_auth,admin_content,admin_system,media_upload}.rs`：权限、查询、容量和保留旧媒体测试。

### 管理前端与共享客户端

- 修改 `frontend/packages/api-client/src/{http,admin}.ts`：XHR/fetch 上传携带 `X-Media-Byte-Size`。
- 修改 `frontend/packages/api-client/src/{http,admin}.test.ts`：普通上传和进度上传请求头契约。
- 修改 `frontend/admin-web/src/movies/MovieEditor.test.tsx` 和 `frontend/admin-web/src/series/SeriesEditor.test.tsx`：编辑器上传集成断言及容量错误展示回归。

### 文档与跨服务

- 修改 `docs/guides/codex-mcp.md`：新工具、旧工具移除、组合流程和容量错误排查。
- 修改 `tests/documentation.test.mjs`：文档工具表与注册工具保持一致。
- 修改 `tests/e2e/mcp.spec.ts`：新 MCP 管理工具的跨服务验收。
- 修改或创建 `tests/e2e/admin-media-capacity.spec.ts`：声明超大视频在写入前被拒绝且原槽位不变。

---

### 任务 1：统一访问范围与生命周期工具

**文件：**
- 创建：`mcp/src/schemas/admin-maintenance.ts`
- 创建：`mcp/src/tools/content-maintenance.ts`
- 删除：`mcp/src/tools/publishing.ts`
- 修改：`mcp/src/services/movie-harbor-client.ts`
- 修改：`mcp/src/server.ts`
- 修改：`mcp/src/tools/movies.ts`
- 修改：`mcp/src/tools/series.ts`
- 修改：`mcp/src/tools/synopsis.ts`
- 修改：`mcp/src/tools/uploads.ts`
- 修改：`backend/src/auth/mcp.rs`
- 测试：`mcp/tests/admin-maintenance-tools.test.ts`
- 测试：`mcp/tests/client.test.ts`
- 测试：`mcp/tests/server.test.ts`
- 测试：`mcp/tests/content-tools.test.ts`
- 测试：`mcp/tests/synopsis-tools.test.ts`
- 测试：`mcp/tests/upload-publish-tools.test.ts`
- 测试：`backend/tests/mcp_auth_test.rs`

- [ ] **步骤 1：编写失败的后端白名单和 MCP 客户端测试**

在 `backend/tests/mcp_auth_test.rs` 增加断言：只允许合法 UUID 的电影/整剧隐私 `PUT`，以及单集 `publish|archive|draft` `POST`；拒绝单集隐私、非法 UUID、额外路径段和 `DELETE`。在 `mcp/tests/client.test.ts` 断言 `json("PUT", ...)` 只向同源 `/api/admin/` 发送 JSON，其他方法或越界 URL 仍拒绝。

- [ ] **步骤 2：运行聚焦测试确认失败**

运行：`cargo test -p movie-harbor-api --test mcp_auth_test route_allowed -- --nocapture`

运行：`npm test --prefix mcp -- --test-name-pattern="PUT|lifecycle|visibility"`

预期：FAIL，PUT 和单集归档/草稿尚未进入白名单，MCP 客户端类型也不接受 PUT。

- [ ] **步骤 3：实现精确白名单和受控 PUT**

修改 `route_allowed`，只增加规格列出的路径模式；把 `HttpMethod` 扩为 `GET|POST|PATCH|PUT`，保持 `controlledUrl`、同源和敏感信息清理不变。

- [ ] **步骤 4：编写五类生命周期失败测试**

在 `mcp/tests/admin-maintenance-tools.test.ts` 钉住以下契约：

- `set_content_visibility({content_type,content_id,version,visibility,confirmed:true})` 映射正确路径和 `is_private`，校验响应 ID、范围和版本。
- `transition_content_lifecycle` 对电影、整剧、单集分别读取详情并调用正确路由。
- 当前状态等于目标状态时不发送写请求。
- `draft -> archived` 在写请求前拒绝。
- `published -> draft` 先 archive，再使用返回版本 draft，输出 `transitioned_through:["archived","draft"]`。
- 第二步失败时抛出带 `partial_transition` 机器码/稳定中文说明的错误，不发送发布补偿。
- 单集返回的 `series_id`、`season_id` 或 `episode_id` 任一不匹配时，在 POST 前拒绝。
- `confirmed` 不是字面量 `true` 时 schema 拒绝。

- [ ] **步骤 5：运行新工具测试确认失败**

运行：`npm test --prefix mcp -- --test-name-pattern="visibility|lifecycle|partial transition"`

预期：FAIL，新 schema、工具和错误类型尚不存在。

- [ ] **步骤 6：实现统一工具并删除旧发布工具**

在 `admin-maintenance.ts` 定义严格输入、判别式输出及 API 响应 schema。在 `content-maintenance.ts` 实现：

```ts
export function registerContentMaintenanceTools(server: McpServer, client: MovieHarborClient): void
export async function setContentVisibility(input: unknown, client: MovieHarborClient): Promise<ToolResult>
export async function transitionContentLifecycle(input: unknown, client: MovieHarborClient): Promise<ToolResult>
```

生命周期路径只允许规格矩阵；单集路径必须携带完整层级。把旧发布工具的响应所有权、版本增长和父剧集版本校验迁入统一工具后删除 `publishing.ts` 及注册。

- [ ] **步骤 7：更新所有后续动作名称和服务器契约**

把 `publish_movie|publish_episode|publish_series` 的 `next_actions` 改为 `transition_content_lifecycle`，同时保留文字上的“发布需要单独确认”。更新 `server.test.ts` 的完整工具清单：删除三个旧工具，加入两个本任务工具；更新说明，禁止自动发布。

- [ ] **步骤 8：运行聚焦测试验证通过**

运行：`cargo test -p movie-harbor-api --test mcp_auth_test`

运行：`npm test --prefix mcp -- --test-name-pattern="PUT|visibility|lifecycle|server registers|next_actions"`

预期：PASS，新工具覆盖旧发布功能，旧工具不再注册。

- [ ] **步骤 9：提交**

```bash
git add backend/src/auth/mcp.rs backend/tests/mcp_auth_test.rs mcp/src mcp/tests
git commit -m "feat: unify MCP content lifecycle management"
```

### 任务 2：统一海报补传与替换工具

**文件：**
- 创建：`mcp/src/tools/posters.ts`
- 修改：`mcp/src/schemas/admin-maintenance.ts`
- 修改：`mcp/src/server.ts`
- 修改：`backend/src/auth/mcp.rs`
- 测试：`mcp/tests/admin-maintenance-tools.test.ts`
- 测试：`mcp/tests/server.test.ts`
- 测试：`backend/tests/mcp_auth_test.rs`

- [ ] **步骤 1：编写失败的工具与权限测试**

增加测试：电影和整剧海报 POST 仅对合法 UUID 放行；`set_content_poster` 只接受 `movie|series`、绝对允许路径和 `confirmed:true`；空槽返回 `action:"added"`，已有槽返回 `action:"replaced"`；非草稿或版本不符在 upload 前拒绝；响应 MIME、字节数、ID 或版本增长不符时返回 `invalid_response`；schema 不包含删除动作。

- [ ] **步骤 2：运行测试确认失败**

运行：`cargo test -p movie-harbor-api --test mcp_auth_test poster -- --nocapture`

运行：`npm test --prefix mcp -- --test-name-pattern="content poster"`

预期：FAIL，海报路由未对 MCP 开放且工具不存在。

- [ ] **步骤 3：实现海报工具**

复用 `inspectAllowedFile`、现有海报预检和上传客户端，定义：

```ts
export function registerPosterTools(server: McpServer, dependencies: PosterToolDependencies): void
export async function setContentPoster(input: unknown, dependencies: PosterToolDependencies): Promise<ToolResult>
```

先校验本地海报，再读取远端详情；只有草稿且版本匹配才调用电影或整剧海报接口。输出 `added|replaced` 来自上传前读到的海报槽位，成功响应必须匹配本地 MIME、大小和 `version + 1`。

- [ ] **步骤 4：注册工具并收紧说明**

在 `server.ts` 注册 `set_content_poster`，说明“允许补传或替换，不允许删除；非草稿先显式调用生命周期工具”。更新完整工具清单测试。

- [ ] **步骤 5：运行测试验证通过**

运行：`cargo test -p movie-harbor-api --test mcp_auth_test`

运行：`npm test --prefix mcp -- --test-name-pattern="content poster|server registers"`

预期：PASS，海报失败不发后续写请求，旧海报由既有后端替换协议保护。

- [ ] **步骤 6：提交**

```bash
git add backend/src/auth/mcp.rs backend/tests/mcp_auth_test.rs mcp/src mcp/tests
git commit -m "feat: add MCP poster maintenance"
```

### 任务 3：缺视频电影与单集分页查询

**文件：**
- 修改：`backend/src/admin_content/dto.rs`
- 修改：`backend/src/admin_content/query.rs`
- 修改：`backend/src/admin_content/routes.rs`
- 修改：`backend/src/auth/mcp.rs`
- 修改：`mcp/src/schemas/admin-maintenance.ts`
- 创建：`mcp/src/tools/admin-query.ts`
- 修改：`mcp/src/server.ts`
- 测试：`backend/tests/admin_content_test.rs`
- 测试：`backend/tests/mcp_auth_test.rs`
- 测试：`mcp/tests/admin-maintenance-tools.test.ts`
- 测试：`mcp/tests/server.test.ts`

- [ ] **步骤 1：编写失败的真实数据库查询测试**

在 `admin_content_test.rs` 建立带视频/无视频电影、两个同名剧集、多季多集、空剧集和超过 20 条缺视频单集，断言：

- `content_type=movie` 只返回 `video_asset_id IS NULL` 的电影。
- `content_type=series` 精确返回已有无视频单集及父剧、季、集 ID/名称/序号、状态、版本和整剧隐私。
- 空剧集不产生条目；有视频单集不出现。
- 第一、二页总数相同且无重复，稳定排序为剧名、剧集 ID、季号、季 ID、集号、单集 ID 升序。
- 缺失/非法 `content_type`、零页和超大页返回 400。

- [ ] **步骤 2：运行后端测试确认失败**

运行：`TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test admin_content_test missing_videos -- --nocapture`

预期：FAIL，路由和 DTO 尚不存在。

- [ ] **步骤 3：实现判别式分页接口**

在 DTO 中定义 `MissingVideoRequest`、`MissingVideoFilter`、`MissingMovieItem`、`MissingEpisodeItem` 和带 `content_type` 判别字段的分页响应。实现：

```rust
pub async fn list_missing_videos(
    db: &DatabaseConnection,
    filter: MissingVideoFilter,
) -> Result<MissingVideoPage, DbErr>
```

总数和条目在同一 RepeatableRead、ReadOnly 事务中读取，固定 `ADMIN_CONTENT_PAGE_SIZE`。路由注册 `GET /api/admin/contents/missing-videos`。

- [ ] **步骤 4：编写失败的 MCP 工具与白名单测试**

断言只允许精确 GET 路由；`list_missing_videos` 必须提供 `movie|series`，可选正页码，原样校验分页判别结构，不自动请求详情或上传。

- [ ] **步骤 5：运行 MCP 测试确认失败**

运行：`npm test --prefix mcp -- --test-name-pattern="missing videos"`

预期：FAIL，schema 和注册不存在。

- [ ] **步骤 6：实现并注册只读查询工具**

在 `admin-query.ts` 定义：

```ts
export function registerAdminQueryTools(server: McpServer, client: MovieHarborClient): void
export async function listMissingVideos(input: unknown, client: MovieHarborClient): Promise<ToolResult>
```

使用只读、非破坏、幂等注解；后端白名单增加唯一 GET 路径。

- [ ] **步骤 7：运行任务验证**

运行：`TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test admin_content_test missing_videos -- --nocapture`

运行：`cargo test -p movie-harbor-api --test mcp_auth_test`

运行：`npm test --prefix mcp -- --test-name-pattern="missing videos|server registers"`

预期：PASS。

- [ ] **步骤 8：提交**

```bash
git add backend/src/admin_content backend/src/auth/mcp.rs backend/tests mcp/src mcp/tests
git commit -m "feat: query content missing videos through MCP"
```

### 任务 4：MCP 只读系统概览

**文件：**
- 修改：`backend/src/auth/mcp.rs`
- 修改：`mcp/src/schemas/admin-maintenance.ts`
- 修改：`mcp/src/tools/admin-query.ts`
- 修改：`mcp/src/server.ts`
- 测试：`backend/tests/admin_system_test.rs`
- 测试：`backend/tests/mcp_auth_test.rs`
- 测试：`mcp/tests/admin-maintenance-tools.test.ts`
- 测试：`mcp/tests/server.test.ts`

- [ ] **步骤 1：编写失败的权限与响应测试**

后端断言合法 MCP Bearer 可 GET `/api/admin/system/overview`，响应仍为 `private, no-store`，且 `/api/admin/system/*` 其他路径全部拒绝。MCP 断言 `get_system_overview` 无输入，完整校验 healthy、space_low、unavailable/null 容量和告警结构，不重算或丢弃字段。

- [ ] **步骤 2：运行测试确认失败**

运行：`cargo test -p movie-harbor-api --test admin_system_test mcp -- --nocapture`

运行：`npm test --prefix mcp -- --test-name-pattern="system overview"`

预期：FAIL，概览路由未进入 MCP 白名单且工具未注册。

- [ ] **步骤 3：开放单一路由并实现工具**

为现有概览路由增加精确 GET 白名单。在 `admin-query.ts` 增加：

```ts
export async function getSystemOverview(input: unknown, client: MovieHarborClient): Promise<ToolResult>
```

复用同一 `registerAdminQueryTools` 注册，schema 严格覆盖现有 DTO；工具不得访问其他系统路径。

- [ ] **步骤 4：运行测试验证通过**

运行：`cargo test -p movie-harbor-api --test admin_system_test`

运行：`cargo test -p movie-harbor-api --test mcp_auth_test`

运行：`npm test --prefix mcp -- --test-name-pattern="system overview|server registers"`

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add backend/src/auth/mcp.rs backend/tests mcp/src mcp/tests
git commit -m "feat: expose read-only system overview to MCP"
```

### 任务 5：服务端视频容量保护与管理前端声明

**文件：**
- 修改：`backend/src/media/mod.rs`
- 修改：`backend/src/media/routes.rs`
- 修改：`backend/src/media/storage.rs`
- 修改：`backend/src/media/upload.rs`
- 修改：`backend/tests/media_upload_test.rs`
- 修改：`frontend/packages/api-client/src/http.ts`
- 修改：`frontend/packages/api-client/src/admin.ts`
- 修改：`frontend/packages/api-client/src/http.test.ts`
- 修改：`frontend/packages/api-client/src/admin.test.ts`
- 修改：`frontend/admin-web/src/movies/MovieEditor.test.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.test.tsx`

- [ ] **步骤 1：编写失败的存储容量边界测试**

使用可注入 `StorageCapacityReader` 和记录型 `ChunkSource` 增加测试：

- 可用量恰等于 `declared_bytes + 10 GiB` 时允许，少一字节时在第一次 `next_chunk` 前返回 `StorageSpaceLow`。
- 容量读取失败返回 `StorageCapacityUnavailable`，不消费流。
- `declared_bytes + reserve_bytes` 溢出按空间不足处理。
- 实际流第一次超过声明时停止并清理 `.incoming`；流结束小于声明返回 `DeclaredSizeMismatch`。
- 替换失败后旧视频文件、媒体资产和内容版本不变。
- 两个并发上传依次取得全局变更锁，第二个在第一个落盘后重新读取容量再决定。

- [ ] **步骤 2：运行存储测试确认失败**

运行：`cargo test -p movie-harbor-api --test media_upload_test capacity -- --nocapture`

预期：FAIL，存储接口尚不接受容量要求和声明大小。

- [ ] **步骤 3：定义容量要求和稳定错误**

在媒体模块定义：

```rust
pub const MEDIA_CAPACITY_RESERVE_BYTES: u64 = 10 * 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct UploadCapacityRequirement {
    pub declared_bytes: u64,
    pub reserve_bytes: u64,
}
```

把原系统概览常量改为复用媒体模块常量。为 `MediaError` 增加 `StorageCapacityUnavailable`、`StorageSpaceLow { available_bytes, required_bytes, reserve_bytes }`、`DeclaredSizeInvalid`、`DeclaredSizeMismatch`，映射为稳定 JSON `code`，不包含路径。

- [ ] **步骤 4：在存储锁内实施复核**

给 `LocalMediaStorage::store`/`write_and_promote` 传递 `Option<UploadCapacityRequirement>`。取得 `mutations` 锁后、创建目录或 `.part` 文件前读取容量并用 `checked_add` 比较；写入循环拒绝超过声明，结束时要求相等。海报和暂存海报传 `None`，视频传 `Some`。

- [ ] **步骤 5：编写失败的路由请求头测试**

在 `media_upload_test.rs` 使用 `Router::oneshot` 断言电影/单集视频必须携带 `X-Media-Byte-Size` 的规范十进制非负整数；缺失、重复、空白、符号、溢出返回 `declared_size_invalid` 且不消费正文。海报路由不要求该头。

- [ ] **步骤 6：实现路由解析并传递容量要求**

定义唯一请求头常量 `X-Media-Byte-Size`。视频 handler 从 `HeaderMap::get_all` 要求恰好一个值并解析为 `u64`，使用共享 10 GiB 常量；海报 handler 保持原调用。不要信任 Multipart Content-Length 推导视频大小。

- [ ] **步骤 7：编写失败的前端客户端请求头测试**

在 fetch 和 XHR 两条上传测试中断言：视频请求头 `X-Media-Byte-Size` 精确等于 `File.size`；海报请求没有该头；XHR 仍发送 CSRF、保持进度单调并解析错误 JSON。编辑器集成测试断言容量错误中文提示沿用统一 `ApiError`，表单和旧视频预览不丢失。

- [ ] **步骤 8：运行前端测试确认失败**

运行：`npm test --workspace @movie-harbor/api-client -- --run`

运行：`npm test --workspace @movie-harbor/admin-web -- --run MovieEditor.test.tsx SeriesEditor.test.tsx`

预期：FAIL，上传尚未发送声明大小，XHR 初始化也不接受自定义头。

- [ ] **步骤 9：实现共享客户端声明大小**

给 `ApiUploadInit` 增加 `headers?: HeadersInit`，XHR 在 `open` 后逐项设置受控头；`uploadMedia` 仅对 `slot:"video"` 的 fetch/XHR 两条路径加入 `X-Media-Byte-Size: String(file.size)`。补充容量错误的稳定中文映射，海报行为不变。

- [ ] **步骤 10：运行任务验证**

运行：`cargo fmt --all -- --check`

运行：`cargo test -p movie-harbor-api --test media_upload_test capacity -- --nocapture`

运行：`npm test --workspace @movie-harbor/api-client -- --run`

运行：`npm test --workspace @movie-harbor/admin-web -- --run MovieEditor.test.tsx SeriesEditor.test.tsx`

预期：PASS。

- [ ] **步骤 11：提交**

```bash
git add backend/src/media backend/src/admin_system backend/tests/media_upload_test.rs frontend/packages/api-client frontend/admin-web/src/movies/MovieEditor.test.tsx frontend/admin-web/src/series/SeriesEditor.test.tsx
git commit -m "feat: reject video uploads without reserved capacity"
```

### 任务 6：MCP 视频上传容量预检

**文件：**
- 修改：`mcp/src/services/movie-harbor-client.ts`
- 修改：`mcp/src/tools/uploads.ts`
- 修改：`mcp/src/schemas/admin-maintenance.ts`
- 修改：`mcp/tests/client.test.ts`
- 修改：`mcp/tests/upload-publish-tools.test.ts`
- 修改：`mcp/tests/admin-maintenance-tools.test.ts`

- [ ] **步骤 1：编写失败的上传客户端头测试**

断言 `MovieHarborClient.upload` 从复验过的 `CheckedFile.identity.size` 发送 `X-Media-Byte-Size`，与 Multipart `content-length` 分离；文件身份变化时仍在网络请求前/流期间按现有规则失败。

- [ ] **步骤 2：编写失败的容量预检测试**

对四个上传/替换入口分别断言：

- 本地视频检查成功后先 GET `/api/admin/system/overview`，再读取目标详情。
- `available_bytes === size + reserve_bytes` 允许继续。
- 少一字节、`accepts_uploads:false`、`available_bytes:null`、缺少卷 0 或加法超出安全整数时，不调用目标详情和 upload。
- 拒绝错误包含稳定机器码及文件大小、可用量、预留量、缺口，不包含密钥和服务端路径。
- 概览通过但服务端随后返回容量错误时，普通源文件不删除；生成文件保留并返回既有重试说明。

- [ ] **步骤 3：运行测试确认失败**

运行：`npm test --prefix mcp -- --test-name-pattern="capacity|media byte size"`

预期：FAIL，上传工具尚未读取概览且客户端未发送声明头。

- [ ] **步骤 4：实现共享容量预检函数**

在 `uploads.ts` 定义并复用：

```ts
async function requireUploadCapacity(
  fileBytes: number,
  client: MovieHarborClient,
): Promise<void>
```

使用任务 4 的系统概览 schema 解析服务端响应，以 `BigInt` 或等价无溢出方法比较 JSON 安全整数；在四个入口中紧接 `checkedVideo` 调用，且在任何目标 GET、文件流或生成文件清理之前完成。

- [ ] **步骤 5：发送声明大小并更新错误映射**

`createMovieHarborClient.upload` 自动设置 `X-Media-Byte-Size` 为已检查文件大小。错误映射识别四个服务端稳定容量/声明码，输出有界中文说明，继续过滤 Authorization 和不受信任正文。

- [ ] **步骤 6：运行 MCP 全套测试与构建**

运行：`npm test --prefix mcp`

运行：`npm run build --prefix mcp`

预期：全部 PASS，TypeScript 无错误。

- [ ] **步骤 7：提交**

```bash
git add mcp/src mcp/tests
git commit -m "feat: preflight MCP video upload capacity"
```

### 任务 7：文档、跨服务验收与最终验证

**文件：**
- 修改：`docs/guides/codex-mcp.md`
- 修改：`tests/documentation.test.mjs`
- 修改：`tests/e2e/mcp.spec.ts`
- 创建或修改：`tests/e2e/admin-media-capacity.spec.ts`

- [ ] **步骤 1：编写失败的文档契约测试**

断言指南逐一包含服务器实际注册的五个新工具和四个容量受保护上传工具，不再出现三个旧发布工具；指南说明转草稿不会自动换海报或重新发布，容量规则是“新文件大小 + 10 GiB 预留”。

- [ ] **步骤 2：运行文档测试确认失败**

运行：`node --test tests/documentation.test.mjs`

预期：FAIL，指南仍描述旧工具集合。

- [ ] **步骤 3：更新 MCP 指南**

增加五个工具的参数、返回、确认点、典型组合和错误排查。示例流程写成独立调用：查询目标 → 必要时生命周期转草稿 → 海报补传/替换；不得把一次确认扩展到后续发布。

- [ ] **步骤 4：扩展 MCP E2E**

在隔离 Compose 项目中覆盖：读取概览；分别查询缺视频电影和具体单集；修改电影和整剧访问范围；把已发布测试电影转草稿；补传或替换海报；确认旧发布工具不存在。所有写操作使用测试创建的独立内容和媒体，不触碰默认宿主数据目录。

- [ ] **步骤 5：增加容量跨服务验收**

用管理员会话或 MCP Bearer 向视频路由发送一个小型合法 Multipart，但把 `X-Media-Byte-Size` 声明为 `u64::MAX`；断言在媒体内容校验前返回 `storage_space_low`，目标版本和原视频不变，隔离媒体目录没有新增正式文件或残留 `.part`。另用真实小文件和正确声明验证正常上传仍成功。

- [ ] **步骤 6：运行跨服务测试**

运行：`npm run test:e2e`

预期：PASS，runner 使用隔离 Compose 项目和临时数据目录。

- [ ] **步骤 7：运行完整相关验证**

运行：`cargo fmt --all -- --check`

运行：`cargo clippy --workspace --all-targets -- -D warnings`

运行：`TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace`

运行：`npm test --prefix mcp`

运行：`npm run build --prefix mcp`

运行：`npm test --workspaces`

运行：`npm run build --workspaces`

运行：`node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs`

运行：`git diff --check`

预期：全部通过且无格式错误。

- [ ] **步骤 8：提交**

```bash
git add docs/guides/codex-mcp.md tests
git commit -m "docs: document MCP admin maintenance workflow"
```

## 自检结果

- 规格第 4 至 9 节分别由任务 1 至 4 覆盖；旧发布工具删除和后续动作迁移归入任务 1。
- 规格第 10 节的服务端权威复核、管理前端声明和 MCP 预检分别由任务 5、6 覆盖。
- 权限、安全、错误恢复和文档兼容性贯穿任务 1 至 7，并由最终 E2E 验收。
- 五个审查重点都已加入对应任务的明确失败测试，不存在只列风险却不验证的条目。
- 新类型名称在后续任务保持一致：`UploadCapacityRequirement`、`X-Media-Byte-Size`、`transition_content_lifecycle`、`list_missing_videos`、`get_system_overview`。
- 计划不引入数据库迁移、不改公开站，也没有扩展任何删除、用户、导出或备份权限。
