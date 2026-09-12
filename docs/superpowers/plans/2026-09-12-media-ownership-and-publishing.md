# 媒体独占归属与发布体验实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将媒体改为内容槽位独占，在删除和替换请求中同步处理物理文件，移除周期清理，并允许电影和剧集使用无文字的空白海报发布。

**架构：** 存储层提供带持久化清单的暂存、恢复、确认删除协议；电影、剧集和上传服务在业务锁及数据库事务内协调该协议。数据库迁移拒绝共享引用和未完成旧清理任务，随后用约束触发器保持独占不变量；启动阶段只恢复中断操作，不再运行周期 worker。

**技术栈：** Rust、Axum、SeaORM、PostgreSQL、Tokio、rustix、本地文件系统、React、TypeScript、Vitest、Playwright、Docker Compose。

---

## 执行顺序

先执行 `2026-09-12-series-episode-ux-revision.md`，使本计划使用迁移编号 `m20260912_000005_media_ownership.rs`。如果独立执行本计划，先检查迁移列表并使用下一个未占用编号，随后同步修正本文命令中的迁移计数。

## 文件结构

- 创建 `backend/src/media/removal.rs`：同步暂存、恢复、确认删除和启动恢复协议。
- 创建 `backend/tests/media_removal_test.rs`：存储协议、路径安全和中断恢复测试。
- 修改 `backend/src/media/storage.rs`、`backend/src/media/mod.rs`：暴露最小存储原语和稳定错误码。
- 修改 `backend/src/movies/service.rs`、`backend/src/series/service.rs`：电影、剧集、季、单集同步删除。
- 修改 `backend/src/media/upload.rs`：媒体替换同步删除旧文件。
- 创建 `backend/migration/src/m20260912_000005_media_ownership.rs`：拒绝旧共享/待清理数据、删除清理表、添加独占约束。
- 修改 `backend/migration/src/lib.rs`、`backend/tests/migration_test.rs`：注册和验证迁移。
- 删除 `backend/src/media/cleanup.rs`、`backend/src/media/references.rs`、`backend/src/entities/file_cleanup_job.rs`：移除周期清理实现。
- 修改 `backend/src/entities/mod.rs`、`backend/src/app.rs`：只执行一次上传和删除恢复。
- 修改 `backend/src/movies/routes.rs`、`backend/src/movies/dto.rs`：移除任意媒体关联接口，简化删除响应。
- 修改 `backend/tests/movies_test.rs`、`backend/tests/series_test.rs`、`backend/tests/media_upload_test.rs`：覆盖同步删除和替换；删除旧清理 worker 专用测试。
- 修改 `frontend/packages/api-client/src/types.ts`、`frontend/packages/api-client/src/admin.ts`、`frontend/packages/api-client/src/admin.test.ts`：更新删除影响和错误契约。
- 修改 `frontend/admin-web/src/movies/MovieEditor.tsx`、`frontend/admin-web/src/series/SeriesEditor.tsx` 及测试：中文反馈和媒体总数。
- 修改 `frontend/admin-web/src/movies/PublishErrors.tsx`、`frontend/admin-web/src/series/SeriesPublishErrors.tsx`：海报可选和明确剧集提示。
- 修改 `frontend/packages/ui/src/PosterCard.tsx` 及测试、`frontend/public-web/src/details/DetailsLayout.tsx` 及测试、相关样式：纯色空白海报。
- 修改 `tests/e2e/admin.spec.ts`、`tests/e2e/series.spec.ts`：验证宿主机文件同步消失和发布提示。

### 任务 1：建立可恢复的同步文件暂存协议

**文件：**
- 创建：`backend/src/media/removal.rs`
- 创建：`backend/tests/media_removal_test.rs`
- 修改：`backend/src/media/storage.rs`
- 修改：`backend/src/media/mod.rs`

- [ ] **步骤 1：编写失败的暂存、恢复和确认删除测试**

测试公开接口应表达三种结果：暂存后公开路径不存在、恢复后重新出现、确认后隔离副本不存在。

```rust
#[tokio::test]
async fn staged_removal_can_restore_or_finish_owned_files() {
    let (storage, root) = storage_fixture().await;
    let asset = registered_file(&storage, &root, "video/aa/asset.mp4", b"video").await;

    let staged = removal::stage(&storage, "delete-movie", &[asset.clone()]).await.unwrap();
    assert!(!root.join(&asset.storage_key).exists());
    staged.restore().await.unwrap();
    assert_eq!(tokio::fs::read(root.join(&asset.storage_key)).await.unwrap(), b"video");

    let staged = removal::stage(&storage, "delete-movie", &[asset]).await.unwrap();
    staged.finish().await.unwrap();
    assert!(operation_directories(&root).await.is_empty());
}
```

