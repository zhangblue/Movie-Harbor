# 导出年份与题材实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在管理员全量内容 JSON 导出中，为电影和剧集增加 `year` 与按系统顺序排列的题材名称数组，同时保持单集字段、快照一致性和现有下载行为不变。

**架构：** 扩展后端导出 DTO，并在既有只读、可重复读事务内批量读取电影题材和剧集题材关联；按内容 ID 组装名称数组，避免逐条详情查询。端到端测试通过现有管理 API 设置年份与题材，再从真实浏览器下载文件验证精确结构。

**技术栈：** Rust、Axum 0.8、SeaORM 1.1、PostgreSQL、TypeScript、Playwright。

---

## 文件结构

- 修改 `backend/src/admin_export/dto.rs`：为电影和剧集导出 DTO 增加年份与题材名称数组。
- 修改 `backend/src/admin_export/query.rs`：在同一事务内批量查询并稳定组装电影、剧集题材。
- 修改 `backend/tests/admin_export_test.rs`：覆盖精确字段、空值、题材排序和包含题材的事务快照。
- 修改 `tests/e2e/helpers.ts`：允许测试数据辅助函数设置年份与题材。
- 修改 `tests/e2e/export.spec.ts`：通过真实下载验收年份、题材顺序、空值及单集字段边界。
- 修改 `README.md`、`AGENTS.md`：同步用户说明和长期工程约束。

### 任务 1：后端导出年份、题材与一致快照

**文件：**
- 修改：`backend/src/admin_export/dto.rs`
- 修改：`backend/src/admin_export/query.rs`
- 测试：`backend/tests/admin_export_test.rs`

- [ ] **步骤 1：编写失败的精确导出契约测试**

扩展 `seed`：电影和剧集写入有值与空值年份，并使用现有种子题材建立关联。关联插入顺序故意与 `genre.sort_order` 相反：

```sql
UPDATE genre SET enabled = false
WHERE id = '00000000-0000-0000-0001-000000000004';
INSERT INTO movie_genre (movie_id, genre_id) VALUES
('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000004'),
('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000001');
INSERT INTO series_genre (series_id, genre_id) VALUES
('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0001-000000000006');
```

电影夹具至少包含 `year = 2024`，剧集夹具至少包含 `year = 2023`；其他内容保留 `NULL` 和无题材。更新精确 JSON 断言：

```rust
{"name":"Alpha","synopsis":"draft movie","year":2024,"genres":["剧情","科幻"],"poster_path":"/media/poster/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png","video_path":"/media/video/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.mp4","duration_seconds":123}
```

```rust
{"name":"Alpha","synopsis":"draft series","year":2023,"genres":["悬疑"],"poster_path":"/media/poster/cc/cccccccccccccccccccccccccccccccc.jpg","episodes":[
  {"season_number":1,"episode_number":1,"name":"First","video_path":"/media/video/dd/dddddddddddddddddddddddddddddddd.webm","duration_seconds":45},
  {"season_number":1,"episode_number":2,"name":"Second","video_path":null,"duration_seconds":null},
  {"season_number":2,"episode_number":1,"name":"Season two","video_path":null,"duration_seconds":null}
]}
```

所有缺失值对象精确断言 `"year": null`、`"genres": []`；单集继续使用现有精确对象，确保没有 `year` 或 `genres`。

- [ ] **步骤 2：强化快照回归并确认 RED**

将锁等待帮助函数参数化为关系名：

```rust
async fn wait_for_locked_query(db: &DatabaseConnection, relation: &str) -> bool {
    for _ in 0..300 {
        let row = db
            .query_one(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                r#"
SELECT EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN pg_locks lock ON lock.pid = activity.pid
    WHERE activity.wait_event_type = 'Lock'
      AND lock.locktype = 'relation' AND NOT lock.granted
      AND lock.relation = to_regclass($1)::oid
) AS blocked
"#,
                [relation.into()],
            ))
            .await
            .unwrap()
            .unwrap();
        if row.try_get::<bool>("", "blocked").unwrap() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    false
}
```

快照测试改为锁定导出即将读取的 `movie_genre`：

