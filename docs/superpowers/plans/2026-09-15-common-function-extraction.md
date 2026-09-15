# Movie Harbor 公共函数提取实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将当前前后端至少有两个真实调用方的重复逻辑提取为职责明确的公共函数，同时保持全部 API、数据、错误和界面行为不变。

**架构：** 后端以内容规则、路由参数和媒体删除协议作为三个公共边界，领域服务继续负责电影、剧集和单集编排。前端分别在共享 API 客户端、管理内容域和公开剧集域内复用纯函数或小型展示组件，不建立全局工具箱或巨型编辑器 Hook。

**技术栈：** Rust 2024、Axum 0.8、SeaORM 1.1、PostgreSQL、React 19、TypeScript 6、Vitest、Testing Library、Playwright。

---

## 文件结构

- 创建 `backend/src/content.rs`：公共 Patch 类型、内容字段规则和生命周期规则。
- 创建 `backend/src/route_params.rs`：保留调用方错误语义的 UUID 路由参数解析。
- 修改 `backend/src/lib.rs`：注册后端公共模块。
- 修改 `backend/src/movies/dto.rs`、`backend/src/series/dto.rs`：统一使用公共 `Patch<T>`。
- 修改 `backend/src/movies/service.rs`、`backend/src/series/service.rs`：使用公共内容规则和媒体删除函数。
- 修改 `backend/src/{movies,series,genres,catalog}/routes.rs`、`backend/src/media/routes.rs`：使用公共 UUID 解析。
- 修改 `backend/src/media/removal.rs`：集中媒体资产加载、批量删除和删除事务收尾。
- 创建 `backend/tests/common_content_test.rs`：公共内容规则和路由参数行为测试。
- 修改 `backend/tests/media_removal_test.rs`：公共媒体数据库操作和事务收尾测试。
- 修改 `frontend/packages/api-client/src/http.ts`：导出响应体必填校验。
- 修改 `frontend/packages/api-client/src/admin.ts`、`frontend/packages/api-client/src/public.ts`：删除重复校验函数并复用共享实现。
- 修改 `frontend/packages/api-client/src/http.test.ts`：共享响应体校验测试。
- 创建 `frontend/admin-web/src/content/editorSupport.ts`：题材选项合并和编辑写错误分类。
- 创建 `frontend/admin-web/src/content/editorSupport.test.ts`：管理编辑器公共纯函数测试。
- 创建 `frontend/admin-web/src/content/ValidationFieldList.tsx`：通用字段错误列表。
- 创建 `frontend/admin-web/src/content/ValidationFieldList.test.tsx`：字段错误展示测试。
- 修改 `frontend/admin-web/src/movies/MovieEditor.tsx`、`frontend/admin-web/src/series/SeriesEditor.tsx`：复用管理内容辅助函数。
- 修改 `frontend/admin-web/src/movies/PublishErrors.tsx`、`frontend/admin-web/src/series/SeriesPublishErrors.tsx`：复用字段错误列表。
- 创建 `frontend/public-web/src/series/ordering.ts`：季、单集和可播放单集排序。
- 创建 `frontend/public-web/src/series/ordering.test.ts`：排序与不变性测试。
- 修改 `frontend/public-web/src/player/EpisodePicker.tsx`、`frontend/public-web/src/player/PlayerPage.tsx`、`frontend/public-web/src/details/SeriesDetails.tsx`：复用排序函数。

### 任务 1：提取后端内容规则

**文件：**
- 创建：`backend/tests/common_content_test.rs`
- 创建：`backend/src/content.rs`
- 修改：`backend/src/lib.rs`
- 修改：`backend/src/movies/dto.rs`
- 修改：`backend/src/series/dto.rs`
- 修改：`backend/src/movies/service.rs`
- 修改：`backend/src/series/service.rs`

- [ ] **步骤 1：编写公共规则失败测试**

创建 `backend/tests/common_content_test.rs`，使用字面量期望值覆盖：