再用存储 hook 在第二个文件移动时注入错误，断言第一个文件已经恢复且操作目录为空。

- [ ] **步骤 2：编写失败的路径安全和幂等测试**

```rust
#[tokio::test]
async fn stage_rejects_non_regular_or_escaped_paths_before_moving_any_file() {
    let (storage, root) = storage_fixture().await;
    let good = registered_file(&storage, &root, "poster/aa/good.png", b"png").await;
    let bad = owned_asset("../outside", MediaKind::Video);
    assert!(matches!(removal::stage(&storage, "delete-series", &[good.clone(), bad]).await,
        Err(MediaError::InvalidStorageKey)));
    assert!(root.join(good.storage_key).exists());
}
```

文件不存在的资产应成功进入空操作并可 `finish()`。

- [ ] **步骤 3：运行测试确认失败**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test media_removal_test -- --nocapture
```

预期：`media::removal` 和暂存接口尚不存在，编译失败。

- [ ] **步骤 4：实现小而明确的协议类型**

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OwnedMedia {
    pub asset_id: Uuid,
    pub storage_key: String,
}

pub struct StagedRemoval {
    storage: LocalMediaStorage,
    operation_id: Uuid,
    entries: Vec<ManifestEntry>,
}

impl StagedRemoval {
    pub async fn restore(self) -> Result<(), MediaError> { /* reverse-order rename and fsync */ }
    pub async fn finish(self) -> Result<(), MediaError> { /* remove quarantined regular files and manifest */ }
}
```

`stage` 必须先验证全部受控键和普通文件，再创建 `.operations/<uuid>/manifest.json`，持久化清单后按顺序原子重命名；任何失败按逆序恢复。所有目录变更都复用 `storage.rs` 的 capability、`openat`/`renameat` 和 fsync 边界，不使用拼接后的任意绝对路径。

- [ ] **步骤 5：运行专用测试确认通过**

```bash
cargo fmt --all -- --check
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test media_removal_test -- --nocapture
```

预期：暂存、恢复、确认、缺失文件和路径安全测试全部通过。

- [ ] **步骤 6：提交**

```bash
git add backend/src/media/removal.rs backend/src/media/storage.rs backend/src/media/mod.rs backend/tests/media_removal_test.rs
git commit -m "feat: 添加可恢复的同步媒体删除协议"
```

### 任务 2：让电影和内容树删除同步处理媒体

**文件：**
- 修改：`backend/src/movies/dto.rs`
- 修改：`backend/src/movies/service.rs`
- 修改：`backend/src/series/dto.rs`
- 修改：`backend/src/series/service.rs`
- 测试：`backend/tests/movies_test.rs`
- 测试：`backend/tests/series_test.rs`

- [ ] **步骤 1：把现有删除测试改为同步契约**

电影、剧集、季和单集测试的成功响应统一断言：

```rust
assert_eq!(body(response).await, json!({"deleted_media_count": expected_count}));
assert!(media_asset::Entity::find_by_id(asset.id).one(&db).await.unwrap().is_none());
assert!(!root.as_ref().join(&asset.storage_key).exists());
```

删除影响响应改为单一字段：

```rust
assert_eq!(impact["media_count"], 3);
assert!(impact.get("exclusive_media_count").is_none());
assert!(impact.get("shared_media_count").is_none());
```

- [ ] **步骤 2：新增失败时保留内容的测试**

使用 `StorageHooks` 在暂存阶段返回权限错误：

```rust
let response = delete_movie_with_failing_storage(&app, id, version).await;
assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
assert_eq!(body(response).await["code"], "media_delete_failed");
assert!(movie::Entity::find_by_id(id).one(&db).await.unwrap().is_some());
assert!(root.as_ref().join(&video.storage_key).exists());
```

为包含多个单集视频的季和剧集重复该断言，保证部分暂存失败时已移动文件被恢复。

- [ ] **步骤 3：运行测试确认失败**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test movies_test delete -- --nocapture
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test series_test delete -- --nocapture
```

预期：响应仍返回清理队列字段，错误时内容不会遵循新暂存协议。

- [ ] **步骤 4：简化 DTO 并协调事务**

```rust
#[derive(Debug, Serialize)]
pub struct DeleteResultResponse { pub deleted_media_count: u64 }

