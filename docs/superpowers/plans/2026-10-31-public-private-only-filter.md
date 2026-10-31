# 公开站“只看私密”筛选实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为已登录普通用户在公开站首页增加“只看私密”筛选，并由后端在认证、搜索、分页之前安全地只返回私密电影和私密剧集。

**架构：** 沿用现有 URL 驱动目录状态，在 `GET /api/catalog` 增加 `privacy=private`，由服务端把“是否允许查看私密内容”和“是否只请求私密内容”组合成公开、全部、私密或空四种结果范围。共享 API 客户端只暴露明确的字面量类型；公开站在现有内容类型控件旁渲染登录态复选项，并在身份失效时清理私密筛选和页码。

**技术栈：** Rust 2024、Axum 0.8、SeaORM/PostgreSQL、React 19、TypeScript 6、Vitest/Testing Library、Playwright。

---

## 文件结构

- 修改 `backend/src/catalog/dto.rs`：解析 `privacy=private`，在目录过滤对象中保存 `private_only`。
- 修改 `backend/src/catalog/query.rs`：让计数、搜索、分页和卡片查询同时应用公开/私密可见范围。
- 修改 `backend/tests/catalog_test.rs`：用真实 PostgreSQL 验证登录、匿名、类型、搜索和分页组合。
- 修改 `frontend/packages/api-client/src/public.ts`：为公开目录请求增加明确的 `privacy?: "private"` 类型并转发参数。
- 创建 `frontend/packages/api-client/src/public.test.ts`：验证公开目录客户端只发送受支持的查询字段。
- 修改 `frontend/public-web/src/catalog/CatalogToolbar.tsx`：在内容类型控件右侧渲染登录态“只看私密”复选项。
- 修改 `frontend/public-web/src/catalog/CatalogPage.tsx`：解析、写入和恢复 URL 状态，调用服务端筛选并显示专用空状态。
- 修改 `frontend/public-web/src/styles.css`：实现与现有深色紧凑顶栏一致的复选项及响应式布局。
- 修改 `frontend/public-web/src/catalog/CatalogPage.test.tsx`：覆盖匿名隐藏、URL 恢复、页码重置和旧响应隔离。
- 修改 `frontend/public-web/src/auth/ViewerAuth.test.tsx`：覆盖登录后显示以及退出、改密、会话失效后的 URL 清理。
- 修改 `tests/e2e/helpers.ts`：提供可复用的已发布剧集测试夹具。
- 修改 `tests/e2e/public.spec.ts`：跨服务验证公开、私密电影和私密剧集的真实筛选流程。

### 任务 1：后端目录契约和安全筛选

**文件：**
- 修改：`backend/src/catalog/dto.rs:10-83`
- 修改：`backend/src/catalog/query.rs:13-172, 275-345`
- 测试：`backend/tests/catalog_test.rs:200-330, 892-955, 1117-1171`

- [ ] **步骤 1：编写失败的真实数据库路由测试**

在 `backend/tests/catalog_test.rs` 的私密目录测试旁新增测试，复用 `private_fixture`：

