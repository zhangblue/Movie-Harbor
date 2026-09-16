# 管理媒体路径显示与内容 JSON 导出实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在管理电影和剧集详情中只读显示已保存视频的容器内路径，并从内容管理页下载包含全部电影、剧集、海报路径和扁平单集信息的 JSON 文件。

**架构：** 后端集中验证媒体存储键并为管理 DTO 生成 `/media/...` 容器路径；独立管理导出模块在一个只读可重复读事务中查询完整内容快照，并以带安全文件名的 JSON 附件返回。共享 API 客户端增加同源认证下载能力，管理内容页负责触发下载，详情组件只呈现后端提供的 `local_path`。

**技术栈：** Rust、Axum 0.8、SeaORM 1.1、PostgreSQL、React 19、TypeScript、Vitest、Playwright。

---

## 文件结构

- 创建 `backend/src/media/path.rs`：验证受控媒体键并生成容器内路径。
- 修改 `backend/src/media/mod.rs`、`backend/src/catalog/dto.rs`：共享路径边界，保持公共 API 仅返回 URL。
- 修改电影与剧集 DTO/服务：管理媒体摘要增加 `local_path`。
- 创建 `backend/src/admin_export/{mod.rs,dto.rs,query.rs,routes.rs}`：完整内容导出 DTO、快照查询和认证下载路由。
- 创建 `backend/tests/admin_export_test.rs`，并修改现有电影、剧集、目录测试。
- 修改共享 API 客户端：增加同源认证附件下载及 `local_path` 类型。
- 修改管理站视频组件、内容页、样式与测试：显示路径并下载 JSON。
- 创建 `tests/e2e/export.spec.ts`，修改 E2E 帮助函数与 Playwright 项目依赖。
- 修改 `README.md`、`AGENTS.md`：记录新能力和边界。

### 任务 1：受控容器路径与管理详情显示

**文件：**
- 创建：`backend/src/media/path.rs`
- 修改：`backend/src/media/mod.rs`
- 修改：`backend/src/catalog/dto.rs`
- 修改：`backend/src/movies/dto.rs`
- 修改：`backend/src/movies/service.rs`
- 修改：`backend/src/series/dto.rs`
- 修改：`backend/src/series/service.rs`
- 修改：`backend/tests/movies_test.rs`
- 修改：`backend/tests/series_test.rs`
- 修改：`backend/tests/catalog_test.rs`
- 修改：`frontend/packages/api-client/src/types.ts`
- 修改：`frontend/admin-web/src/movies/VideoPicker.tsx`
- 修改：`frontend/admin-web/src/movies/MovieEditor.test.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.test.tsx`
- 修改：`frontend/admin-web/src/test/server.ts`
- 修改：`frontend/admin-web/src/styles.css`

- [ ] **步骤 1：编写失败的后端详情路径测试**

在电影和剧集路由测试中使用合法存储键，并断言管理响应：

```rust
assert_eq!(payload["video"]["local_path"], "/media/video/ab/ab000000000000000000000000000001.mp4");
assert_eq!(episode["video"]["local_path"], "/media/video/cd/cd000000000000000000000000000002.mp4");
```

在 `catalog_test.rs` 断言公共电影、剧集和单集只有公共 URL，没有 `local_path` 或管理媒体摘要字段。

- [ ] **步骤 2：运行后端聚焦测试确认 RED**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' \
  cargo test -p movie-harbor-api --test movies_test --test series_test --test catalog_test
