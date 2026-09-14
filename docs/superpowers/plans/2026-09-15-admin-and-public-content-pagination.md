# 管理与公开内容列表分页实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为管理后台提供电影、剧集统一分页和跨页连续序号，并把公开内容目录升级为固定每页 20 条、支持数字跳页和 URL 恢复的分页体验。

**架构：** 后端新增受管理员会话保护的轻量统一内容查询，通过 PostgreSQL `UNION ALL` 在同一事务快照中完成筛选、稳定排序、计数和分页。两个前端共享纯页码窗口算法；管理后台把列表状态提升到 `App` 以跨编辑页保留，公开站继续以 URL 作为页码状态来源。

**技术栈：** Rust、Axum、SeaORM/PostgreSQL、React 19、TypeScript、Vitest、Testing Library、Playwright、Docker Compose。

---

## 文件结构

### 后端统一管理列表

- 创建 `backend/src/admin_content/mod.rs`：声明统一管理内容模块。
- 创建 `backend/src/admin_content/dto.rs`：解析并验证 `kind/status/name/page`，定义固定页大小和轻量响应类型。
- 创建 `backend/src/admin_content/query.rs`：执行 `UNION ALL` 计数与分页 SQL，并映射受控海报 URL。
- 创建 `backend/src/admin_content/routes.rs`：暴露受会话中间件保护的 `GET /api/admin/contents`。
- 修改 `backend/src/lib.rs`：导出新模块。
- 修改 `backend/src/app.rs`：将新路由合并到应用。
- 创建 `backend/tests/admin_content_test.rs`：使用真实 PostgreSQL 和 `Router::oneshot` 验证认证、筛选、排序、分页和响应边界。

### 共享前端能力与 API 合约

- 创建 `frontend/packages/ui/src/pagination.ts`：生成最多 7 个位置的页码/省略号窗口。
- 创建 `frontend/packages/ui/src/pagination.test.ts`：固定窗口算法在首页、中间页和末页的输出。
- 修改 `frontend/packages/ui/src/index.ts`：导出页码算法和类型。
- 修改 `frontend/packages/api-client/src/types.ts`：增加统一管理列表项、分页响应和查询类型。
- 修改 `frontend/packages/api-client/src/admin.ts`：增加 `listAdminContent`。
- 修改 `frontend/packages/api-client/src/admin.test.ts`：验证查询参数编码和响应返回。

### 管理后台

- 修改 `frontend/admin-web/src/app/App.tsx`：持有列表筛选、页码和刷新版本，并在删除成功后触发保留页码的刷新。
- 修改 `frontend/admin-web/src/content/ContentFilters.tsx`：用已应用筛选值初始化重新挂载后的表单。
- 修改 `frontend/admin-web/src/content/ActionButtons.tsx`：让列表行使用轻量 `AdminContentListItem`。
- 修改 `frontend/admin-web/src/content/ContentPage.tsx`：使用统一接口，保留旧数据完成加载/失败展示，并处理越界页回退。
- 修改 `frontend/admin-web/src/content/ContentTable.tsx`：使用 `poster_url` 并在海报前显示跨页连续序号。
- 创建 `frontend/admin-web/src/content/ContentPagination.tsx`：渲染已确认的 A 布局。
- 修改 `frontend/admin-web/src/content/ContentPage.test.tsx`：覆盖统一请求、序号、数字页码、状态保留、空页回退和过期响应。
- 修改 `frontend/admin-web/src/test/server.ts`：提供统一分页响应夹具。
- 修改 `frontend/admin-web/src/styles.css`：增加序号列与紧凑分页栏样式。

### 公开站与端到端验证

- 创建 `frontend/public-web/src/catalog/CatalogPagination.tsx`：使用共享页码窗口渲染公开站数字分页。
- 修改 `frontend/public-web/src/catalog/CatalogPage.tsx`：固定 `size=20`，接入数字页码并规范越界 URL。
- 修改 `frontend/public-web/src/catalog/CatalogPage.test.tsx`：覆盖 20 条请求、数字跳页、历史恢复、筛选重置和越界修正。
- 修改 `frontend/public-web/src/styles.css`：将现有公开分页样式扩展到数字页码和移动端换行。
- 修改 `tests/e2e/helpers.ts`：增加不上传海报的轻量可发布电影创建器。
- 创建 `tests/e2e/pagination.spec.ts`：用 21 条隔离内容验证两个站点的真实跨页流程。
- 修改 `playwright.config.ts`：把分页项目加入现有串行依赖链，并确保其在修改管理员密码的最终项目之前运行。