```rust
#[tokio::test]
async fn private_only_catalog_requires_viewer_and_filters_before_count_search_and_pagination() {
    let (_db, _root, app, viewer, admin) = private_fixture("private_only").await;

    for cookie in [None, Some(admin.as_str()), Some("mh_viewer_session=invalid")] {
        let payload = json_body(
            get_with_cookie(&app, "/api/catalog?privacy=private", cookie).await,
        )
        .await;
        assert_eq!(payload["total"], 0);
        assert_eq!(payload["items"], serde_json::json!([]));
    }

    let all = json_body(
        get_with_cookie(&app, "/api/catalog?privacy=private", Some(&viewer)).await,
    )
    .await;
    assert_eq!(all["total"], 2);
    assert!(all["items"].as_array().unwrap().iter().all(|item| item["is_private"] == true));

    for (query, expected_name) in [
        ("kind=movie", "Private movie"),
        ("kind=series", "Private series"),
        ("q=movie", "Private movie"),
        ("q=series", "Private series"),
    ] {
        let payload = json_body(
            get_with_cookie(
                &app,
                &format!("/api/catalog?privacy=private&{query}"),
                Some(&viewer),
            )
            .await,
        )
        .await;
        assert_eq!(payload["total"], 1);
        assert_eq!(payload["items"][0]["name"], expected_name);
    }

    for page in [1, 2] {
        let payload = json_body(
            get_with_cookie(
                &app,
                &format!("/api/catalog?privacy=private&size=1&page={page}"),
                Some(&viewer),
            )
            .await,
        )
        .await;
        assert_eq!(payload["total"], 2);
        assert_eq!(payload["items"].as_array().unwrap().len(), 1);
        assert_eq!(payload["items"][0]["is_private"], true);
    }

    let unsupported = json_body(
        get_with_cookie(&app, "/api/catalog?privacy=public", Some(&viewer)).await,
    )
    .await;
    assert_eq!(unsupported["total"], 4);
}
```

同时把现有直接构造的 `CatalogFilter` 增加 `private_only: false`，并为生产 SQL 的 EXPLAIN 参数预留新增的公开/私密布尔值；此时不要修改生产查询。

- [ ] **步骤 2：运行测试验证正确失败**

运行：

```bash
docker compose -f docker-compose.test.yml up -d postgres
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace private_only_catalog_requires_viewer_and_filters_before_count_search_and_pagination -- --nocapture
```

预期：FAIL；已登录请求仍返回公开内容，匿名请求仍返回公开内容，说明 `privacy` 尚未参与过滤。

- [ ] **步骤 3：解析私密筛选并实现四种安全结果范围**

在 `CatalogRequest` 和 `CatalogFilter` 中增加字段：

```rust
pub struct CatalogRequest {
    pub kind: Option<String>,
    pub q: Option<String>,
    pub privacy: Option<String>,
    pub page: Option<u64>,
    pub size: Option<u64>,
}

pub struct CatalogFilter {
    pub kind: CatalogKind,
    pub search_pattern: Option<String>,
    pub private_only: bool,
    pub page: u64,
    pub size: u64,
    pub offset: u64,
    pub window: u64,
}
```

在 `TryFrom<CatalogRequest>` 中只把精确值 `private` 识别为筛选，其他值按未启用处理：

```rust
let private_only = value.privacy.as_deref() == Some("private");
```

在 `query::list_on` 中派生两个不可混淆的 SQL 许可值：

```rust
let allow_public = !filter.private_only;
let allow_private = include_private;
```

将计数、搜索计数、普通条目和搜索条目的每个电影/剧集分支统一改为：

```sql
AND ((movie.is_private = false AND $allow_public::boolean)
  OR (movie.is_private = true AND $allow_private::boolean))
```

剧集分支使用 `series.is_private`。按各 SQL 现有参数顺序追加 `allow_public` 和 `allow_private`，并同步更新 `count_values`、`values` 和 EXPLAIN 测试参数。不要改变详情查询：详情仍只由普通用户会话决定可见性。

- [ ] **步骤 4：运行后端聚焦测试和查询计划验证**

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace --test catalog_test -- --nocapture
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

预期：全部 PASS；公开目录仍使用既有索引，私密筛选的总数与分页条目一致。

- [ ] **步骤 5：提交后端交付物**

```bash
git add backend/src/catalog/dto.rs backend/src/catalog/query.rs backend/tests/catalog_test.rs
git commit -m "feat: filter public catalog to private content"
```

### 任务 2：共享 API 客户端的明确查询类型

**文件：**
- 修改：`frontend/packages/api-client/src/public.ts:1-30`
- 创建：`frontend/packages/api-client/src/public.test.ts`

- [ ] **步骤 1：编写失败的客户端契约测试**

创建 `frontend/packages/api-client/src/public.test.ts`：

