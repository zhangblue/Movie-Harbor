# 剧集单集体验修订实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 删除单集简介，并让剧集详情页以带时长的双列卡片展示单集、播放页相邻导航显示目标集名称。

**架构：** 先用可逆迁移和后端契约调整移除 `episode.synopsis`，再同步收紧共享 TypeScript 类型与管理后台表单。公开站只消费新的单集契约：详情页负责双列卡片和时长，播放页继续复用既有有序可播放列表，仅增强导航标签。

**技术栈：** Rust、Axum、SeaORM Migration、PostgreSQL、React、TypeScript、Vitest、Testing Library。

---

## 文件结构

- 创建 `backend/migration/src/m20260912_000004_drop_episode_synopsis.rs`：删除和恢复单集简介列。
- 修改 `backend/migration/src/lib.rs`、`backend/tests/migration_test.rs`：注册并验证迁移。
- 修改 `backend/src/entities/episode.rs`、`backend/src/series/dto.rs`、`backend/src/series/service.rs`：从管理领域模型和 API 移除单集简介。
- 修改 `backend/src/catalog/dto.rs`、`backend/src/catalog/query.rs`：从公开查询和响应移除单集简介。
- 修改 `backend/tests/series_test.rs`、`backend/tests/catalog_test.rs`：锁定后端契约。
- 修改 `frontend/packages/api-client/src/types.ts`：收紧共享单集类型。
- 修改 `frontend/admin-web/src/series/EpisodeRow.tsx`、`frontend/admin-web/src/series/SeriesEditor.test.tsx`：移除简介输入和提交。
- 修改 `frontend/public-web/src/test/fixtures.ts`、`frontend/public-web/src/details/SeriesDetails.tsx`、`frontend/public-web/src/details/Details.test.tsx`、`frontend/public-web/src/styles.css`：实现带时长的响应式双列卡片。
- 修改 `frontend/public-web/src/player/PlayerPage.tsx`、`frontend/public-web/src/player/PlayerPage.test.tsx`：导航显示目标单集名称。

### 任务 1：从数据库和后端 API 删除单集简介

**文件：**
- 创建：`backend/migration/src/m20260912_000004_drop_episode_synopsis.rs`
- 修改：`backend/migration/src/lib.rs`
- 修改：`backend/tests/migration_test.rs`
- 修改：`backend/src/entities/episode.rs`
- 修改：`backend/src/series/dto.rs`
- 修改：`backend/src/series/service.rs`
- 修改：`backend/src/catalog/dto.rs`
- 修改：`backend/src/catalog/query.rs`
- 测试：`backend/tests/series_test.rs`
- 测试：`backend/tests/catalog_test.rs`

- [ ] **步骤 1：编写失败的迁移测试**

在 `backend/tests/migration_test.rs` 新增：

```rust
#[tokio::test]
async fn episode_synopsis_migration_is_reversible() {
    let db = isolated_database().await;
    migration::Migrator::up(&db, Some(3)).await.unwrap();
    sql(&db, "INSERT INTO series (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'Series')").await;
    sql(&db, "INSERT INTO season (id, series_id, number) VALUES ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 1)").await;
    sql(&db, "INSERT INTO episode (id, season_id, number, name, synopsis) VALUES ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000011', 1, 'Pilot', 'remove me')").await;
    migration::Migrator::up(&db, None).await.unwrap();
    let row = db.query_one(Statement::from_string(DbBackend::Postgres,
        "SELECT count(*)::bigint AS count FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='episode' AND column_name='synopsis'".into())).await.unwrap().unwrap();
    assert_eq!(row.try_get::<i64>("", "count").unwrap(), 0);
    migration::Migrator::down(&db, Some(1)).await.unwrap();
    sql(&db, "INSERT INTO episode (id, season_id, number, name) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000011', 2, 'Second')").await;
    db.rollback().await.unwrap();
}
```

- [ ] **步骤 2：编写失败的 API 契约断言**

在管理和公开单集响应测试中加入：

```rust
let episode = &body["seasons"][0]["episodes"][0];
assert!(episode.get("synopsis").is_none());
assert_eq!(episode["name"], "Dulcinea");
assert_eq!(episode["duration_seconds"], 2700);
```

更新请求只发送：

```rust
json!({"version": 1, "number": 1, "name": "Dulcinea", "duration_seconds": 2700})
```