```rust
use chrono::{TimeZone, Utc};
use movie_harbor_api::content::{
    ContentRuleError, Patch, TargetState, apply_optional_i32, apply_target_state,
    apply_text, ensure_transition, normalize_required, parse_target, parse_unique_uuids,
    require_positive_i32, require_positive_i64, require_version,
};

#[test]
fn normalizes_shared_content_fields() {
    assert_eq!(normalize_required("  片名  ".into()).unwrap(), "片名");
    assert_eq!(normalize_required("  ".into()), Err(ContentRuleError::Invalid));
    assert_eq!(require_positive_i64(1), Ok(()));
    assert_eq!(require_positive_i64(0), Err(ContentRuleError::Invalid));
    assert_eq!(require_positive_i32(2), Ok(()));
    assert_eq!(require_version(4, 4), Ok(()));
    assert_eq!(require_version(4, 3), Err(ContentRuleError::Conflict));
}

#[test]
fn parses_only_unique_uuid_lists() {
    let first = "00000000-0000-0000-0000-000000000001".to_string();
    let second = "00000000-0000-0000-0000-000000000002".to_string();
    assert_eq!(parse_unique_uuids(vec![first.clone(), second]).unwrap().len(), 2);
    assert_eq!(parse_unique_uuids(vec![first.clone(), first]), Err(ContentRuleError::Invalid));
    assert_eq!(parse_unique_uuids(vec!["bad".into()]), Err(ContentRuleError::Invalid));
}

#[test]
fn applies_patch_and_lifecycle_rules() {
    let mut text = "old".to_string();
    apply_text(&mut text, Patch::Value(" next ".into()), true).unwrap();
    assert_eq!(text, "next");
    assert_eq!(apply_text(&mut text, Patch::Null, true), Err(ContentRuleError::Invalid));

    let mut number = Some(2);
    apply_optional_i32(&mut number, Patch::Null, true).unwrap();
    assert_eq!(number, None);
    assert_eq!(apply_optional_i32(&mut number, Patch::Value(-1), true), Err(ContentRuleError::Invalid));

    let published = parse_target("published").unwrap();
    assert_eq!(published, TargetState::Published);
    assert_eq!(ensure_transition("draft", published), Ok(()));
    assert_eq!(ensure_transition("published", TargetState::Draft), Err(ContentRuleError::Conflict));

    let now = Utc.with_ymd_and_hms(2026, 9, 15, 12, 0, 0).unwrap().fixed_offset();
    let mut status = "draft".to_string();
    let mut published_at = None;
    let mut archived_at = None;
    apply_target_state(&mut status, &mut published_at, &mut archived_at, published, now);
    assert_eq!(status, "published");
    assert_eq!(published_at, Some(now));
    assert_eq!(archived_at, None);
}
```

补充断言：`Patch::Missing` 不修改值，非负可选整数接受零，已发布内容原样发布由 `TargetState::matches` 识别，归档转草稿会清空两个时间戳。

- [ ] **步骤 2：运行测试并确认正确失败**

运行：

```bash
cargo test -p movie-harbor-api --test common_content_test -- --nocapture
```

预期：FAIL，`movie_harbor_api::content` 尚不存在，而不是数据库或环境错误。

- [ ] **步骤 3：实现最小公共内容模块**

在 `backend/src/content.rs` 定义稳定接口：

```rust
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContentRuleError { Invalid, Conflict }

#[derive(Debug, Default)]
pub enum Patch<T> { #[default] Missing, Null, Value(T) }

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TargetState { Draft, Published, Archived }

pub fn normalize_required(value: String) -> Result<String, ContentRuleError>;
pub fn require_positive_i64(value: i64) -> Result<(), ContentRuleError>;
pub fn require_positive_i32(value: i32) -> Result<(), ContentRuleError>;
pub fn require_version(actual: i64, expected: i64) -> Result<(), ContentRuleError>;
pub fn parse_unique_uuids(values: Vec<String>) -> Result<Vec<Uuid>, ContentRuleError>;
pub fn apply_text(current: &mut String, patch: Patch<String>, nonblank: bool) -> Result<(), ContentRuleError>;
pub fn apply_optional_i32(current: &mut Option<i32>, patch: Patch<i32>, nonnegative: bool) -> Result<(), ContentRuleError>;
pub fn parse_target(value: &str) -> Result<TargetState, ContentRuleError>;
pub fn ensure_transition(current: &str, target: TargetState) -> Result<(), ContentRuleError>;
pub fn apply_target_state(
    status: &mut String,
    published_at: &mut Option<DateTime<FixedOffset>>,
    archived_at: &mut Option<DateTime<FixedOffset>>,
    target: TargetState,
    now: DateTime<FixedOffset>,
);
```