```ts
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { listCatalog, type CatalogQuery } from "./public";

afterEach(() => vi.unstubAllGlobals());

it("forwards the typed private catalog filter and ignores unrelated properties", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response('{"page":2,"size":20,"total":0,"items":[]}', {
      headers: { "content-type": "application/json" },
    });
  });
  const query = {
    kind: "series",
    q: "星 海",
    privacy: "private",
    page: 2,
    size: 20,
    include_private: true,
  } as const;

  await listCatalog(query);

  expect(urls).toEqual(["/api/catalog?kind=series&q=%E6%98%9F+%E6%B5%B7&privacy=private&page=2&size=20"]);
});

it("keeps the public catalog privacy query as one explicit literal", () => {
  expectTypeOf<CatalogQuery["privacy"]>().toEqualTypeOf<"private" | undefined>();
});
```

- [ ] **步骤 2：运行测试验证正确失败**

运行：

```bash
npm test --prefix frontend/packages/api-client -- --run src/public.test.ts
```

预期：FAIL；`CatalogQuery` 尚无 `privacy`，并且请求 URL 未包含该参数。

- [ ] **步骤 3：实现最小明确类型和转发**

修改 `CatalogQuery` 与 `listCatalog`：

```ts
export interface CatalogQuery {
  kind?: CatalogKind;
  q?: string;
  privacy?: "private";
  page?: number;
  size?: number;
}

export async function listCatalog(query: CatalogQuery = {}): Promise<CatalogPage> {
  return requiredResponse(await apiRequest<CatalogPage>("/api/catalog", {
    query: {
      kind: query.kind,
      q: query.q,
      privacy: query.privacy,
      page: query.page,
      size: query.size,
    },
  }));
}
```

不使用 `unknown`、开放字符串或索引签名表示该字段。

- [ ] **步骤 4：运行客户端测试和类型构建**

运行：

```bash
npm test --prefix frontend/packages/api-client -- --run src/public.test.ts
npm run build --prefix frontend/packages/api-client
```

预期：全部 PASS。

- [ ] **步骤 5：提交客户端交付物**

```bash
git add frontend/packages/api-client/src/public.ts frontend/packages/api-client/src/public.test.ts
git commit -m "feat: expose private catalog query"
```

### 任务 3：公开站筛选控件、URL 状态与身份清理

**文件：**
- 修改：`frontend/public-web/src/catalog/CatalogToolbar.tsx:1-19`
- 修改：`frontend/public-web/src/catalog/CatalogPage.tsx:1-80`
- 修改：`frontend/public-web/src/styles.css:16-26, 91-103`
- 测试：`frontend/public-web/src/catalog/CatalogPage.test.tsx`
- 测试：`frontend/public-web/src/auth/ViewerAuth.test.tsx`

- [ ] **步骤 1：编写失败的匿名、登录和 URL 行为测试**

在 `CatalogPage.test.tsx` 增加匿名断言：

```ts
it("does not offer the private-only filter to anonymous visitors", async () => {
  serve(() => catalog([movieCard]));
  render(<App />);
  await screen.findByRole("link", { name: "查看远方来信详情" });
  expect(screen.queryByRole("checkbox", { name: "只看私密" })).not.toBeInTheDocument();
});
```

在 `ViewerAuth.test.tsx` 的测试服务器中，让目录响应根据 `privacy` 返回结果：

```ts
const privateOnly = url.searchParams.get("privacy") === "private";
const authenticatedItems = privateOnly
  ? [{ ...seriesCard, is_private: true }]
  : [movieCard, { ...seriesCard, is_private: true }];
return json({
  items: state.authenticated ? authenticatedItems : [movieCard],
  total: state.authenticated ? authenticatedItems.length : 1,
  page: Number(url.searchParams.get("page") ?? 1),
  size: 20,
});
```

增加登录筛选、组合查询和页码重置测试：