```

预期：管理响应缺少 `local_path`，新增断言失败。

- [ ] **步骤 3：提取受控路径构造函数并接入管理 DTO**

将 `catalog::dto` 中的存储键校验移至 `media/path.rs`：

```rust
pub(crate) fn controlled_media_path(
    storage_key: &str,
    expected_kind: &str,
) -> Option<String> {
    controlled_storage_key(storage_key, expected_kind)
        .then(|| format!("/media/{storage_key}"))
}
```

`catalog::dto::media_url` 委托该函数，公共响应保持不变。`MediaSummary` 增加 `local_path: String`，并提供：

```rust
impl MediaSummary {
    pub fn try_from_asset(value: media_asset::Model, expected_kind: &str) -> Result<Self, DbErr>;
}
```

构造器同时验证 `value.purpose == expected_kind` 和存储键格式；不合法记录映射为内部数据库错误。`MovieResponse::new`、`SeriesResponse::new`、`EpisodeResponse::new` 改为返回 `Result`，既有服务用 `?` 传播为 `500`。

- [ ] **步骤 4：运行后端聚焦测试确认 GREEN**

重新运行步骤 2，并运行：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

- [ ] **步骤 5：编写失败的前端路径显示测试**

给测试媒体夹具增加 `local_path`。电影测试提供已有视频并断言完整路径可见；剧集测试创建两个带不同视频路径的单集，展开季后断言每行只显示自身路径。没有视频的单集继续显示“尚未上传视频”，且不显示伪路径。

- [ ] **步骤 6：运行前端测试确认 RED**

```bash
npm test --workspace @movie-harbor/admin-web -- \
  src/movies/MovieEditor.test.tsx src/series/SeriesEditor.test.tsx
npm test --workspace @movie-harbor/api-client
```

预期：DOM 中尚未渲染路径。

- [ ] **步骤 7：实现只读路径显示**

更新类型：

```ts
export interface MediaSummary {
  id: string;
  url: string;
  local_path: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
}
```

`VideoPicker` 仅对已持久化的 `current` 渲染：

```tsx
<p className="media-local-path">
  <span>本地存储路径：</span><code>{current.local_path}</code>
</p>
```

不要为浏览器待上传文件生成路径。样式使用 `overflow-wrap: anywhere`。

- [ ] **步骤 8：验证并提交**

运行步骤 6、`npm run build --workspaces` 和 `git diff --check`，然后：

```bash
git add backend/src/media backend/src/catalog/dto.rs backend/src/movies backend/src/series \
  backend/tests/movies_test.rs backend/tests/series_test.rs backend/tests/catalog_test.rs \
  frontend/packages/api-client/src/types.ts frontend/admin-web/src
git commit -m "feat: show admin media storage paths"
```

### 任务 2：管理员完整内容导出 API

**文件：**
- 创建：`backend/src/admin_export/mod.rs`
- 创建：`backend/src/admin_export/dto.rs`
- 创建：`backend/src/admin_export/query.rs`
- 创建：`backend/src/admin_export/routes.rs`
- 创建：`backend/tests/admin_export_test.rs`
- 修改：`backend/src/lib.rs`
- 修改：`backend/src/app.rs`

- [ ] **步骤 1：编写失败的导出路由契约测试**

新测试使用真实 PostgreSQL 和 `Router::oneshot`，覆盖认证和附件响应：

```rust
assert_eq!(request(&app, "/api/admin/contents/export", None).await.status(), StatusCode::UNAUTHORIZED);

let response = request(&app, "/api/admin/contents/export", Some(&cookie)).await;
assert_eq!(response.status(), StatusCode::OK);
assert_eq!(response.headers()[CONTENT_TYPE], "application/json; charset=utf-8");
assert!(response.headers()[CONTENT_DISPOSITION]
    .to_str().unwrap()
    .starts_with("attachment; filename=\"movie-harbor-content-export-"));
```

读取 JSON 并断言：所有状态均出现；所有层级均无 `status` 和 ID；电影字段精确；剧集使用扁平 `episodes`；单集含季编号和集编号；缺失媒体/时长为 `null`；同名内容及乱序季集仍稳定排序。

- [ ] **步骤 2：运行测试确认 RED**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' \
  cargo test -p movie-harbor-api --test admin_export_test -- --nocapture
```

预期：认证后请求返回 `404`。

- [ ] **步骤 3：定义精确导出 DTO**

在 `dto.rs` 使用具体结构，不用任意 `serde_json::Value`：

```rust
#[derive(Debug, Serialize)]
pub struct ContentExport {
    pub exported_at: String,
    pub movies: Vec<ExportMovie>,
    pub series: Vec<ExportSeries>,
}

#[derive(Debug, Serialize)]
pub struct ExportEpisode {
    pub season_number: i32,
    pub episode_number: i32,
    pub name: String,
    pub video_path: Option<String>,
    pub duration_seconds: Option<i32>,
}
```

`ExportMovie` 只含 `name`、`synopsis`、`poster_path`、`video_path`、`duration_seconds`；`ExportSeries` 只含 `name`、`synopsis`、`poster_path`、`episodes`。