---

### 任务 1：增加共享页码窗口算法

**文件：**

- 创建：`frontend/packages/ui/src/pagination.ts`
- 创建：`frontend/packages/ui/src/pagination.test.ts`
- 修改：`frontend/packages/ui/src/index.ts`

- [ ] **步骤 1：编写失败的窗口算法测试**

创建 `pagination.test.ts`，固定短分页、首页窗口、中间窗口和末页窗口：

```ts
import { expect, it } from "vitest";
import { paginationItems } from "./pagination";

it("shows every page when the total is seven or less", () => {
  expect(paginationItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

it("keeps first, last and a compact window around the current page", () => {
  expect(paginationItems(1, 12)).toEqual([1, 2, 3, 4, 5, "ellipsis", 12]);
  expect(paginationItems(6, 12)).toEqual([1, "ellipsis", 5, 6, 7, "ellipsis", 12]);
  expect(paginationItems(12, 12)).toEqual([1, "ellipsis", 8, 9, 10, 11, 12]);
});
```

- [ ] **步骤 2：运行测试确认缺少模块**

运行：

```bash
npm test --workspace @movie-harbor/ui -- pagination.test.ts
```

预期：FAIL，Vitest 报告无法解析 `./pagination`。

- [ ] **步骤 3：实现纯页码窗口函数并导出**

创建 `pagination.ts`：

```ts
export type PaginationItem = number | "ellipsis";

export function paginationItems(currentPage: number, totalPages: number): PaginationItem[] {
  if (!Number.isSafeInteger(currentPage) || !Number.isSafeInteger(totalPages) || currentPage < 1 || totalPages < 1 || currentPage > totalPages) {
    throw new RangeError("pagination requires 1 <= currentPage <= totalPages");
  }
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  if (currentPage <= 4) return [1, 2, 3, 4, 5, "ellipsis", totalPages];
  if (currentPage >= totalPages - 3) {
    return [1, "ellipsis", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, "ellipsis", currentPage - 1, currentPage, currentPage + 1, "ellipsis", totalPages];
}
```

在 `frontend/packages/ui/src/index.ts` 增加：

```ts
export { paginationItems } from "./pagination";
export type { PaginationItem } from "./pagination";
```

- [ ] **步骤 4：运行共享包测试和构建**

```bash
npm test --workspace @movie-harbor/ui -- pagination.test.ts
npm run build --workspace @movie-harbor/ui
```

预期：全部 PASS。

- [ ] **步骤 5：提交共享算法**

```bash
git add frontend/packages/ui/src/pagination.ts frontend/packages/ui/src/pagination.test.ts frontend/packages/ui/src/index.ts
git commit -m "feat: 共享数字分页窗口"
```

---

### 任务 2：新增统一管理内容分页接口

**文件：**

- 创建：`backend/src/admin_content/mod.rs`
- 创建：`backend/src/admin_content/dto.rs`
- 创建：`backend/src/admin_content/query.rs`
- 创建：`backend/src/admin_content/routes.rs`
- 创建：`backend/tests/admin_content_test.rs`
- 修改：`backend/src/lib.rs`
- 修改：`backend/src/app.rs`

- [ ] **步骤 1：编写认证和分页响应失败测试**

在 `admin_content_test.rs` 使用 `mod support;`、`support::TestDatabase`、临时媒体目录、现有测试 `Config` 字段和登录请求助手。助手签名固定为：

```rust
async fn request(app: &Router, uri: &str, cookie: Option<&str>) -> Response;
async fn credentials(app: &Router) -> String;
async fn body(response: Response) -> Value;
async fn list(app: &Router, cookie: &str, query: &str) -> Value;
```

插入 12 部电影和 10 部剧集，显式设置 `created_at`；电影状态分布固定为 6 条草稿、3 条已发布、3 条已归档，其中一条剧集命名为 `100%_! Series`。至少两条记录共享创建时间但类型和 UUID 不同。第一个测试断言：

```rust
assert_eq!(request(&app, "/api/admin/contents", None).await.status(), StatusCode::UNAUTHORIZED);

let response = request(&app, "/api/admin/contents?page=2", Some(&cookie)).await;
assert_eq!(response.status(), StatusCode::OK);
let payload = body(response).await;
assert_eq!(payload["page"], 2);
assert_eq!(payload["size"], 20);
assert_eq!(payload["total"], 22);
assert_eq!(payload["items"].as_array().unwrap().len(), 2);
assert!(payload["items"][0].get("seasons").is_none());
assert!(payload["items"][0].get("genres").is_none());
```