```ts
it("filters the authenticated catalog to private content and restores it from the URL", async () => {
  window.history.replaceState(null, "", "/?kind=series&q=%E6%98%9F&page=2");
  const state = server(true);
  const user = userEvent.setup();
  render(<App />);
  const filter = await screen.findByRole("checkbox", { name: "只看私密" });

  await user.click(filter);

  await screen.findByRole("link", { name: "查看群星之间详情" });
  expect(screen.queryByRole("link", { name: "查看远方来信详情" })).not.toBeInTheDocument();
  expect(location.search).toContain("kind=series");
  expect(location.search).toContain("q=%E6%98%9F");
  expect(location.search).toContain("privacy=private");
  expect(new URLSearchParams(location.search).get("page")).toBeNull();
  expect(state.requests.filter(({ url }) => url.pathname === "/api/catalog").at(-1)?.url.searchParams.get("privacy")).toBe("private");

  act(() => {
    window.history.pushState(null, "", "/?privacy=private");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(await screen.findByRole("checkbox", { name: "只看私密" })).toBeChecked();
});
```

增加退出、改密成功和焦点校验发现会话失效后，`privacy` 与 `page` 被移除而 `kind`、`q` 被保留的断言。再增加一个延迟普通目录响应，在切换到私密筛选后才完成，验证旧公开响应不能覆盖私密结果。

- [ ] **步骤 2：运行公开站测试验证正确失败**

运行：

```bash
npm test --prefix frontend/public-web -- --run src/catalog/CatalogPage.test.tsx src/auth/ViewerAuth.test.tsx
```

预期：FAIL；登录后没有复选项、URL 不写入 `privacy`，身份失效也不会清理该参数。

- [ ] **步骤 3：实现登录态工具栏控件**

扩展 `CatalogToolbar` 的明确属性：

```ts
{
  kind: CatalogKind;
  query: string;
  authenticated: boolean;
  privateOnly: boolean;
  onKindChange: (kind: CatalogKind) => void;
  onQueryChange: (query: string) => void;
  onPrivateOnlyChange: (privateOnly: boolean) => void;
}
```

在内容类型按钮组之后、搜索框之前渲染：

```tsx
{authenticated && <label className="private-only-filter">
  <input type="checkbox" checked={privateOnly}
    onChange={(event) => onPrivateOnlyChange(event.target.checked)} />
  <span>只看私密</span>
</label>}
```

- [ ] **步骤 4：实现 URL、请求、空状态和身份失效清理**

在 `CatalogPage` 中：

```ts
const { authenticated, discoveryPending } = useViewer();
const privateOnly = params.get("privacy") === "private";
const load = useCallback(() => listCatalog({
  kind,
  q: query,
  privacy: privateOnly ? "private" : undefined,
  page,
  size: 20,
}), [kind, query, privateOnly, page]);
```

把 `update` 的参数扩展为 `privateOnly?: boolean`，保留当前值并只在启用时写入 `privacy=private`：

```ts
const nextPrivateOnly = next.privateOnly ?? privateOnly;
if (nextPrivateOnly) updated.set("privacy", "private");
```

切换控件调用 `update({ privateOnly: value })`，因此默认页码回到 1。增加身份清理 Effect：

```ts
useEffect(() => {
  if (!discoveryPending && !authenticated && privateOnly) {
    update({ privateOnly: false }, true);
  }
}, [authenticated, discoveryPending, privateOnly, update]);
```

会话发现尚未完成且 URL 请求私密筛选时保持加载态，避免短暂显示空目录。私密筛选为空时显示：

```tsx
<div className="empty-state">
  <strong>没有找到私密内容</strong>
  <p>换个名称，或切换内容类型再试试。</p>
</div>
```

保留现有 `authenticated || !item.is_private` 客户端防御过滤，防止身份切换期间的旧私密响应短暂呈现。

- [ ] **步骤 5：实现紧凑样式和响应式布局**

在 `styles.css` 增加：

```css
.private-only-filter { min-height: 38px; display: inline-flex; align-items: center; gap: 7px; padding: 7px 11px; border: 1px solid var(--mh-color-border-strong); border-radius: 999px; background: var(--mh-color-surface); color: var(--mh-color-text); cursor: pointer; white-space: nowrap; }
.private-only-filter:hover { background: var(--mh-color-surface-hover); }
.private-only-filter:focus-within { box-shadow: var(--mh-focus-ring); }
.private-only-filter input { width: 16px; height: 16px; margin: 0; accent-color: var(--mh-color-accent); }
```