- [ ] **步骤 3：运行测试确认失败**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test migration_test episode_synopsis_migration_is_reversible -- --nocapture
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test series_test -- --nocapture
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test catalog_test -- --nocapture
```

预期：迁移尚不存在，响应仍含 `synopsis`，测试失败。

- [ ] **步骤 4：实现可逆迁移**

```rust
#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared("ALTER TABLE episode DROP COLUMN synopsis").await?;
        Ok(())
    }
    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager.get_connection().execute_unprepared("ALTER TABLE episode ADD COLUMN synopsis text NOT NULL DEFAULT ''").await?;
        Ok(())
    }
}
```

在 `backend/migration/src/lib.rs` 注册为第 4 项。

- [ ] **步骤 5：移除后端所有单集简介读写**

删除 `episode::Model.synopsis`、`UpdateEpisodeRequest.synopsis`、`EpisodeResponse.synopsis`、`PublicEpisode.synopsis` 和相应构造器赋值；创建、更新服务不再设置或应用简介。公开 SQL 改为：

```sql
SELECT season.id AS season_id, season.number AS season_number,
       episode.id, episode.number, episode.name, episode.duration_seconds,
       video.storage_key AS video_storage_key
```

`EpisodeRow` 查询结构只保留 `season_id`、`season_number`、`id`、`number`、`name`、`duration_seconds` 和 `video_storage_key`。

- [ ] **步骤 6：运行后端测试确认通过**

```bash
cargo fmt --all -- --check
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test migration_test -- --nocapture
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test series_test -- --nocapture
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test catalog_test -- --nocapture
```

预期：全部通过，单集响应不再序列化简介。

- [ ] **步骤 7：提交**

```bash
git add backend/migration/src backend/tests/migration_test.rs backend/tests/series_test.rs backend/tests/catalog_test.rs backend/src/entities/episode.rs backend/src/series backend/src/catalog
git commit -m "feat: 删除单集简介后端契约"
```

### 任务 2：从共享类型和管理后台删除单集简介

**文件：**
- 修改：`frontend/packages/api-client/src/types.ts`
- 修改：`frontend/admin-web/src/series/EpisodeRow.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.test.tsx`
- 修改：`frontend/admin-web/src/test/server.ts`

- [ ] **步骤 1：编写失败的管理后台测试**

```tsx
it("does not render or submit an episode synopsis", async () => {
  const requests = fixture(detail());
  const user = userEvent.setup();
  editor();
  await screen.findByLabelText("单集名称");
  expect(screen.queryByLabelText("单集简介")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存单集草稿" }));
  expect(requests.find((request) => request.method === "PATCH" && request.url === episodePath)?.body)
    .toEqual({ version: 2, number: 1, name: "来信", duration_seconds: 2700 });
});
```

- [ ] **步骤 2：运行测试确认失败**

```bash
npm test --workspace @movie-harbor/admin-web -- src/series/SeriesEditor.test.tsx
```

预期：页面仍存在“单集简介”，请求体仍包含 `synopsis`。

- [ ] **步骤 3：收紧类型并删除表单状态**

```ts
export interface PublicEpisode {
  id: string; number: number; name: string; duration_seconds: number | null; video_url: string | null;
}
export interface EpisodeResponse {
  id: string; season_id: string; number: number; name: string; duration_seconds: number | null;
  status: ContentStatus; version: number; published_at: string | null; archived_at: string | null;
  created_at: string; updated_at: string; video: MediaSummary | null;
}
export interface UpdateEpisodeRequest {
  version: number; number?: number | null; name?: string | null; duration_seconds?: number | null;
}
```

`EpisodeRow` 删除简介 state、effect 同步、textarea 和保存参数，保存对象改为：

```tsx
{ number: Number(number), name, duration_seconds: minutes === "" ? null : Math.round(Number(minutes) * 60) }
```

- [ ] **步骤 4：更新 fixture 并验证**

```bash
npm test --workspace @movie-harbor/admin-web -- src/series/SeriesEditor.test.tsx
npm run build --workspace @movie-harbor/admin-web
```

预期：测试和构建通过。

- [ ] **步骤 5：提交**

```bash
git add frontend/packages/api-client/src/types.ts frontend/admin-web/src/series frontend/admin-web/src/test/server.ts
git commit -m "feat: 移除单集简介表单"
```

### 任务 3：实现带时长的双列选集卡片

**文件：**
- 修改：`frontend/public-web/src/test/fixtures.ts`
- 修改：`frontend/public-web/src/details/SeriesDetails.tsx`
- 修改：`frontend/public-web/src/details/Details.test.tsx`
- 修改：`frontend/public-web/src/styles.css`

- [ ] **步骤 1：编写失败的详情页测试**

更新公开 fixture，移除单集简介，并加入：

```tsx
const episodeList = screen.getByRole("list", { name: "第 1 季单集" });
expect(episodeList).toHaveClass("episode-list");
expect(screen.getByRole("link", { name: "第 1 集 · 启程，35 分钟" })).toBeInTheDocument();
expect(screen.getByText("40 分钟")).toBeInTheDocument();
expect(screen.queryByText("第一步")).not.toBeInTheDocument();
```

- [ ] **步骤 2：运行测试确认失败**

```bash
npm test --workspace @movie-harbor/public-web -- src/details/Details.test.tsx
```

预期：列表无季名称，整卡链接也没有包含时长的可访问名称。

- [ ] **步骤 3：实现整卡入口**

```tsx
<ol className="episode-list" aria-label={`第 ${season.number} 季单集`}>
  {episodes.map((episode) => {
    const label = `第 ${episode.number} 集 · ${episode.name}`;
    const duration = durationLabel(episode.duration_seconds);
    return <li key={episode.id}>
      {episode.video_url ? <a className="episode-card" aria-label={`${label}，${duration}`}
        href={`/series/${encodeURIComponent(id)}/play/${encodeURIComponent(episode.id)}`}>
        <span className="episode-name">{label}</span><span className="episode-duration">{duration}</span>
      </a> : <div className="episode-card is-unavailable">
        <span className="episode-name">{label}（暂无可播放视频）</span><span className="episode-duration">{duration}</span>
      </div>}
    </li>;
  })}
</ol>
```

- [ ] **步骤 4：实现响应式网格样式**

```css
.episode-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; list-style: none; margin: 0; padding: 0; }
.episode-card { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 12px 14px; border: 1px solid var(--mh-color-border); border-radius: 10px; background: var(--mh-color-surface-hover); }
.episode-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
.episode-duration { flex: none; color: var(--mh-color-text-muted); font-size: .85rem; }
.episode-card.is-unavailable { opacity: .55; }
@media (max-width: 620px) { .episode-list { grid-template-columns: 1fr; } }
```

- [ ] **步骤 5：验证并提交**

```bash
npm test --workspace @movie-harbor/public-web -- src/details/Details.test.tsx
npm run build --workspace @movie-harbor/public-web
git add frontend/public-web/src/details frontend/public-web/src/styles.css frontend/public-web/src/test/fixtures.ts
git commit -m "feat: 使用双列卡片展示剧集单集"
```

预期：详情页测试和构建通过。

### 任务 4：让相邻导航显示目标单集名称

**文件：**
- 修改：`frontend/public-web/src/player/PlayerPage.tsx`
- 修改：`frontend/public-web/src/player/PlayerPage.test.tsx`
- 修改：`frontend/public-web/src/styles.css`

- [ ] **步骤 1：编写失败的导航测试**

```tsx
expect(screen.getByRole("button", { name: "上一集：第 1 集 · 启程" })).toBeEnabled();
expect(screen.getByRole("button", { name: "下一集" })).toBeDisabled();
await user.click(screen.getByRole("button", { name: "上一集：第 1 集 · 启程" }));
expect(screen.getByRole("button", { name: "上一集" })).toBeDisabled();
expect(screen.getByRole("button", { name: "下一集：第 3 集 · 灯塔" })).toBeEnabled();
```

- [ ] **步骤 2：运行测试确认失败**

```bash
npm test --workspace @movie-harbor/public-web -- src/player/PlayerPage.test.tsx
```

预期：按钮名称仍只有“上一集”和“下一集”。

- [ ] **步骤 3：实现相邻目标标签**

```tsx
const previous = currentIndex > 0 ? episodes[currentIndex - 1] : undefined;
const next = currentIndex < episodes.length - 1 ? episodes[currentIndex + 1] : undefined;
const navigationLabel = (direction: "上一集" | "下一集", episode?: OrderedEpisode) =>
  episode ? `${direction}：第 ${episode.number} 集 · ${episode.name}` : direction;
```

按钮使用 `disabled={!previous}` / `disabled={!next}`，点击时只在目标存在时调用 `choose`，可见文字直接使用 `navigationLabel`。

- [ ] **步骤 4：支持长名称换行并验证**

```css
.episode-navigation .pill { white-space: normal; text-align: left; }
```

```bash
npm test --workspace @movie-harbor/public-web -- src/player/PlayerPage.test.tsx
npm test --workspace @movie-harbor/public-web
npm test --workspace @movie-harbor/admin-web
npm run build --workspaces
```

预期：全部通过，首尾边界按钮保持禁用。

- [ ] **步骤 5：运行仓库级验证**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
npm test --workspaces
npm run build --workspaces
git diff --check
```

预期：所有命令退出码为 0。

- [ ] **步骤 6：提交**

```bash
git add frontend/public-web/src/player frontend/public-web/src/styles.css
git commit -m "feat: 在相邻单集导航显示名称"
```