同时收集第一页和第二页的 `(created_at, kind, id)`，断言与 `created_at DESC, kind ASC, id ASC` 的预期顺序完全相同。

- [ ] **步骤 2：运行路由测试确认 404**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test admin_content_test admin_content_is_authenticated_paginated_and_stably_sorted -- --nocapture
```

预期：FAIL，认证后的请求返回 `404 Not Found`。

- [ ] **步骤 3：定义经过验证的请求与响应类型**

在 `dto.rs` 定义：

```rust
pub const ADMIN_CONTENT_PAGE_SIZE: u64 = 20;
pub const MAX_ADMIN_CONTENT_PAGE: u64 = 1_000_000;

#[derive(Debug, Default, Deserialize)]
pub struct AdminContentRequest {
    pub kind: Option<String>,
    pub status: Option<String>,
    pub name: Option<String>,
    pub page: Option<u64>,
}

pub struct AdminContentFilter {
    pub kind: String,
    pub status: Option<String>,
    pub name_pattern: Option<String>,
    pub page: u64,
    pub offset: u64,
}

#[derive(Debug, Serialize)]
pub struct AdminContentItem {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub status: String,
    pub version: i64,
    pub created_at: String,
    pub poster_url: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AdminContentPage {
    pub page: u64,
    pub size: u64,
    pub total: u64,
    pub items: Vec<AdminContentItem>,
}
```

`TryFrom<AdminContentRequest>` 必须接受 `all/movie/series`，只接受三个现有状态，修剪名称并用 `!` 转义 `!/%/_`，使用 `checked_mul` 计算偏移，拒绝第 0 页和大于 `MAX_ADMIN_CONTENT_PAGE` 的页码。

- [ ] **步骤 4：实现同一快照内的计数和轻量分页查询**

在 `query.rs` 定义 `AdminContentRow`，字段为 UUID、kind、name、status、version、`DateTime<FixedOffset>` 和可空 `poster_storage_key`。将列表 SQL 暴露为 `pub const ADMIN_CONTENT_ITEMS_SQL`，供事务快照测试锁定真实查询。计数和列表 SQL 均使用以下候选条件：

```sql
SELECT movie.id, 'movie'::text AS kind, movie.name, movie.status,
       movie.version, movie.created_at, movie.poster_asset_id
FROM movie
WHERE $1::text IN ('all', 'movie')
  AND ($2::text IS NULL OR movie.status = $2::text)
  AND ($3::text IS NULL OR lower(movie.name) LIKE lower($3::text) ESCAPE '!')
UNION ALL
SELECT series.id, 'series'::text AS kind, series.name, series.status,
       series.version, series.created_at, series.poster_asset_id
FROM series
WHERE $1::text IN ('all', 'series')
  AND ($2::text IS NULL OR series.status = $2::text)
  AND ($3::text IS NULL OR lower(series.name) LIKE lower($3::text) ESCAPE '!')
```

列表查询在候选集外执行：

```sql
SELECT candidates.id, candidates.kind, candidates.name, candidates.status,
       candidates.version, candidates.created_at,
       poster.storage_key AS poster_storage_key
FROM candidates
LEFT JOIN media_asset poster ON poster.id = candidates.poster_asset_id
ORDER BY candidates.created_at DESC, candidates.kind ASC, candidates.id ASC
LIMIT $4 OFFSET $5
```

`list` 使用 `begin_with_config(Some(IsolationLevel::RepeatableRead), Some(AccessMode::ReadOnly))`；先取得 `count(*)::bigint`，再取当前页，调用 `crate::catalog::dto::media_url(storage_key, "poster")` 生成 URL，最后提交事务并返回 `size: ADMIN_CONTENT_PAGE_SIZE`。

- [ ] **步骤 5：注册受保护路由并通过首个测试**

`routes.rs` 的路由只包含 GET，并复用管理员会话中间件：

```rust
pub fn router(auth_state: AuthState) -> Router {
    Router::new()
        .route("/api/admin/contents", get(list))
        .route_layer(middleware::from_fn_with_state(
            auth_state.clone(),
            auth::routes::require_session,
        ))
        .with_state(auth_state)
}
```

`list` 将 DTO 转换失败映射为 `400` JSON `{"error":"invalid content list request"}`，数据库失败映射为 `500` JSON `{"error":"internal server error"}`。在 `lib.rs` 导出 `admin_content`，并在 `app::build` 的认证路由之后合并 `crate::admin_content::routes::router(state.clone())`。

重新运行步骤 2 的测试，预期 PASS。

- [ ] **步骤 6：增加筛选、字面量搜索、越界与非法参数测试**

新增测试并逐一断言：

```rust
assert_eq!(list(&app, &cookie, "?kind=movie&status=draft").await["items"].as_array().unwrap().len(), 6);
assert_eq!(list(&app, &cookie, "?kind=series&name=%25_%21").await["items"][0]["name"], "100%_! Series");
assert_eq!(list(&app, &cookie, "?page=999").await["items"].as_array().unwrap().len(), 0);
assert_eq!(list(&app, &cookie, "?page=999").await["total"], 22);
```

对 `kind=video`、`status=deleted`、`page=0`、`page=1000001` 分别发请求并断言 `400 Bad Request`。带合法媒体存储键的海报返回 `/media/poster/...`，包含 `..` 的损坏键返回 `null`。

增加 `admin_content_total_and_items_share_one_snapshot`：先用事务对 `media_asset` 取得 `ACCESS EXCLUSIVE` 锁，再在异步任务中直接调用 `query::list`；通过 `pg_stat_activity` 等待包含 `ADMIN_CONTENT_ITEMS_SQL` 的列表查询阻塞后，在持锁事务中删除旧电影并插入两条新电影，最后提交释放锁。断言异步结果仍为变更前的 `total=1`、`items.len()=1` 和旧电影名称，证明计数与列表没有跨快照组合。

- [ ] **步骤 7：运行后端聚焦验证并提交**

```bash
cargo fmt --all -- --check
cargo clippy -p movie-harbor-api --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test admin_content_test -- --nocapture
```

预期：全部 PASS。然后提交：

```bash
git add backend/src/admin_content backend/src/lib.rs backend/src/app.rs backend/tests/admin_content_test.rs
git commit -m "feat: 增加管理内容分页接口"
```

---

### 任务 3：增加统一管理列表 API 客户端合约

**文件：**

- 修改：`frontend/packages/api-client/src/types.ts`
- 修改：`frontend/packages/api-client/src/admin.ts`
- 修改：`frontend/packages/api-client/src/admin.test.ts`

- [ ] **步骤 1：编写失败的客户端查询测试**

在 `admin.test.ts` 导入 `listAdminContent`，增加：

```ts
it("loads the unified admin content page with filters", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    urls.push(String(url));
    return new Response('{"page":2,"size":20,"total":21,"items":[]}', {
      headers: { "content-type": "application/json" },
    });
  }));

  expect(await listAdminContent({ kind: "series", status: "archived", name: "长 夜", page: 2 }))
    .toMatchObject({ page: 2, size: 20, total: 21 });
  expect(urls).toEqual(["/api/admin/contents?kind=series&status=archived&name=%E9%95%BF+%E5%A4%9C&page=2"]);
});
```

- [ ] **步骤 2：运行测试确认缺少导出**

```bash
npm test --workspace @movie-harbor/api-client -- admin.test.ts
```

预期：FAIL，TypeScript/Vitest 报告 `listAdminContent` 未导出。

- [ ] **步骤 3：增加共享类型和请求函数**

在 `types.ts` 增加：

```ts
export interface AdminContentListItem {
  id: string;
  kind: ContentKind;
  name: string;
  status: ContentStatus;
  version: number;
  created_at: string;
  poster_url: string | null;
}
export interface AdminContentPage {
  page: number;
  size: number;
  total: number;
  items: AdminContentListItem[];
}
export interface AdminContentListQuery {
  kind?: CatalogKind;
  status?: ContentStatus;
  name?: string;
  page?: number;
}
```

在 `admin.ts` 导入这些类型并增加：

```ts
export async function listAdminContent(query: AdminContentListQuery = {}): Promise<AdminContentPage> {
  return required(await apiRequest<AdminContentPage>("/api/admin/contents", { query }));
}
```

- [ ] **步骤 4：运行客户端测试、构建并提交**

```bash
npm test --workspace @movie-harbor/api-client -- admin.test.ts
npm run build --workspace @movie-harbor/api-client
```

预期：全部 PASS。然后提交：

```bash
git add frontend/packages/api-client/src/types.ts frontend/packages/api-client/src/admin.ts frontend/packages/api-client/src/admin.test.ts
git commit -m "feat: 增加管理内容分页客户端"
```

---

### 任务 4：为管理内容列表增加分页和连续序号

**文件：**

- 创建：`frontend/admin-web/src/content/ContentPagination.tsx`
- 修改：`frontend/admin-web/src/app/App.tsx`
- 修改：`frontend/admin-web/src/content/ContentFilters.tsx`
- 修改：`frontend/admin-web/src/content/ActionButtons.tsx`
- 修改：`frontend/admin-web/src/content/ContentPage.tsx`
- 修改：`frontend/admin-web/src/content/ContentTable.tsx`
- 修改：`frontend/admin-web/src/content/ContentPage.test.tsx`
- 修改：`frontend/admin-web/src/test/server.ts`
- 修改：`frontend/admin-web/src/styles.css`

- [ ] **步骤 1：把管理测试夹具切换为统一分页响应**

在 `server.ts` 增加：

```ts
export function adminContentItem(overrides: Partial<AdminContentListItem> = {}): AdminContentListItem {
  return {
    id: "movie-1", kind: "movie", name: "潮汐尽头", status: "draft", version: 3,
    created_at: "2026-09-01T00:00:00Z", poster_url: "/media/poster.webp", ...overrides,
  };
}