```rust
blocker
    .execute_unprepared("LOCK TABLE movie_genre IN ACCESS EXCLUSIVE MODE")
    .await
    .unwrap();
```

确认导出已读取父内容并阻塞后，在锁事务内同时更新电影年份、题材名称、简介、单集名称和媒体键。旧响应断言 `year == 2024`、`genres == ["剧情", "科幻"]` 以及旧媒体数据；新请求断言新年份、重命名后的题材和新媒体数据。

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' \
  cargo test -p movie-harbor-api --test admin_export_test -- --nocapture
```

预期：精确 JSON 缺少 `year`、`genres` 而失败；快照测试因生产查询尚未访问 `movie_genre`，无法观察到锁等待而失败。

- [ ] **步骤 3：扩展具体导出 DTO**

在电影和剧集结构中加入字段；不修改 `ExportEpisode`：

```rust
pub struct ExportMovie {
    pub name: String,
    pub synopsis: String,
    pub year: Option<i32>,
    pub genres: Vec<String>,
    pub poster_path: Option<String>,
    pub video_path: Option<String>,
    pub duration_seconds: Option<i32>,
}

pub struct ExportSeries {
    pub name: String,
    pub synopsis: String,
    pub year: Option<i32>,
    pub genres: Vec<String>,
    pub poster_path: Option<String>,
    pub episodes: Vec<ExportEpisode>,
}
```

- [ ] **步骤 4：在现有事务中批量读取题材**

为父内容行保留 ID 并读取年份：

```rust
struct MovieRow {
    id: Uuid,
    name: String,
    synopsis: String,
    year: Option<i32>,
    poster_asset_id: Option<Uuid>,
    video_asset_id: Option<Uuid>,
    duration_seconds: Option<i32>,
}

struct SeriesRow {
    id: Uuid,
    name: String,
    synopsis: String,
    year: Option<i32>,
    poster_asset_id: Option<Uuid>,
}

#[derive(FromQueryResult)]
struct GenreRow {
    content_id: Uuid,
    name: String,
}
```

父内容 SQL 精确增加 ID 和年份列，排序保持不变：

```sql
SELECT movie.id, movie.name, movie.synopsis, movie.year,
       movie.poster_asset_id, movie.video_asset_id, movie.duration_seconds
FROM movie
ORDER BY movie.name ASC, movie.id ASC
```

```sql
SELECT series.id, series.name, series.synopsis, series.year, series.poster_asset_id
FROM series
ORDER BY series.name ASC, series.id ASC
```

在同一个 `RepeatableRead`、`ReadOnly` 事务中执行两次批量查询：

```sql
SELECT movie_genre.movie_id AS content_id, genre.name
FROM movie_genre
JOIN genre ON genre.id = movie_genre.genre_id
ORDER BY movie_genre.movie_id ASC, genre.sort_order ASC, genre.id ASC
```

```sql
SELECT series_genre.series_id AS content_id, genre.name
FROM series_genre
JOIN genre ON genre.id = series_genre.genre_id
ORDER BY series_genre.series_id ASC, genre.sort_order ASC, genre.id ASC
```

用一个本模块私有函数组装映射：

```rust
fn group_genres(rows: Vec<GenreRow>) -> HashMap<Uuid, Vec<String>> {
    let mut grouped: HashMap<Uuid, Vec<String>> = HashMap::new();
    for row in rows {
        grouped.entry(row.content_id).or_insert_with(Vec::new).push(row.name);
    }
    grouped
}
```

构造 `ExportMovie`、`ExportSeries` 时分别写入 `row.year` 和 `genres.remove(&row.id).unwrap_or_default()`。查询不按 `genre.enabled` 过滤：步骤 1 中已停用但仍有关联的“科幻”必须继续出现在结果中。所有题材读取必须发生在现有事务提交之前。

- [ ] **步骤 5：确认 GREEN 并验证事务敏感性**

运行步骤 2 的聚焦测试，预期全部通过。随后临时把导出事务隔离级别改为 `ReadCommitted`，只运行快照测试：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' \
  cargo test -p movie-harbor-api --test admin_export_test export_content_genres_and_media_share_one_snapshot -- --nocapture
```