为 `Patch<T>` 搬迁原有 `Deserialize` 实现；为 `TargetState` 实现公开的 `matches(self, current: &str) -> bool`。在 `backend/src/lib.rs` 注册 `pub mod content;`。

- [ ] **步骤 4：运行公共规则测试确认通过**

运行：

```bash
cargo test -p movie-harbor-api --test common_content_test -- --nocapture
```

预期：测试全部 PASS，无警告。

- [ ] **步骤 5：替换电影和剧集调用方**

把 `Patch<T>` 从 `movies::dto` 移入公共模块，并修改两个 DTO 的导入。为领域错误增加精确映射：

```rust
impl From<ContentRuleError> for MovieError {
    fn from(error: ContentRuleError) -> Self {
        match error {
            ContentRuleError::Invalid => Self::Invalid,
            ContentRuleError::Conflict => Self::Conflict,
        }
    }
}
```

`SeriesError` 使用相同分类映射。电影和剧集服务删除本地的 `TargetState`、`normalize_name`、`valid_version`、`parse_ids`、`apply_text`、`apply_optional_i32`、`ensure_transition`、版本比较函数；调用公共函数并使用 `?` 映射。电影和剧集状态修改都调用：

```rust
apply_target_state(
    &mut model.status,
    &mut model.published_at,
    &mut model.archived_at,
    target,
    Utc::now().fixed_offset(),
);
```

剧集本地 `apply_required_number` 保留，但用 `require_positive_i32` 校验其值。

- [ ] **步骤 6：运行领域回归测试**

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test movies_test --test series_test -- --nocapture
```

预期：电影、剧集、季和单集的字段更新、版本冲突及生命周期测试全部 PASS。

- [ ] **步骤 7：提交**

```bash
git add backend/src/content.rs backend/src/lib.rs backend/src/movies backend/src/series backend/tests/common_content_test.rs
git commit -m "refactor: 提取公共内容规则"
```

### 任务 2：提取后端路由 UUID 参数解析

**文件：**
- 修改：`backend/tests/common_content_test.rs`
- 创建：`backend/src/route_params.rs`
- 修改：`backend/src/lib.rs`
- 修改：`backend/src/movies/routes.rs`
- 修改：`backend/src/series/routes.rs`
- 修改：`backend/src/genres/routes.rs`
- 修改：`backend/src/catalog/routes.rs`
- 修改：`backend/src/media/routes.rs`

- [ ] **步骤 1：编写失败的路由参数测试**

在 `backend/tests/common_content_test.rs` 添加：

```rust
use movie_harbor_api::route_params::parse_uuid;

#[test]
fn uuid_parser_preserves_the_callers_error_value() {
    let valid = parse_uuid(
        "00000000-0000-0000-0000-000000000001".to_string(),
        "invalid",
    );
    assert_eq!(valid.unwrap().to_string(), "00000000-0000-0000-0000-000000000001");
    assert_eq!(parse_uuid("bad".to_string(), "invalid"), Err("invalid"));
}
```

这个测试要抓住的破坏是：公共解析器擅自统一错误类型，使公开 404 与管理 400 的既有差异丢失。

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cargo test -p movie-harbor-api --test common_content_test uuid_parser -- --nocapture
```

预期：FAIL，`route_params` 模块尚不存在。

- [ ] **步骤 3：实现并接入公共解析器**

创建：

```rust
pub fn parse_uuid<E>(value: String, error: E) -> Result<Uuid, E> {
    value.parse().map_err(|_| error)
}
```

注册模块后，五个路由模块分别调用 `parse_uuid(value, MovieError::Invalid)`、`SeriesError::Invalid`、`GenreError::Invalid`、`CatalogError::NotFound` 和 `MediaError::TargetNotFound`，删除各自的 `parse_id` 私有函数及无用的 `Uuid` 导入。