export function adminContentPage(items = [
  adminContentItem(),
  adminContentItem({ id: "series-1", kind: "series", name: "长夜航线", status: "published" }),
], total = items.length, page = 1): AdminContentPage {
  return { items, total, page, size: 20 };
}
```

默认 server 分支改为 `GET /api/admin/contents` 返回 `adminContentPage()`；保留电影和剧集详情接口的现有默认分支，编辑器测试仍需使用它们。

- [ ] **步骤 2：先改写统一请求、分页和序号测试并确认失败**

将 `ContentPage.test.tsx` 的列表 handler 改为返回分页对象，原“分别加载两个接口”断言改为：

```ts
expect(requests.filter((request) => request.url.startsWith("/api/admin/contents"))).toHaveLength(1);
expect(requests.some((request) => request.url.startsWith("/api/admin/movies?"))).toBe(false);
expect(requests.some((request) => request.url.startsWith("/api/admin/series?"))).toBe(false);
```

新增一个总数 21 的用例：第 1 页返回 20 行，第 2 页返回一行；点击“第 2 页”后断言 URL 为 `/api/admin/contents?kind=all&page=2`，唯一数据行的序号单元格为 `21`，摘要为“共 21 条 · 第 2/2 页”，第 2 页按钮带 `aria-current="page"`。

运行：

```bash
npm test --workspace @movie-harbor/admin-web -- ContentPage.test.tsx
```

预期：FAIL，页面仍请求两个旧接口且没有“序号”和数字页码。

- [ ] **步骤 3：提升列表状态并改用轻量行类型**

在 `ContentPage.tsx` 导出：

```ts
export type ContentListState = { filters: Filters; page: number; revision: number };
export const initialContentListState: ContentListState = { filters: initialFilters, page: 1, revision: 0 };
```

`App` 增加 `const [contentList, setContentList] = useState(initialContentListState)`，把二者作为 props 传入 `ContentPage`。删除电影或整个剧集成功及删除收尾警告返回列表时，除设置原通知外，还执行：

```ts
setContentList((value) => ({ ...value, revision: value.revision + 1 }));
```

`ActionButtons.tsx` 将 `ContentRow` 改为别名：

```ts
export type ContentRow = AdminContentListItem;
```

保留现有三种状态到操作按钮的映射，不再依赖完整电影/剧集详情或可选 `allowed_actions`。

同步更新原“按 `allowed_actions` 收窄按钮”的组件测试：删除该非正式字段夹具，保留草稿、已发布、已归档和未知状态四组断言，确保按钮集合只由受支持状态决定。

`ContentFilters` 增加 `initialValue: Filters` prop，并用 `useState(initialValue)` 初始化输入草稿。`ContentPage` 传入当前已应用的 `state.filters`，因此从编辑页返回重新挂载后，表单值与保留的查询条件一致。筛选提交使用函数式更新：

```ts
setState((value) => ({ ...value, filters, page: 1 }));
```

- [ ] **步骤 4：实现统一加载、当前页刷新与空页回退**

`ContentPage` 使用 `listAdminContent`，状态保存完整 `AdminContentPage | null`。请求参数固定为：

```ts
{
  kind: state.filters.kind,
  status: state.filters.status === "all" ? undefined : state.filters.status,
  name: state.filters.name || undefined,
  page: state.page,
}
```

新查询使用上一步的函数式更新把 `page` 设为 1；翻页只改 `page`；状态转换成功只递增 `revision`。加载新请求时保留上一份 `data`，设置 `loading=true` 并禁用翻页，失败时保留 `data` 和页码并显示现有中文错误。

响应为空且当前页越界时，不提交这份空数据，直接修正页码：

```ts
const lastPage = Math.max(1, Math.ceil(result.total / result.size));
if (state.page > lastPage) {
  setState((value) => ({ ...value, page: lastPage }));
  return;
}
setData(result);
```

保留 effect 的 `ignore` 清理标记，使旧查询的成功、失败和 401 都不能覆盖或注销较新的查询。

- [ ] **步骤 5：实现序号列和管理分页栏**

`ContentTable` 接收 `startIndex: number`。表头第一列为“序号”，每行第一格为 `startIndex + index + 1`；海报读取 `row.poster_url`。调用方传入 `(data.page - 1) * data.size`。

创建 `ContentPagination.tsx`，props 为：

```ts
type Props = {
  page: number;
  size: number;
  total: number;
  disabled: boolean;
  onPage: (page: number) => void;
};
```

总页数用 `Math.max(1, Math.ceil(total / size))`。渲染 `<nav aria-label="内容分页">`，左侧输出 `共 {total} 条 · 第 {page}/{totalPages} 页`，右侧按 `paginationItems` 渲染上一页、数字页码、省略号和下一页；数字按钮使用 `aria-label={`第 ${item} 页`}`，当前按钮设置 `aria-current="page"`，省略号使用带 `aria-hidden="true"` 的文本。

- [ ] **步骤 6：补齐状态保留、删除回退和过期请求测试**

在 `ContentPage.test.tsx` 增加或更新测试：

- 第 2 页执行归档后，重新请求仍带 `page=2`。
- 从第 2 页打开删除对话框并成功删除最后一行，返回列表第一次请求第 2 页得到 `{ total: 20, items: [] }`，随后请求第 1 页并显示 20 行。
- 在第 2 页打开查看页再点“返回列表”，请求仍带 `page=2`。
- 新查询从第 2 页发出时请求变成 `page=1`。
- 较旧页码请求延迟返回时不覆盖新页内容；较旧请求的延迟 401 不退出已成功的新会话。
- 后续页加载失败时原表格仍可见，分页摘要仍指向原页，重新加载按钮可以恢复。

运行测试，预期全部 PASS：

```bash
npm test --workspace @movie-harbor/admin-web -- ContentPage.test.tsx
```

- [ ] **步骤 7：实现 A 布局样式并验证响应式行为**

在 `styles.css` 增加 `.sequence-cell` 的窄列和 `.content-pagination-slot`、`.content-pagination`、`.content-pagination__summary`、`.content-pagination__controls`、`.content-pagination__page`、`.content-pagination__ellipsis`。分页 slot 始终渲染并设置最小高度，加载时不会让页面明显跳动；桌面端分页栏使用 `display:flex; justify-content:space-between; align-items:center`，`max-width:560px` 媒体查询下设置 `flex-wrap:wrap`，控件之间保留现有紧凑按钮间距。当前页按钮使用现有强调色，并确保禁用样式仍可辨认。

把现有样式测试扩展为断言分页容器 `justifyContent === "space-between"`，序号列不会挤压名称和操作列。

- [ ] **步骤 8：运行管理端聚焦验证并提交**

```bash
npm test --workspace @movie-harbor/admin-web
npm run build --workspace @movie-harbor/admin-web
git diff --check
```

预期：全部 PASS。然后提交：

```bash
git add frontend/admin-web/src/app/App.tsx frontend/admin-web/src/content frontend/admin-web/src/test/server.ts frontend/admin-web/src/styles.css
git commit -m "feat: 为管理内容列表增加分页"
```

---

### 任务 5：升级公开目录数字分页

**文件：**

- 创建：`frontend/public-web/src/catalog/CatalogPagination.tsx`
- 修改：`frontend/public-web/src/catalog/CatalogPage.tsx`
- 修改：`frontend/public-web/src/catalog/CatalogPage.test.tsx`
- 修改：`frontend/public-web/src/styles.css`

- [ ] **步骤 1：编写固定 20 条和数字跳页失败测试**

更新现有分页测试，使 handler 记录请求并返回 `total=221`。断言初始请求包含 `size=20`，点击“第 6 页”后 URL 为 `/?page=6`，新请求包含 `page=6&size=20`，当前按钮设置 `aria-current="page"`，并显示：

```text
1 … 5 6 7 … 12
```

这里文本由按钮和省略号节点组成，测试应在 `navigation` 内分别查询第 1、5、6、7、12 页按钮及两个省略号，不依赖整段空格拼接。

运行：

```bash
npm test --workspace @movie-harbor/public-web -- CatalogPage.test.tsx
```

预期：FAIL，请求仍带 `size=25`，且没有数字页码按钮。

- [ ] **步骤 2：创建公开分页组件并接入目录**

创建 `CatalogPagination.tsx`，接收 `{ page, size, total, disabled, onPage }`，计算方式与管理分页栏一致，并使用 `paginationItems`。输出 `<nav className="pagination" aria-label="目录分页">`；上一页、数字页码、下一页均使用共享 `Button`，当前页设置 `aria-current="page"`。

`CatalogPage.tsx` 把请求改为：

```ts
const load = useCallback(
  () => listCatalog({ kind, q: query, page, size: 20 }),
  [kind, query, page],
);
```

用 `CatalogPagination` 替换原来的三个节点分页栏。搜索和类型切换继续通过未传 `page` 的 `update` 回到第 1 页；数字页码继续调用 `update({ page: target })`，保持现有焦点标记。

- [ ] **步骤 3：增加越界 URL 规范化测试并实现**

测试从 `/?page=99` 启动，第一次返回 `{ page: 99, size: 20, total: 21, items: [] }`，断言应用使用 replace 导航到 `/?page=2`，重新加载第 2 页且没有短暂显示“没有找到匹配内容”。再测试 `total=0` 时 `/?page=99` 被规范到 `/`。

将现有 `update` 改为 `useCallback`，依赖 `[kind, query, page, navigate]`，并保持原有 URL 构造规则。在依赖 `[state, page, update]` 的 ready effect 中先处理越界，再处理焦点：

```ts
const totalPages = Math.max(1, Math.ceil(state.data.total / state.data.size));
if (page > totalPages) {
  update({ page: totalPages }, true);
  return;
}
if (focusAfterLoad.current) {
  focusAfterLoad.current = false;
  titleRef.current?.focus();
}
```

只有 `page > totalPages` 时调用 replace 修正 URL；第二次响应的页码已合法，因此不会循环导航。

- [ ] **步骤 4：验证历史、筛选重置、过期响应和样式**

扩展组件测试覆盖：

- 页码点击后目录标题获得焦点。
- 浏览器 `popstate` 恢复第 2 页。
- 第 2 页切换类型或搜索后 URL 中没有 `page`。
- 延迟的旧页响应不能覆盖新页。
- 页面加载时分页控件禁用，失败后不泄露服务端错误细节。

在目录内容后始终渲染 `.pagination-slot`，ready 时在其中放分页组件，loading 时保留空 slot；为 slot 设置与分页栏一致的最小高度。调整 `.pagination` 为可换行紧凑布局，新增数字页按钮和省略号样式；移动端仍居中，不产生横向滚动。

- [ ] **步骤 5：运行公开站测试、构建并提交**

```bash
npm test --workspace @movie-harbor/public-web
npm run build --workspace @movie-harbor/public-web
git diff --check
```

预期：全部 PASS。然后提交：

```bash
git add frontend/public-web/src/catalog/CatalogPagination.tsx frontend/public-web/src/catalog/CatalogPage.tsx frontend/public-web/src/catalog/CatalogPage.test.tsx frontend/public-web/src/styles.css
git commit -m "feat: 升级公开内容数字分页"
```

---

### 任务 6：增加真实跨服务分页验收并完成全量验证

**文件：**

- 修改：`tests/e2e/helpers.ts`
- 创建：`tests/e2e/pagination.spec.ts`
- 修改：`playwright.config.ts`

- [ ] **步骤 1：增加轻量发布助手和失败的跨页 E2E**

在 `helpers.ts` 增加只上传必需视频、不上传海报的助手：

```ts
export async function createPublishableMovieWithoutPoster(api: AdminApi, name: string) {
  let movie = await api.write<Movie>("post", "/api/admin/movies", { name });
  movie = await api.write<Movie>("patch", `/api/admin/movies/${movie.id}`, {
    version: movie.version,
    name,
    synopsis: `${name} pagination fixture`,
    year: 2026,
    duration_seconds: 1,
    genre_ids: [],
  });
  const uploaded = await api.upload<{ version: number }>(
    `/api/admin/media/movies/${movie.id}/video?version=${movie.version}`,
    video(),
  );
  return api.write<Movie>("post", `/api/admin/movies/${movie.id}/publish`, { version: uploaded.version });
}
```

创建 `pagination.spec.ts`：登录 API，顺序创建 21 个带唯一前缀的已发布电影；分别查询两个接口按各自排序认定的第 21 条名称，再验证两个真实页面：

```ts
import { expect, test } from "@playwright/test";
import {
  AdminApi,
  adminName,
  createPublishableMovieWithoutPoster,
  initialPassword,
} from "./helpers";