#[derive(Debug, Serialize)]
pub struct DeleteImpactResponse {
    pub name: String,
    pub version: i64,
    pub season_count: u64,
    pub episode_count: u64,
    pub media_count: u64,
}
```

每个删除服务按相同模板执行：

```rust
let tx = db.begin().await?;
let owned = collect_owned_media_locked(&tx, target).await?;
let staged = removal::stage(storage, "delete-series", &owned).await?;
if let Err(error) = delete_records_and_assets(&tx, target, &owned).await {
    tx.rollback().await.ok();
    staged.restore().await?;
    return Err(error.into());
}
if let Err(error) = tx.commit().await {
    staged.restore().await?;
    return Err(error.into());
}
staged.finish().await?;
Ok(DeleteResultResponse { deleted_media_count: owned.len() as u64 })
```

保持既有内容锁顺序 `series -> season -> episode` 和版本/发布状态校验。

- [ ] **步骤 5：验证四种删除并提交**

```bash
cargo fmt --all -- --check
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test movies_test -- --nocapture
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test series_test -- --nocapture
git add backend/src/movies backend/src/series backend/tests/movies_test.rs backend/tests/series_test.rs
git commit -m "feat: 同步删除内容及其媒体文件"
```

预期：电影、剧集、季和单集成功及失败路径全部通过。

### 任务 3：让媒体替换同步删除旧文件

**文件：**
- 修改：`backend/src/media/upload.rs`
- 修改：`backend/tests/media_upload_test.rs`

- [ ] **步骤 1：编写旧文件同步消失的失败测试**

为电影海报、电影视频、剧集海报和单集视频各保留一个表驱动用例：

```rust
assert_eq!(upload.status(), StatusCode::OK);
assert!(!root.as_ref().join(&old.storage_key).exists());
assert!(media_asset::Entity::find_by_id(old.id).one(&db).await.unwrap().is_none());
assert!(file_cleanup_job::Entity::find().count(&db).await.unwrap() == 0);
```

再注入旧文件暂存失败，断言上传响应包含 `media_replace_failed`，旧引用和旧文件不变，新文件及其媒体记录不存在。

- [ ] **步骤 2：运行测试确认失败**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test media_upload_test replace -- --nocapture
```

预期：旧文件仍通过 `file_cleanup_job` 处理，失败契约不匹配。

- [ ] **步骤 3：在上传提交边界集成暂存协议**

`replace_before_commit` 返回新资产、版本和可选 `StagedRemoval`。切换引用前暂存旧文件；数据库提交失败时恢复旧文件并由 `StoredFile` 清理未注册的新文件；提交成功时同步 `finish()`。不再调用 `queue_locked_if_unreferenced`。

```rust
let staged = match old_asset {
    Some(asset) => Some(removal::stage(storage, "replace-media", &[asset.into()]).await?),
    None => None,
};
let committed = switch_reference(&tx, target, new_asset.id, expected_version).await?;
if let Err(error) = tx.commit().await {
    if let Some(staged) = staged { staged.restore().await?; }
    return Err(error.into());
}
if let Some(staged) = staged { staged.finish().await?; }
```

错误响应使用稳定代码：

```json
{"error":"media replacement failed","code":"media_replace_failed"}
```

- [ ] **步骤 4：验证替换和上传回归**

```bash
cargo fmt --all -- --check
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test media_upload_test -- --nocapture
```

预期：四个槽位替换后旧文件同步消失，失败时旧内容完整保留。

- [ ] **步骤 5：提交**

```bash
git add backend/src/media/upload.rs backend/tests/media_upload_test.rs
git commit -m "feat: 同步清理被替换的媒体文件"
```

### 任务 4：强制独占归属并移除周期清理

**文件：**
- 创建：`backend/migration/src/m20260912_000005_media_ownership.rs`
- 修改：`backend/migration/src/lib.rs`
- 修改：`backend/tests/migration_test.rs`
- 修改：`backend/src/app.rs`
- 修改：`backend/src/media/mod.rs`
- 修改：`backend/src/media/routes.rs`
- 修改：`backend/src/movies/routes.rs`
- 修改：`backend/src/movies/service.rs`
- 修改：`backend/src/movies/dto.rs`
- 修改：`backend/src/entities/mod.rs`
- 删除：`backend/src/media/cleanup.rs`
- 删除：`backend/src/media/references.rs`
- 删除：`backend/src/entities/file_cleanup_job.rs`
- 删除：`backend/tests/media_cleanup_test.rs`
- 测试：`backend/tests/media_removal_test.rs`