在窄屏规则中允许内容类型组和私密筛选自然换行，不改变搜索框全宽行为；不要把控件移入账号菜单或单独占一行。

- [ ] **步骤 6：运行前端聚焦测试和构建**

运行：

```bash
npm test --prefix frontend/public-web -- --run src/catalog/CatalogPage.test.tsx src/auth/ViewerAuth.test.tsx
npm run build --prefix frontend/public-web
```

预期：全部 PASS，无 TypeScript 错误或 React 警告。

- [ ] **步骤 7：提交公开站交付物**

```bash
git add frontend/public-web/src/catalog/CatalogToolbar.tsx frontend/public-web/src/catalog/CatalogPage.tsx frontend/public-web/src/styles.css frontend/public-web/src/catalog/CatalogPage.test.tsx frontend/public-web/src/auth/ViewerAuth.test.tsx
git commit -m "feat: add private-only catalog control"
```

### 任务 4：跨服务验收与完整验证

**文件：**
- 修改：`tests/e2e/helpers.ts:127-160`
- 修改：`tests/e2e/public.spec.ts:17-74`

- [ ] **步骤 1：编写失败的真实浏览器验收测试**

在 `tests/e2e/helpers.ts` 增加完整发布剧集夹具：

```ts
export async function createPublishableSeries(api: AdminApi, name: string) {
  let series = await createSeriesDraftWithMedia(api, name, {
    synopsis: `${name} searchable synopsis`,
    seasonNumber: 1,
    episodeNumber: 1,
    episodeName: "首集",
    durationSeconds: 1,
  });
  const season = series.seasons[0]!;
  const episode = season.episodes[0]!;
  const published = await api.write<{ series_version: number }>(
    "post",
    `/api/admin/series/${series.id}/seasons/${season.id}/episodes/${episode.id}/publish`,
    { version: episode.version },
  );
  series = await api.write<Series>("post", `/api/admin/series/${series.id}/publish`, {
    version: published.series_version,
  });
  return series;
}
```

在 `public.spec.ts` 增加一个独立测试：创建同一搜索前缀下的公开电影、私密电影和私密剧集；普通用户登录后勾选“只看私密”，断言公开电影消失、两种私密内容可见、URL 含 `privacy=private`；退出后断言控件消失、`privacy` 和 `page` 被清除、私密内容不可见。

- [ ] **步骤 2：运行新增 E2E 验收测试**

运行：

```bash
npm run test:e2e -- --grep "private-only catalog"
```

如果 runner 不转发 `--grep`，运行完整 `npm run test:e2e`。前 3 个任务已经分别通过先失败、再最小实现的测试循环；本步骤只增加跨服务验收，预期新增测试 PASS。若失败，失败点必须明确落在真实后端参数、浏览器交互或身份切换契约上。

- [ ] **步骤 3：根据真实验收结果做最小修正**

只修正 E2E 揭示的契约差异，例如可访问名称、URL 保留顺序或会话切换时机；不得扩大到“只看公开”、筛选偏好持久化或其他目录重构。修正后重新运行同一测试。

- [ ] **步骤 4：运行完整相关验证**

运行：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
npm test --workspaces
npm run build --workspaces
npm run test:e2e
git diff --check
git status --short
```

预期：全部 PASS；`git diff --check` 无输出；工作区只包含计划内待提交文件。

- [ ] **步骤 5：提交端到端验收**

```bash
git add tests/e2e/helpers.ts tests/e2e/public.spec.ts
git commit -m "test: cover private-only catalog flow"
```

- [ ] **步骤 6：提交后检查**

运行：

```bash
git status --short
git log -5 --oneline
```

预期：工作区干净，最近提交依次包含后端筛选、API 客户端、公开站控件和端到端验收。