- [ ] **步骤 4：实现同一快照查询和稳定组装**

`query::export(db, exported_at)` 开启：

```rust
let tx = db.begin_with_config(
    Some(IsolationLevel::RepeatableRead),
    Some(AccessMode::ReadOnly),
).await?;
```

在该事务内查询电影及海报/视频、剧集及海报、季/单集及视频。SQL 排序固定为：

```sql
ORDER BY movie.name ASC, movie.id ASC
ORDER BY series.name ASC, series.id ASC
ORDER BY series_id ASC, season.number ASC, episode.number ASC, episode.id ASC
```

所有路径调用任务 1 的 `controlled_media_path`；媒体记录存在但路径无效时返回 `DbErr::Custom`。用按剧集 ID 索引的映射组装扁平单集数组，提交只读事务后返回 DTO。

- [ ] **步骤 5：实现认证附件响应**

注册 `GET /api/admin/contents/export` 并复用 `require_session`。一次捕获 `Utc::now()`，同时生成 `exported_at` 与 ASCII 文件名：

```rust
let filename = format!(
    "movie-harbor-content-export-{}.json",
    now.format("%Y%m%d-%H%M%S")
);
```

用拥有所有权的 `HeaderValue` 返回 `Content-Type: application/json; charset=utf-8`、`Content-Disposition: attachment; filename="..."` 和 `Json(payload)`。数据库、组装或头部构造失败统一返回 `500 {"error":"internal server error"}`。

- [ ] **步骤 6：增加快照一致性回归**

仿照 `admin_content_test.rs` 的锁等待测试：让导出第一条查询完成后阻塞后续媒体查询，并发更新内容或媒体再释放锁。断言一个响应中的父内容与媒体路径来自同一事务快照，不混入并发提交值。

- [ ] **步骤 7：验证并提交**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' \
  cargo test -p movie-harbor-api --test admin_export_test --test admin_content_test
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
git diff --check
git add backend/src/admin_export backend/src/lib.rs backend/src/app.rs backend/tests/admin_export_test.rs
git commit -m "feat: export complete admin content metadata"
```

### 任务 3：认证下载客户端与内容页导出按钮

**文件：**
- 修改：`frontend/packages/api-client/src/http.ts`
- 修改：`frontend/packages/api-client/src/http.test.ts`
- 修改：`frontend/packages/api-client/src/admin.ts`
- 修改：`frontend/admin-web/src/content/ContentPage.tsx`
- 修改：`frontend/admin-web/src/content/ContentPage.test.tsx`
- 修改：`frontend/admin-web/src/test/server.ts`
- 修改：`frontend/admin-web/src/styles.css`

- [ ] **步骤 1：编写失败的共享下载客户端测试**

```ts
const result = await apiDownload("/api/admin/contents/export");
expect(result.filename).toBe("movie-harbor-content-export-20260916-120000.json");
expect(await result.blob.text()).toContain('"movies"');
```

同时验证：同源 `/api` 路径和 `credentials: "same-origin"`；`401`、JSON 错误和网络错误沿用现有错误类型；异常文件名回退到 `movie-harbor-content-export.json`；非 JSON 成功响应被拒绝。

- [ ] **步骤 2：运行客户端测试确认 RED**

```bash
npm test --workspace @movie-harbor/api-client -- src/http.test.ts
```

预期：`apiDownload` 尚不存在。

- [ ] **步骤 3：提取共享 fetch 边界并实现下载**

在不改变 `apiRequest` 行为的前提下，提取内部 `performApiFetch(path, init)`，集中处理 URL 白名单、请求头、同源凭据、CSRF、网络异常和非成功响应。新增：

```ts
export interface ApiDownload {
  blob: Blob;
  filename: string;
}