- [ ] **步骤 1：编写迁移拒绝异常旧数据的测试**

分别准备含共享媒体和含待清理任务的 v4 schema，断言升级到 v5 失败；清理异常数据后升级成功，并断言 `file_cleanup_job` 不存在、重复引用被数据库约束拒绝。

```rust
let error = migration::Migrator::up(&db, None).await.unwrap_err();
assert!(error.to_string().contains("shared media assets must be resolved"));
```

- [ ] **步骤 2：编写启动恢复测试**

在 `media_removal_test.rs` 写出两份操作清单：仍有数据库引用的文件应恢复；引用已删除的文件应从隔离目录清除。调用一次 `removal::recover(&db, &storage)` 后断言结果，再调用一次验证幂等。

```rust
removal::recover(&db, &storage).await.unwrap();
assert!(root.join(referenced.storage_key).exists());
assert!(!root.join(".operations/committed-delete").exists());
removal::recover(&db, &storage).await.unwrap();
```

- [ ] **步骤 3：运行测试确认失败**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test migration_test -- --nocapture
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test media_removal_test recover -- --nocapture
```

预期：v5 迁移和删除恢复尚不存在。

- [ ] **步骤 4：实现迁移和数据库独占约束**

迁移 `up` 依次执行：

```sql
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM file_cleanup_job) THEN
    RAISE EXCEPTION 'pending media cleanup jobs must be resolved';
  END IF;
  IF EXISTS (
    SELECT media_asset_id FROM (
      SELECT poster_asset_id AS media_asset_id FROM movie WHERE poster_asset_id IS NOT NULL
      UNION ALL SELECT video_asset_id FROM movie WHERE video_asset_id IS NOT NULL
      UNION ALL SELECT poster_asset_id FROM series WHERE poster_asset_id IS NOT NULL
      UNION ALL SELECT video_asset_id FROM episode WHERE video_asset_id IS NOT NULL
    ) refs GROUP BY media_asset_id HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'shared media assets must be resolved';
  END IF;
END $$;
DROP TABLE file_cleanup_job;
```

随后创建约束触发器函数，在 movie/series/episode 的媒体 FK 插入或更新时查询其他三个槽位；发现任何既有引用则以 `23505` 拒绝。`down` 恢复清理表和删除触发器，但不恢复任意媒体关联 API。

- [ ] **步骤 5：移除关联接口和周期 worker**

删除 `PUT /api/admin/movies/{id}/poster|video`、`AssociateMediaRequest`、`associate_media` 和共享前端 `associateMovieMedia`。从 `app.rs` 删除 `cleanup::spawn`，改为启动时各调用一次：

```rust
crate::media::upload::recover_stale_uploads(&db, &storage, Duration::from_secs(3600)).await?;
crate::media::removal::recover(&db, &storage).await?;
```

删除旧清理模块、实体和只服务共享引用的代码；把仍适用于启动恢复的用例迁入 `media_removal_test.rs` 后删除 `media_cleanup_test.rs`。

- [ ] **步骤 6：验证迁移、启动和路由**

```bash
cargo fmt --all -- --check
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test migration_test -- --nocapture
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test media_removal_test -- --nocapture
```

预期：迁移和启动恢复通过；旧关联路由返回 404；不存在周期任务测试依赖。

- [ ] **步骤 7：提交**

```bash
git add -A backend/migration/src backend/tests/migration_test.rs backend/tests/media_removal_test.rs backend/tests/media_cleanup_test.rs backend/src/app.rs backend/src/media backend/src/entities backend/src/movies
git commit -m "refactor: 强制媒体独占并移除周期清理"
```

### 任务 5：允许空白海报并提供明确的剧集发布提示

**文件：**
- 修改：`backend/src/movies/service.rs`
- 修改：`backend/src/series/service.rs`
- 测试：`backend/tests/movies_test.rs`
- 测试：`backend/tests/series_test.rs`
- 修改：`frontend/admin-web/src/movies/PublishErrors.tsx`
- 修改：`frontend/admin-web/src/movies/PosterPicker.tsx`
- 测试：`frontend/admin-web/src/movies/MovieEditor.test.tsx`
- 修改：`frontend/admin-web/src/series/SeriesPublishErrors.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.test.tsx`
- 修改：`frontend/packages/ui/src/PosterCard.tsx`
- 测试：`frontend/packages/ui/src/PosterCard.test.tsx`
- 修改：`frontend/public-web/src/details/DetailsLayout.tsx`
- 修改：`frontend/public-web/src/details/Details.test.tsx`
- 修改：`frontend/public-web/src/styles.css`

- [ ] **步骤 1：编写失败的发布校验测试**

后端测试创建无海报电影并通过上传接口保存视频，发布应成功；创建无海报剧集并上传、发布一个可播放单集，随后发布剧集应成功。无已发布单集时仍断言：

```rust
assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
assert_eq!(body(response).await["fields"], json!(["episodes"]));
```

- [ ] **步骤 2：编写失败的中文提示和空白占位测试**

```tsx
const alert = await screen.findByRole("alert");
expect(alert).toHaveTextContent(
  "发布剧集失败：当前剧集没有已发布的单集。请先为单集上传可播放视频并发布至少一集，然后再发布整个剧集。",
);
expect(alert).not.toHaveTextContent("海报");
```

`PosterCard.test.tsx` 和 `Details.test.tsx` 对缺失及加载失败海报断言纯色元素存在，但没有 `MH`、“海报不可用”或图片角色。

- [ ] **步骤 3：运行测试确认失败**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test movies_test publish -- --nocapture
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test series_test publish -- --nocapture
npm test --workspace @movie-harbor/admin-web -- src/series/SeriesEditor.test.tsx
npm test --workspace @movie-harbor/ui -- src/PosterCard.test.tsx
npm test --workspace @movie-harbor/public-web -- src/details/Details.test.tsx
```

预期：后端仍要求海报，前端仍显示通用字段列表和文字占位。

- [ ] **步骤 4：移除海报发布要求**

从 `validate_publish` 和 `validate_series_publish` 删除 poster asset 检查；名称、电影视频、单集视频和至少一个已发布单集规则保持不变。

```rust
if model.name.trim().is_empty() { missing.push("name"); }
// Movie keeps the video check. Series keeps the published/playable episode scan.
```

- [ ] **步骤 5：实现中文提示与无文字占位**

`SeriesPublishErrors` 对 `episodes` 输出固定完整句子；其他字段继续列表展示。`PublishErrors` 不再包含 `poster` 映射。`PosterCard` 和 `DetailsLayout` 的回退节点改为：

```tsx
<div className="poster-blank" aria-hidden="true" />
```

保留固定比例和背景色；图片加载失败后切换到同一节点。管理后台 `PosterPicker` 的空状态也不写文字。

- [ ] **步骤 6：验证并提交**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test movies_test -- --nocapture
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test series_test -- --nocapture
npm test --workspace @movie-harbor/ui
npm test --workspace @movie-harbor/admin-web -- src/series/SeriesEditor.test.tsx
npm test --workspace @movie-harbor/public-web -- src/details/Details.test.tsx
git add backend/src/movies/service.rs backend/src/series/service.rs backend/tests/movies_test.rs backend/tests/series_test.rs frontend/admin-web/src/movies/PublishErrors.tsx frontend/admin-web/src/movies/PosterPicker.tsx frontend/admin-web/src/movies/MovieEditor.test.tsx frontend/admin-web/src/series/SeriesPublishErrors.tsx frontend/admin-web/src/series/SeriesEditor.test.tsx frontend/packages/ui/src frontend/public-web/src/details frontend/public-web/src/styles.css
git commit -m "feat: 允许空白海报并明确剧集发布提示"
```

预期：所有目标测试通过。

### 任务 6：更新管理后台同步删除反馈

**文件：**
- 修改：`frontend/packages/api-client/src/types.ts`
- 修改：`frontend/packages/api-client/src/admin.ts`
- 修改：`frontend/packages/api-client/src/admin.test.ts`
- 修改：`frontend/admin-web/src/movies/MovieEditor.tsx`
- 修改：`frontend/admin-web/src/movies/MovieEditor.test.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.test.tsx`
- 修改：`frontend/admin-web/src/app/App.tsx`
- 修改：`frontend/admin-web/src/app/App.test.tsx`

- [ ] **步骤 1：编写失败的契约与页面反馈测试**

共享类型目标：

```ts
export interface DeleteImpactResponse {
  name: string; version: number; season_count: number; episode_count: number; media_count: number;
}
export interface DeleteResultResponse { deleted_media_count: number }
```

页面测试断言确认框显示“媒体文件：2”，不显示“独占媒体”“共享媒体”或“自动重试”；同步删除失败响应：

```ts
json({ error: "media deletion failed", code: "media_delete_failed" }, 500)
```

必须显示“删除失败，内容和媒体文件已保留，请检查媒体目录权限后重试。”并保持对话框和表单数据。

- [ ] **步骤 2：运行测试确认失败**

```bash
npm test --workspace @movie-harbor/api-client -- src/admin.test.ts
npm test --workspace @movie-harbor/admin-web -- src/movies/MovieEditor.test.tsx src/series/SeriesEditor.test.tsx
```

预期：旧契约仍包含清理队列和共享计数，页面文案不匹配。

- [ ] **步骤 3：更新共享契约和稳定错误码识别**

删除 `AssociateMediaRequest`、`associateMovieMedia`、清理队列字段与共享计数。增加小型守卫：

```ts
export function apiErrorCode(error: ApiError): string | undefined {
  if (!error.details || typeof error.details !== "object") return undefined;
  const code = (error.details as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}
```

- [ ] **步骤 4：更新电影和剧集删除 UI**

确认框只显示 `media_count`；收到 `media_delete_failed` 或 `media_replace_failed` 时分别使用设计中的固定中文文案。为编辑器增加 `onDeleteSuccess` 回调，由 `App.tsx` 在返回内容列表后显示“内容及其媒体文件已删除”；删除季或单集时在当前剧集页显示相同状态提示并刷新。

```tsx
<li>媒体文件：{deleting.media_count}</li>
```

```ts
if (cause instanceof ApiError && apiErrorCode(cause) === "media_delete_failed") {
  setError("删除失败，内容和媒体文件已保留，请检查媒体目录权限后重试。");
}
```

- [ ] **步骤 5：验证并提交**

```bash
npm test --workspace @movie-harbor/api-client
npm test --workspace @movie-harbor/admin-web
npm run build --workspace @movie-harbor/admin-web
git add frontend/packages/api-client/src frontend/admin-web/src/movies frontend/admin-web/src/series frontend/admin-web/src/app
git commit -m "feat: 展示同步媒体删除中文反馈"
```

预期：契约、成功提示、失败提示和重复提交保护测试通过。

### 任务 7：端到端验证宿主机文件与最终回归

**文件：**
- 修改：`tests/e2e/admin.spec.ts`
- 修改：`tests/e2e/series.spec.ts`
- 修改：`tests/e2e/helpers.ts`
- 修改：`README.md`

- [ ] **步骤 1：编写失败的物理文件端到端测试**

在测试上传电影海报/视频、剧集海报和两个单集视频前后，由 `tests/e2e/helpers.ts` 快照测试媒体目录，通过新增文件集合确定本次上传的宿主机路径。分别删除单集、季、剧集和电影，并用 Node 文件检查断言对应路径在删除响应完成时已经不存在；不要为测试暴露生产存储键 API。

```ts
await expect.poll(async () => existsSync(join(mediaHostDir, storageKey))).toBe(false);
await expect(page.getByText("内容及其媒体文件已删除")).toBeVisible();
```

再覆盖无海报电影、无海报剧集发布成功，以及无已发布单集时完整中文提示。

- [ ] **步骤 2：运行端到端测试确认失败**

```bash
npm run test:e2e
```

预期：旧后台异步清理和旧发布提示导致新断言失败。

- [ ] **步骤 3：更新运维文档**

在 README 的媒体存储章节说明：媒体独占、删除与替换请求同步处理文件、无周期垃圾回收、启动只恢复中断操作；迁移前必须清空旧 `file_cleanup_job` 并处理共享引用。不要记录宿主机特定绝对路径。

- [ ] **步骤 4：运行全量验证**

```bash
docker compose -f docker-compose.test.yml up -d postgres
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
npm test --workspaces
npm run build --workspaces
npm run test:e2e
git diff --check
```

预期：全部命令退出码为 0；删除接口返回时对应宿主机文件已不存在；未启动周期清理任务。

- [ ] **步骤 5：提交**

```bash
git add tests/e2e/admin.spec.ts tests/e2e/series.spec.ts tests/e2e/helpers.ts README.md
git commit -m "test: 验证同步媒体删除发布流程"
```