- [ ] **步骤 4：运行路由回归测试**

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test auth_test --test genres_test --test movies_test --test series_test --test catalog_test --test media_upload_test -- --nocapture
```

预期：合法 ID 行为不变；非法管理 ID 继续返回 400，非法公开内容 ID 继续返回 404。

- [ ] **步骤 5：提交**

```bash
git add backend/src/route_params.rs backend/src/lib.rs backend/src/*/routes.rs backend/tests/common_content_test.rs
git commit -m "refactor: 统一路由 UUID 解析"
```

### 任务 3：集中媒体资产删除辅助函数

**文件：**
- 修改：`backend/src/media/removal.rs`
- 修改：`backend/src/movies/service.rs`
- 修改：`backend/src/series/service.rs`
- 修改：`backend/tests/media_removal_test.rs`

- [ ] **步骤 1：编写媒体数据库辅助函数失败测试**

在现有真实 PostgreSQL 媒体删除测试 fixture 中创建两个 `media_asset`，然后添加：

```rust
let loaded = removal::load_owned_media(&db, &[first.id, second.id]).await.unwrap();
assert_eq!(loaded.len(), 2);
assert!(loaded.iter().any(|item| item.storage_key == first.storage_key));

removal::delete_media_assets(&db, &[first.id, second.id]).await.unwrap();
assert!(media_asset::Entity::find_by_id(first.id).one(&db).await.unwrap().is_none());
assert!(media_asset::Entity::find_by_id(second.id).one(&db).await.unwrap().is_none());
```

另用已经由 `removal::stage` 创建的 `StagedRemoval` 和测试事务覆盖公共收尾结果：数据库操作错误时回滚并恢复文件；提交成功时返回删除数量；提交后清理错误返回独立的 `Finalize` 分类。

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test media_removal_test common_delete_helpers -- --nocapture
```

预期：FAIL，`load_owned_media`、`delete_media_assets` 或公共事务收尾接口尚不存在。

- [ ] **步骤 3：实现媒体公共函数**

在 `backend/src/media/removal.rs` 增加：

```rust
pub async fn load_owned_media<C: ConnectionTrait>(
    db: &C,
    ids: &[Uuid],
) -> Result<Vec<OwnedMedia>, DbErr>;

pub async fn delete_media_assets<C: ConnectionTrait>(
    db: &C,
    ids: &[Uuid],
) -> Result<(), DbErr>;

#[derive(Debug)]
pub enum FinishDeleteError<E> {
    Operation(E),
    Restore,
    Commit,
    Finalize,
}

pub async fn finish_delete_transaction<E>(
    tx: DatabaseTransaction,
    staged: StagedRemoval,
    deleted_media_count: usize,
    database_result: Result<(), E>,
) -> Result<u64, FinishDeleteError<E>>;
```

加载函数对空 ID 返回空数组；删除函数对空 ID 不发 SQL；事务收尾保留现有逆序恢复、提交后清理和数量转换语义。

- [ ] **步骤 4：运行媒体辅助函数测试确认通过**

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test media_removal_test common_delete_helpers -- --nocapture
```

预期：新增用例全部 PASS。

- [ ] **步骤 5：替换电影和剧集重复实现**

电影和剧集服务删除各自的 `load_owned_media`、`delete_media_assets`，统一调用 `removal` 模块。电影删除与剧集既有 `finish_delete_transaction` 都改用公共事务收尾，并在调用方映射：

```rust
match removal::finish_delete_transaction(tx, staged, owned.len(), database_result).await {
    Ok(count) => Ok(DeleteResultResponse { deleted_media_count: count }),
    Err(FinishDeleteError::Operation(DomainError::Database)) => Err(DomainError::MediaDelete),
    Err(FinishDeleteError::Operation(error)) => Err(error),
    Err(FinishDeleteError::Restore | FinishDeleteError::Commit) => Err(DomainError::MediaDelete),
    Err(FinishDeleteError::Finalize) => Err(DomainError::MediaDeleteFinalization),
}
```

其中 `DomainError` 在电影和剧集文件中分别写为 `MovieError`、`SeriesError`，不新增统一业务错误枚举。

- [ ] **步骤 6：运行媒体与删除回归测试**

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test media_removal_test --test media_upload_test --test movies_test --test series_test -- --nocapture
```

预期：媒体暂存、恢复、最终化及电影/剧集/季/单集删除用例全部 PASS。

- [ ] **步骤 7：提交**

```bash
git add backend/src/media/removal.rs backend/src/movies/service.rs backend/src/series/service.rs backend/tests/media_removal_test.rs
git commit -m "refactor: 集中媒体删除辅助逻辑"
```

### 任务 4：共享前端 API 响应体校验

**文件：**
- 修改：`frontend/packages/api-client/src/http.test.ts`
- 修改：`frontend/packages/api-client/src/http.ts`
- 修改：`frontend/packages/api-client/src/admin.ts`
- 修改：`frontend/packages/api-client/src/public.ts`

- [ ] **步骤 1：编写失败测试**

在 `http.test.ts` 添加：

```ts
import { requiredResponse } from "./http";

test("requiredResponse preserves values and rejects an absent body", () => {
  expect(requiredResponse({ id: "movie-1" })).toEqual({ id: "movie-1" });
  expect(() => requiredResponse(undefined)).toThrowError(
    new TypeError("Expected an API response body"),
  );
  expect(requiredResponse(null)).toBeNull();
});
```

该测试独立确认只有 `undefined` 代表缺失响应，不能误拒绝合法的 `null`、空数组或空字符串。

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
npm test --workspace @movie-harbor/api-client -- src/http.test.ts
```

预期：FAIL，`requiredResponse` 尚未导出。

- [ ] **步骤 3：实现并替换调用方**

在 `http.ts` 导出：

```ts
export function requiredResponse<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("Expected an API response body");
  return value;
}
```

`admin.ts` 与 `public.ts` 导入并使用 `requiredResponse`，删除两个本地 `required` 函数。不要改变任何请求路径、HTTP method、query 或返回类型。

- [ ] **步骤 4：运行 API 客户端测试与构建**

运行：

```bash
npm test --workspace @movie-harbor/api-client
npm run build --workspace @movie-harbor/api-client
```

预期：全部 PASS，TypeScript 无类型错误。

- [ ] **步骤 5：提交**

```bash
git add frontend/packages/api-client/src
git commit -m "refactor: 共享 API 响应校验"
```

### 任务 5：提取管理编辑器公共辅助逻辑

**文件：**
- 创建：`frontend/admin-web/src/content/editorSupport.test.ts`
- 创建：`frontend/admin-web/src/content/editorSupport.ts`
- 创建：`frontend/admin-web/src/content/ValidationFieldList.test.tsx`
- 创建：`frontend/admin-web/src/content/ValidationFieldList.tsx`
- 修改：`frontend/admin-web/src/movies/MovieEditor.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.tsx`
- 修改：`frontend/admin-web/src/movies/PublishErrors.tsx`
- 修改：`frontend/admin-web/src/series/SeriesPublishErrors.tsx`

- [ ] **步骤 1：编写题材合并和错误分类失败测试**

创建 `editorSupport.test.ts`：

```ts
import { ApiError } from "@movie-harbor/api-client";
import { classifyEditorWriteError, mergeGenreChoices } from "./editorSupport";

test("mergeGenreChoices keeps available order and appends linked inactive genres once", () => {
  const available = [
    { id: "g1", name: "剧情", enabled: true, sort_order: 1 },
    { id: "g2", name: "科幻", enabled: true, sort_order: 2 },
  ];
  const linked = [available[0], { id: "g3", name: "旧题材", enabled: false }];
  expect(mergeGenreChoices(available, linked).map((genre) => genre.id)).toEqual(["g1", "g2", "g3"]);
});

test("classifyEditorWriteError preserves stable media and validation outcomes", () => {
  expect(classifyEditorWriteError(new ApiError(500, "", "", { code: "media_delete_failed" })))
    .toEqual({ kind: "message", message: "删除失败，内容和媒体文件已保留，请检查媒体目录权限后重试。" });
  expect(classifyEditorWriteError(new ApiError(422, "", "", { fields: ["name", 7] })))
    .toEqual({ kind: "validation", fields: ["name"] });
  expect(classifyEditorWriteError(new ApiError(409, "", "", undefined)))
    .toEqual({ kind: "conflict" });
});
```

补充媒体替换失败、媒体内容不匹配、普通 `ApiError` 和非 API 异常断言。401 与 403 继续由编辑器和现有 `recoverForbiddenWrite` 处理，不纳入这个纯分类器。

- [ ] **步骤 2：编写字段列表失败测试**

创建 `ValidationFieldList.test.tsx`：

```tsx
render(<ValidationFieldList fields={["name", "video"]} labels={{ name: "名称", video: "可播放视频" }} />);
expect(screen.getByRole("alert")).toHaveTextContent("名称");
expect(screen.getByRole("alert")).toHaveTextContent("可播放视频");
```

再断言未知字段保持原值、空字段不渲染 alert。

- [ ] **步骤 3：运行测试确认失败**

运行：

```bash
npm test --workspace @movie-harbor/admin-web -- src/content/editorSupport.test.ts src/content/ValidationFieldList.test.tsx
```

预期：FAIL，两个公共模块尚不存在。

- [ ] **步骤 4：实现最小公共辅助函数与组件**

`editorSupport.ts` 导出：

```ts
export type EditorWriteError =
  | { kind: "conflict" }
  | { kind: "validation"; fields: string[] }
  | { kind: "message"; message: string };

export type GenreChoice = Pick<GenreResponse, "id" | "name" | "enabled">;

export function mergeGenreChoices(
  available: GenreChoice[],
  linked: GenreChoice[],
): GenreChoice[];

export function classifyEditorWriteError(cause: unknown): EditorWriteError;
```

题材合并不修改输入数组；追加项使用既有数据，不合成虚假 ID 或 `sort_order`。普通错误文案与当前编辑器逐字一致。

`ValidationFieldList.tsx` 接收 `fields` 和 `labels`，只在非空时渲染当前共同结构：

```tsx
<div role="alert" className="error-message">
  <p>请检查以下缺失项或错误字段：</p>
  <ul>{fields.map((field) => <li key={field}>{labels[field] ?? field}</li>)}</ul>
</div>
```

- [ ] **步骤 5：替换编辑器和发布错误调用方**

电影和剧集编辑器用 `mergeGenreChoices(genres, content.genres)` 替换重复数组拼接。各自 `fail` 保留 mounted、401、403 和本地 UI 状态编排，其余分支改为调用分类器：冲突时设置 `conflict` 并关闭删除对话框；校验时设置 `invalid`；消息结果写入 `error`。

`PublishErrors` 先过滤 `poster` 后使用 `ValidationFieldList`。`SeriesPublishErrors` 保留 `episodes` 专属段落，并把剩余字段交给 `ValidationFieldList`；不得产生嵌套的两个 `role="alert"`，因此公共组件增加可选 `role` 参数，剧集组合场景传 `role={undefined}` 并由外层提供唯一 alert。

- [ ] **步骤 6：运行管理后台回归测试与构建**

运行：

```bash
npm test --workspace @movie-harbor/admin-web
npm run build --workspace @movie-harbor/admin-web
```

预期：电影与剧集编辑、上传错误、删除错误、发布提示和题材停用兼容测试全部 PASS。

- [ ] **步骤 7：提交**

```bash
git add frontend/admin-web/src/content frontend/admin-web/src/movies frontend/admin-web/src/series
git commit -m "refactor: 提取管理编辑器公共逻辑"
```

### 任务 6：统一公开站剧集排序

**文件：**
- 创建：`frontend/public-web/src/series/ordering.test.ts`
- 创建：`frontend/public-web/src/series/ordering.ts`
- 修改：`frontend/public-web/src/player/EpisodePicker.tsx`
- 修改：`frontend/public-web/src/player/PlayerPage.tsx`
- 修改：`frontend/public-web/src/details/SeriesDetails.tsx`

- [ ] **步骤 1：编写失败的排序测试**

创建 `ordering.test.ts`，使用逆序 fixture：

```ts
import { orderEpisodes, orderSeasons, orderedPlayableEpisodes } from "./ordering";

test("orders seasons and episodes without mutating API data", () => {
  const seasons = [
    { id: "s2", number: 2, episodes: [{ id: "e2", number: 2, name: "二", duration_seconds: null, video_url: "/2" }] },
    { id: "s1", number: 1, episodes: [{ id: "e1", number: 1, name: "一", duration_seconds: null, video_url: "/1" }] },
  ];
  expect(orderSeasons(seasons).map((season) => season.id)).toEqual(["s1", "s2"]);
  expect(seasons.map((season) => season.id)).toEqual(["s2", "s1"]);
  expect(orderEpisodes([{ ...seasons[0].episodes[0], number: 2 }, { ...seasons[1].episodes[0], number: 1 }]).map((episode) => episode.number)).toEqual([1, 2]);
  expect(orderedPlayableEpisodes(seasons).map((episode) => episode.id)).toEqual(["e1", "e2"]);
});
```

补充断言：无 `video_url` 的单集不会进入可播放序列，但仍保留在详情页的 `orderEpisodes` 结果中。

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
npm test --workspace @movie-harbor/public-web -- src/series/ordering.test.ts
```

预期：FAIL，`series/ordering` 尚不存在。

- [ ] **步骤 3：实现纯排序函数**

创建：

```ts
export interface OrderedEpisode extends PublicEpisode {
  seasonId: string;
  seasonNumber: number;
}

export function orderSeasons(seasons: PublicSeason[]): PublicSeason[] {
  return [...seasons].sort((left, right) => left.number - right.number);
}

export function orderEpisodes(episodes: PublicEpisode[]): PublicEpisode[] {
  return [...episodes].sort((left, right) => left.number - right.number);
}

export function orderedPlayableEpisodes(seasons: PublicSeason[]): OrderedEpisode[] {
  return orderSeasons(seasons).flatMap((season) =>
    orderEpisodes(season.episodes)
      .filter((episode) => episode.video_url)
      .map((episode) => ({ ...episode, seasonId: season.id, seasonNumber: season.number })),
  );
}
```

- [ ] **步骤 4：替换详情、选集器和播放器调用方**

从 `EpisodePicker.tsx` 移除排序函数和类型定义，改为从 `series/ordering` 导入。`SeriesDetails.tsx` 使用 `orderSeasons`、`orderEpisodes`；`PlayerPage.tsx` 从新模块导入可播放序列和类型。页面结构、链接、状态保存和文字不变。

- [ ] **步骤 5：运行公开站回归测试与构建**

运行：

```bash
npm test --workspace @movie-harbor/public-web
npm run build --workspace @movie-harbor/public-web
```

预期：详情、选集、上下集导航、本地进度和路由测试全部 PASS。

- [ ] **步骤 6：提交**

```bash
git add frontend/public-web/src/series frontend/public-web/src/player frontend/public-web/src/details
git commit -m "refactor: 统一公开剧集排序"
```

### 任务 7：全量扫描与完成前验证

**文件：**
- 检查：全部已修改文件
- 不修改：`docs/superpowers/plans/2026-09-15-admin-and-public-content-pagination.md` 及其他用户无关文件

- [ ] **步骤 1：检查重复实现是否已移除**

运行：

```bash
rg -n 'fn normalize_name|fn valid_version|fn parse_ids|fn apply_text|fn apply_optional_i32|fn ensure_transition|fn load_owned_media|fn delete_media_assets|fn parse_id|function required' backend/src frontend -g '!*.test.*'
```

预期：只显示公共模块中的单一实现；领域专属的 `apply_required_number`、发布校验和 editor 编排仍保留。

- [ ] **步骤 2：启动隔离测试数据库**

运行：

```bash
docker compose -f docker-compose.test.yml up -d postgres
```

预期：PostgreSQL 测试服务健康，不触碰生产默认数据目录。

- [ ] **步骤 3：执行完整 Rust 验证**

运行：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
```

预期：格式、Clippy 和全部 Rust 测试退出码均为 0。

- [ ] **步骤 4：执行完整前端与契约验证**

运行：

```bash
npm test --workspaces
npm run build --workspaces
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
```

预期：全部前端测试、构建和 Node 契约测试退出码均为 0。

- [ ] **步骤 5：执行跨服务验收**

运行：

```bash
npm run test:e2e
```

预期：E2E runner 使用隔离 Compose 项目和数据目录，全部 Playwright 场景通过。

- [ ] **步骤 6：检查差异和工作区边界**

运行：

```bash
git diff --check
git status --short
```

预期：无空白错误；变更仅包含本计划的公共函数、调用方、测试和计划状态。现有未跟踪分页计划保持原样。

- [ ] **步骤 7：提交验证阶段必要修正**

若步骤 1–6 暴露只属于本次重构的格式或类型修正，完成修正、重新运行受影响命令后提交：

```bash
git add backend frontend docs/superpowers/plans/2026-09-15-common-function-extraction.md
git commit -m "test: 验证公共函数重构"
```

如果没有新增修正，则不创建空提交。