export async function apiDownload(
  path: string,
  init: ApiRequestInit = {},
): Promise<ApiDownload>;
```

文件名只接受 `movie-harbor-content-export-YYYYMMDD-HHmmss.json`，其余值使用固定安全回退名。成功响应必须是 JSON；读取 Blob 失败映射为 `ApiNetworkError`。`admin.ts` 增加：

```ts
export function downloadAdminContentExport(): Promise<ApiDownload> {
  return apiDownload("/api/admin/contents/export");
}
```

- [ ] **步骤 4：运行客户端测试确认 GREEN**

运行步骤 2 及整个 API 客户端工作区，确认旧 JSON 请求行为没有回归。

- [ ] **步骤 5：编写失败的内容页下载测试**

模拟附件响应，stub `URL.createObjectURL`、`URL.revokeObjectURL` 和 `HTMLAnchorElement.prototype.click`。断言“导出 JSON”与“＋ 新建内容”位于同一标题操作容器且相邻；成功时采用响应文件名、只 click 一次并 revoke。

另覆盖：pending 时禁用且第二次点击不发请求；`401` 调用 `onExpired`；`500` 显示“内容导出失败，请重试”且不下载；下载不改变筛选、页码或列表。

- [ ] **步骤 6：运行管理页测试确认 RED**

```bash
npm test --workspace @movie-harbor/admin-web -- src/content/ContentPage.test.tsx
```

预期：页面没有导出按钮和下载流程。

- [ ] **步骤 7：实现按钮和资源清理**

标题右侧增加 `.admin-title-actions`，顺序为“导出 JSON”“＋ 新建内容”。使用独立 `exporting`、`exportError` 状态。成功处理必须使用同步 `try/finally` 撤销对象 URL：

```tsx
const url = URL.createObjectURL(blob);
try {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
} finally {
  URL.revokeObjectURL(url);
}
```

不要把临时链接保留在 DOM。组件卸载后不写 state；`401` 走会话过期逻辑，其他错误只更新导出错误提示。

- [ ] **步骤 8：验证并提交**

```bash
npm test --workspace @movie-harbor/api-client
npm test --workspace @movie-harbor/admin-web -- src/content/ContentPage.test.tsx
npm run build --workspaces
git diff --check
git add frontend/packages/api-client/src frontend/admin-web/src
git commit -m "feat: download admin content export"
```

### 任务 4：跨服务验收与项目文档

**文件：**
- 创建：`tests/e2e/export.spec.ts`
- 修改：`tests/e2e/helpers.ts`
- 修改：`playwright.config.ts`
- 修改：`README.md`
- 修改：`AGENTS.md`

- [ ] **步骤 1：编写失败的端到端导出测试**

新增 `export` Playwright project，依赖 `series`；让 `playback` 改为依赖 `export`，保证本测试在管理员密码变更前执行。测试通过 `AdminApi` 创建唯一命名的草稿电影和剧集：电影填写简介和秒数并上传海报/视频；剧集填写简介并上传海报，再创建非默认季编号和集编号、填写秒数并上传单集视频。

登录管理页后捕获下载：

```ts
const downloadPromise = page.waitForEvent("download");
await page.getByRole("button", { name: "导出 JSON" }).click();
const download = await downloadPromise;
expect(download.suggestedFilename())
  .toMatch(/^movie-harbor-content-export-\d{8}-\d{6}\.json$/);
```

解析文件后断言海报/视频路径前缀、秒数、季编号、集编号、空值和无 `status`。再打开电影详情与剧集季折叠，断言 UI 路径与导出路径一致。

- [ ] **步骤 2：运行 E2E 确认 RED**

```bash
npm run test:e2e
```

预期：新测试找不到导出按钮或接口。

- [ ] **步骤 3：补齐 E2E 帮助函数和文档**

给 E2E 管理媒体类型增加 `local_path`，提取仅供测试使用的创建辅助函数，避免复制请求细节。

README 说明：详情展示的是容器内路径而非宿主机路径；导出覆盖全部状态且不受筛选分页影响；JSON 只读且不能导入。AGENTS.md 增加 `backend/src/admin_export/` 职责、管理路径不得进入公共 API，以及导出不得改为前端分页聚合。

- [ ] **步骤 4：运行完整验证**

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

预期：全部适用测试退出码为 0，新 E2E 下载项目没有 skip。

- [ ] **步骤 5：提交并请求审查**

```bash
git add tests/e2e/export.spec.ts tests/e2e/helpers.ts playwright.config.ts README.md AGENTS.md
git commit -m "test: verify admin content export workflow"
```

使用 superpowers:requesting-code-review 对照设计规格审查：公共/管理路径边界、快照一致性、JSON 精确字段、文件名安全、对象 URL 清理及导出不受筛选分页影响。处理反馈后重新运行步骤 4。