type PageResult = { page: number; size: number; total: number; items: Array<{ name: string }> };

test("admin and public content lists paginate after twenty items", async ({ page, playwright }) => {
  test.setTimeout(180_000);
  const api = await AdminApi.login(playwright);
  const prefix = `Pagination ${Date.now()}`;
  try {
    for (let index = 1; index <= 21; index += 1) {
      await createPublishableMovieWithoutPoster(api, `${prefix} ${String(index).padStart(2, "0")}`);
    }
    const encoded = encodeURIComponent(prefix);
    const adminSecond = await api.get<PageResult>(`/api/admin/contents?kind=movie&name=${encoded}&page=2`);
    const publicSecond = await api.get<PageResult>(`/api/catalog?kind=movie&q=${encoded}&page=2&size=20`);

    await page.goto("/admin/");
    await page.getByLabel("管理员名称").fill(adminName);
    await page.getByLabel("密码").fill(initialPassword);
    await page.getByRole("button", { name: "登录" }).click();
    await page.getByLabel("内容形态").selectOption("movie");
    await page.getByLabel("名称").fill(prefix);
    await page.getByRole("button", { name: "查询" }).click();
    await expect(page.locator(".content-table tbody tr")).toHaveCount(20);
    await expect(page.getByText("共 21 条 · 第 1/2 页")).toBeVisible();
    await page.getByRole("button", { name: "第 2 页" }).click();
    const adminRow = page.getByRole("row", { name: new RegExp(adminSecond.items[0].name) });
    await expect(adminRow.getByRole("cell", { name: "21" })).toBeVisible();

    await page.goto(`/?kind=movie&q=${encoded}`);
    const cards = page.getByRole("list", { name: "影片目录" }).getByRole("listitem");
    await expect(cards).toHaveCount(20);
    await page.getByRole("button", { name: "第 2 页" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(cards).toHaveCount(1);
    await expect(page.getByRole("link", { name: `查看${publicSecond.items[0].name}详情` })).toBeVisible();
  } finally {
    await api.dispose();
  }
});
```

- [ ] **步骤 2：将分页项目加入串行 E2E 依赖链**

在 `playwright.config.ts` 中加入：

```ts
{ name: "pagination", testMatch: /pagination\.spec\.ts/, dependencies: ["playback"] },
{ name: "admin", testMatch: /admin\.spec\.ts/, dependencies: ["pagination"] },
```

替换原来直接依赖 `playback` 的 admin 项目，使分页验收在 admin 项目修改初始密码之前运行，并继续使用同一个隔离 Compose 数据集和单 worker。

- [ ] **步骤 3：运行 E2E 并修正真实集成问题**

```bash
npm run test:e2e
```

预期：新分页项目以及既有 public、series、playback、admin、persistence 项目全部 PASS；E2E runner 正常清理隔离数据库和媒体目录。若失败，只修正失败所证明的当前分页契约问题，随后重新运行完整 E2E。

- [ ] **步骤 4：提交端到端验收**

```bash
git add tests/e2e/helpers.ts tests/e2e/pagination.spec.ts playwright.config.ts
git commit -m "test: 覆盖内容列表跨页浏览"
```

- [ ] **步骤 5：运行项目规定的完整验证集合**

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

预期：全部命令退出码为 0。读取每组最新输出；不得用先前单任务结果代替本步骤的全量结果。

- [ ] **步骤 6：检查交付边界和提交历史**

```bash
git status --short
git log --oneline -7
```

确认工作区干净；提交中没有媒体文件、数据库、真实 `.env` 或 `data/`；没有修改数据库迁移；旧管理电影/剧集列表接口和公开详情接口仍然存在；分页功能没有改变发布、归档、删除和媒体独占规则。