预期：测试失败，并观察到并发年份、题材或媒体数据混入旧父内容。立即恢复 `RepeatableRead`，重跑完整 `admin_export_test` 并确认通过；临时变异不得进入提交。

- [ ] **步骤 6：静态检查并提交**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
git diff --check
git add backend/src/admin_export/dto.rs backend/src/admin_export/query.rs backend/tests/admin_export_test.rs
git commit -m "feat: export content year and genres"
```

### 任务 2：端到端验收与文档同步

**文件：**
- 修改：`tests/e2e/helpers.ts`
- 修改：`tests/e2e/export.spec.ts`
- 修改：`README.md`
- 修改：`AGENTS.md`

- [ ] **步骤 1：扩展 E2E 测试数据辅助函数**

增加测试专用题材类型：

```ts
export type Genre = { id: string; name: string; sort_order: number; enabled: boolean };
```

为电影辅助函数增加可选字段，同时保留既有调用的默认行为：

```ts
options: {
  synopsis: string;
  durationSeconds: number;
  includePoster?: boolean;
  year?: number | null;
  genreIds?: string[];
}
```

电影 PATCH 使用 `year: options.year === undefined ? 2026 : options.year` 和 `genre_ids: options.genreIds ?? []`，从而保留显式 `null`。为剧集辅助函数增加同名 `year`、`genreIds` 可选字段，并在既有剧集 PATCH 中写入 `year: options.year ?? null`、`genre_ids: options.genreIds ?? []`。

- [ ] **步骤 2：扩展真实下载验收**

更新导出测试类型：

```ts
type ExportMovie = {
  name: string; synopsis: string; year: number | null; genres: string[];
  poster_path: string | null; video_path: string | null; duration_seconds: number | null;
};
type ExportSeries = {
  name: string; synopsis: string; year: number | null; genres: string[];
  poster_path: string | null; episodes: ExportEpisode[];
};
```

登录后读取 `/api/admin/genres`，选取按系统顺序返回的前两个启用题材。创建主电影时传入 `year: 2024`，并故意逆序传入两个题材 ID；创建主剧集时传入 `year: 2023` 和其中一个题材 ID。下载后断言：

```ts
expect(exportedMovie.year).toBe(2024);
expect(exportedMovie.genres).toEqual([firstGenre.name, secondGenre.name]);
expect(exportedSeries.year).toBe(2023);
expect(exportedSeries.genres).toEqual([secondGenre.name]);
```

现有精确对象断言全部补上 `year`、`genres`。21 个空电影和空剧集必须断言 `year: null`、`genres: []`；单集仍用精确对象断言，确保不出现这两个字段。

- [ ] **步骤 3：运行跨服务验收**

```bash
npm run test:e2e
```

预期：主流程 7 项与重启持久化 1 项全部通过，`export` 项目未跳过；runner 使用唯一 Compose 项目和带所有权标记的数据目录并完成清理。

- [ ] **步骤 4：同步文档约束**

在 README 的“管理媒体路径与内容导出”中明确：电影和剧集导出年份及题材名称数组，缺少年份为 `null`，无题材为 `[]`，单集不重复这些字段。

在 AGENTS 的内容与界面文档列表中加入本计划路径，并在导出领域约束中补充：`year` 只在电影、剧集层级导出；`genres` 只含按 `sort_order`、ID 稳定排序的题材名称；不得给单集复制父级年份或题材。

- [ ] **步骤 5：运行完整验证**

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

预期：所有命令退出码为 0；后端精确 JSON、快照测试和 E2E 均覆盖新字段。

- [ ] **步骤 6：提交并请求最终审查**

```bash
git add tests/e2e/helpers.ts tests/e2e/export.spec.ts README.md AGENTS.md
git commit -m "test: verify exported year and genres"
```

使用 superpowers:requesting-code-review 对照已确认设计审查：字段层级、题材稳定顺序、空值、停用题材、同一事务快照、无 N+1 查询、单集字段边界和文档准确性。处理反馈后重新运行步骤 5。
