# Movie Harbor 多存储卷媒体实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Movie Harbor 在保持现有单目录数据不搬迁的前提下，为每个新上传媒体自动选择剩余可用空间最多的健康存储卷。

**架构：** 保留 `LocalMediaStorage` 作为单卷、目录描述符约束和原子文件操作边界，在其上新增 `MediaStorageSet` 负责卷定位、容量探测和上传预留。数据库用 `media_asset.storage_volume` 固化文件所属卷；部署工具把 `MEDIA_HOST_DIR` 的分号列表转换为多个 Compose bind mount，Caddy 通过带卷编号的受控 URL 提供文件。

**技术栈：** Rust 2024、Axum 0.8、SeaORM 1.1、PostgreSQL、Tokio、rustix `fstatvfs`、Docker Compose、Caddy、Node 内置测试。

**最终审查修订：** 容量与预留按已验证根 fd 的文件系统容量域共享，一次分配每域只采样一次，同域候选以小编号决胜；下文原逐卷伪代码由此约定覆盖。部署工具在 `.env` 所在目录以 fsync、原子 rename、目录 fsync 保存 `.movie-harbor-storage-state.json`，区分首次登记、普通重启和末尾追加；已有卷缺标记或路径替换/删除/重排、登记丢失/损坏必须先于持久写和 Docker 启动失败。首次卷 0 可含旧文件，新卷须为空且没有标记。`media-init` 仅将卷根设为 `10001:10001`/`0711`，内部目录仍为 `0700`，媒体权限不变；以真实 Linux named volume 和不同普通 UID 验证二次启动。

---

## 文件结构

- 创建 `backend/migration/src/m20260916_000006_media_storage_volume.rs`：为媒体资产增加卷编号并提供可逆迁移。
- 修改 `backend/migration/src/lib.rs`：注册新迁移。
- 修改 `backend/src/entities/media_asset.rs`：映射 `storage_volume`。
- 修改 `backend/src/config.rs`：解析内部 `MEDIA_DIRS` 和每卷保留空间。
- 创建 `backend/src/media/volumes.rs`：多卷集合、共享媒体变更锁、容量探测、确定性选择和并发预留。
- 修改 `backend/src/media/storage.rs`：暴露安全的卷容量查询与卷内操作能力，不承担跨卷策略。
- 修改 `backend/src/media/upload.rs`、`backend/src/media/routes.rs`：选择卷、流式上传并持久化卷编号。
- 修改 `backend/src/media/removal.rs`：按卷分组、共享媒体变更锁、跨卷隔离和启动恢复。
- 修改 `backend/src/media/mod.rs`、`backend/src/app.rs`：改用 `MediaStorageSet` 并增加结构化空间不足错误。
- 修改 `backend/src/catalog/{dto,query}.rs`、`backend/src/admin_content/query.rs`：查询卷编号并生成带卷的媒体 URL。
- 创建 `tools/storage-compose.mjs`：解析宿主机媒体路径列表并渲染 Compose 覆盖文件。
- 创建 `tools/start-compose.sh`：校验/初始化卷身份、生成覆盖文件并启动源码部署。
- 修改 `docker-compose.yml`、`.env.example`、`Caddyfile`、`.gitignore`：单卷默认、多卷覆盖、公开路由和本地生成文件边界。
- 创建 `tests/storage-compose.test.mjs`：锁定路径解析、卷身份和挂载生成契约。
- 修改 `tests/compose-storage.test.mjs`、`tests/e2e/{run.mjs,run-safety.mjs,helpers.ts,playback.spec.ts}`：覆盖单卷兼容与真实多卷流程。
- 修改 `backend/tests/{migration,media_upload,media_removal,movies,series,catalog,admin_content}_test.rs`：覆盖数据定位和跨卷一致性。
- 修改 `frontend/admin-web/src/content/editorSupport.ts` 及测试：本地化空间不足错误。
- 修改 `README.md`、`AGENTS.md`：记录配置、追加卷、备份和公共边界。

### 任务 1：卷配置与数据库定位

**文件：**
- 创建：`backend/migration/src/m20260916_000006_media_storage_volume.rs`
- 修改：`backend/migration/src/lib.rs`
- 修改：`backend/src/entities/media_asset.rs`
- 修改：`backend/src/config.rs`
- 测试：`backend/tests/migration_test.rs`
- 测试：`backend/src/config.rs`
- 测试：`backend/tests/{auth,genres,catalog,admin_content,movies,series,media_upload}_test.rs`

- [ ] **步骤 1：编写失败的迁移测试**

在 `backend/tests/migration_test.rs` 增加可逆迁移用例，先插入旧格式资产，再升级并断言默认卷为 `0`、负数被约束拒绝、回滚后字段消失：

```rust
Migrator::up(&db, Some(5)).await.unwrap();
sql(&db, "INSERT INTO media_asset (id, storage_key, original_name, mime_type, byte_size, purpose) VALUES ('10000000-0000-0000-0000-000000000061', 'video/06/60000000000000000000000000000001.mp4', 'old.mp4', 'video/mp4', 32, 'video')").await;
Migrator::up(&db, None).await.unwrap();
let row = db.query_one(Statement::from_string(DbBackend::Postgres,
    "SELECT storage_volume FROM media_asset WHERE id = '10000000-0000-0000-0000-000000000061'".into())).await.unwrap().unwrap();
assert_eq!(row.try_get::<i32>("", "storage_volume").unwrap(), 0);
assert!(sql_result(&db, "UPDATE media_asset SET storage_volume = -1").await.is_err());
```

- [ ] **步骤 2：运行迁移测试确认 RED**

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test migration_test media_storage_volume -- --nocapture
```

预期：FAIL，`storage_volume` 字段和第 6 个迁移尚不存在。

- [ ] **步骤 3：实现可逆迁移和 Entity 字段**

迁移 `up` 使用受约束非空默认值，保证已有资产不需要物理移动：

```sql
ALTER TABLE media_asset
ADD COLUMN storage_volume integer NOT NULL DEFAULT 0,
ADD CONSTRAINT media_asset_storage_volume_nonnegative CHECK (storage_volume >= 0);
```

`down` 先删除约束再删除列；在 `backend/src/entities/media_asset.rs` 的 `storage_key` 前增加：

```rust
pub storage_volume: i32,
```

- [ ] **步骤 4：编写失败的配置解析测试**

在 `backend/src/config.rs` 增加精确测试，覆盖一个目录、多个目录、空项、重复项、分号路径和非法保留值：

```rust
#[test]
fn media_dirs_are_ordered_nonempty_and_unique() {
    let config = config_with([
        ("MEDIA_DIRS", "/media/volumes/0;/media/volumes/1"),
        ("MEDIA_DISK_RESERVE_BYTES", "10737418240"),
    ]).unwrap();
    assert_eq!(config.media_dirs, vec![PathBuf::from("/media/volumes/0"), PathBuf::from("/media/volumes/1")]);
    assert_eq!(config.media_disk_reserve_bytes, 10 * 1024 * 1024 * 1024);
}
```

- [ ] **步骤 5：运行配置测试确认 RED**

运行：`cargo test -p movie-harbor-api config::tests::media_dirs -- --nocapture`

预期：FAIL，`Config` 仍只有 `media_dir`，且不读取 `MEDIA_DISK_RESERVE_BYTES`。

- [ ] **步骤 6：实现配置模型并修复测试 fixture 编译**

把 `Config::media_dir` 改为：

```rust
pub media_dirs: Vec<PathBuf>,
pub media_disk_reserve_bytes: u64,
```

新增私有解析器：

```rust
fn parse_media_dirs(value: &str) -> Result<Vec<PathBuf>, ConfigError> {
    let parts: Vec<_> = value.split(';').map(str::trim).collect();
    if parts.is_empty() || parts.iter().any(|part| part.is_empty()) {
        return Err(ConfigError::Invalid("MEDIA_DIRS"));
    }
    let paths: Vec<_> = parts.into_iter().map(PathBuf::from).collect();
    let unique: HashSet<_> = paths.iter().collect();
    (unique.len() == paths.len()).then_some(paths).ok_or(ConfigError::Invalid("MEDIA_DIRS"))
}
```

所有测试 `Config` fixture 明确设置单卷 `media_dirs: vec![root.into()]` 和保留值 `1`，不要引入隐式测试默认值。

- [ ] **步骤 7：运行任务测试并提交**

运行：

```bash
cargo fmt --all -- --check
cargo test -p movie-harbor-api config::tests -- --nocapture
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test migration_test -- --nocapture
cargo test -p movie-harbor-api --no-run
```

预期：全部退出码为 0。

提交：

```bash
git add backend/migration backend/src/config.rs backend/src/entities/media_asset.rs backend/tests
git commit -m "feat: add media storage volume metadata"
```

### 任务 2：多卷选择与上传预留

**文件：**
- 创建：`backend/src/media/volumes.rs`
- 修改：`backend/src/media/mod.rs`
- 修改：`backend/src/media/storage.rs`
- 测试：`backend/tests/media_upload_test.rs`

- [ ] **步骤 1：为容量选择编写失败测试**

用注入式 `CapacityProbe` 返回确定容量，覆盖最大剩余空间、保留空间、在途预留、失败卷和相同容量按编号排序：

```rust
#[tokio::test]
async fn allocator_selects_the_largest_effective_available_volume() {
    let set = storage_set(&[(0, 80), (1, 200), (2, 200)], 20).await;
    let first = set.reserve_for_upload(50).await.unwrap();
    assert_eq!(first.volume_id(), 1);
    let second = set.reserve_for_upload(140).await.unwrap();
    assert_eq!(second.volume_id(), 2);
}
```

另加无合格卷返回 `MediaError::InsufficientStorage`、reservation drop 后容量恢复的测试。

- [ ] **步骤 2：运行聚焦测试确认 RED**

运行：`cargo test -p movie-harbor-api --test media_upload_test allocator_ -- --nocapture`

预期：FAIL，`MediaStorageSet`、容量探测和预留 API 尚不存在。

- [ ] **步骤 3：实现单卷容量查询**

在 `LocalMediaStorage` 上增加只读方法，复用已验证的根目录描述符：

```rust
pub(crate) fn available_bytes(&self) -> Result<u64, MediaError> {
    let stat = rustix::fs::fstatvfs(&self.root_fd).map_err(std::io::Error::from)?;
    stat.f_bavail.checked_mul(stat.f_frsize).ok_or_else(|| {
        std::io::Error::other("media filesystem capacity overflow").into()
    })
}
```

不要用宿主机路径重新打开目录，也不要把容量探测加入 `LocalMediaStorage::store`。

- [ ] **步骤 4：实现 `MediaStorageSet` 和 reservation 生命周期**

在 `volumes.rs` 定义：

```rust
#[derive(Clone)]
pub struct MediaStorageSet {
    volumes: Arc<Vec<MediaVolume>>,
    reserve_bytes: u64,
    reservations: Arc<Mutex<HashMap<i32, u64>>>,
    mutations: Arc<AsyncMutex<()>>,
    capacity: Arc<dyn CapacityProbe>,
}

pub struct UploadReservation {
    volume_id: i32,
    reserved_bytes: u64,
    reservations: Arc<Mutex<HashMap<i32, u64>>>,
}
```

`reserve_for_upload(required_bytes)` 在一个 mutex 临界区内读取各卷容量、减去安全空间和现有预留，使用 `(effective_available, Reverse(volume_id))` 选择最大值。使用 `checked_sub`/`checked_add`，任何溢出都让该卷失去资格。`UploadReservation::drop` 必须释放预留。所有卷共享 `mutations` 锁，保持现有“媒体文件变更直到数据库归属明确前串行化”的语义，并消除跨卷替换的锁顺序死锁。

- [ ] **步骤 5：初始化所有卷并验证重复根**

`MediaStorageSet::initialize(paths, reserve_bytes)` 按配置顺序验证 `.movie-harbor-volume.json` 并初始化 `LocalMediaStorage`，让每卷引用同一个 `mutations`。它拒绝空列表、重复 canonical path、身份编号不符和卷编号超出 `i32`。初始化错误必须携带逻辑卷编号但不打印绝对路径。

容量依赖使用明确接口，生产实现调用 `LocalMediaStorage::available_bytes`，测试实现返回固定值或错误：

```rust
pub(crate) trait CapacityProbe: Send + Sync {
    fn available_bytes(&self, volume: &MediaVolume) -> Result<u64, MediaError>;
}
```

- [ ] **步骤 6：运行测试并提交**

运行：

```bash
cargo fmt --all -- --check
cargo test -p movie-harbor-api --test media_upload_test allocator_ -- --nocapture
cargo test -p movie-harbor-api media:: -- --nocapture
cargo clippy -p movie-harbor-api --all-targets -- -D warnings
```

提交：

```bash
git add backend/src/media backend/tests/media_upload_test.rs
git commit -m "feat: select media volumes by available space"
```

### 任务 3：上传持久化、恢复和公共 URL

**文件：**
- 修改：`backend/src/media/{mod,routes,upload,volumes}.rs`
- 修改：`backend/src/app.rs`
- 修改：`backend/src/catalog/{dto,query}.rs`
- 修改：`backend/src/admin_content/query.rs`
- 修改：`frontend/admin-web/src/content/editorSupport.ts`
- 测试：`backend/tests/{media_upload,catalog,admin_content,movies,series}_test.rs`
- 测试：`frontend/admin-web/src/content/editorSupport.test.ts`

- [ ] **步骤 1：编写失败的端到端后端测试**

增加双卷 fixture，上传后断言数据库卷编号、物理文件和公开 URL 一致：

```rust
let response = upload_movie_video(&app, movie.id, fixture_mp4()).await;
assert_eq!(response.status(), StatusCode::OK);
let asset = media_asset::Entity::find().one(&db).await.unwrap().unwrap();
assert_eq!(asset.storage_volume, 1);
assert!(volume_1.join(&asset.storage_key).is_file());
assert_eq!(public_movie(&app, movie.id).await["video_url"],
    format!("/media/v1/{}", asset.storage_key));
```

增加所有四类媒体共享选择算法、缺少 `Content-Length` 使用上限预留、无可用卷返回 `507` 与代码 `media_storage_insufficient` 的测试。

- [ ] **步骤 2：运行聚焦测试确认 RED**

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test media_upload_test multi_volume -- --nocapture
```

预期：FAIL，上传状态仍持有单个 `LocalMediaStorage`，资产也未写卷编号。

- [ ] **步骤 3：让上传返回卷绑定文件**

定义统一结果并让 reservation 与 `StoredFile` 同生命周期：

```rust
pub struct VolumeStoredFile {
    pub volume_id: i32,
    pub stored: StoredFile,
    _reservation: UploadReservation,
}
```

`MediaStorageSet::store` 接受预估字节、选择卷并调用该卷的流式 `store`。路由从 `Content-Length` 获取保守预估，缺失时使用 `policy.max_bytes()`；不能把文件读入内存计算大小。

- [ ] **步骤 4：持久化卷并按卷恢复上传**

`PendingAttachment` 保存 `MediaStorageSet`、卷编号和卷内 `StoredFile`。`insert_asset` 明确设置：

```rust
storage_volume: Set(stored.volume_id),
storage_key: Set(stored.stored.storage_key.clone()),
```

`recover_stale_uploads` 遍历所有卷；查询 pending marker 时同时过滤 `StorageVolume` 与 `StorageKey`，防止同键跨卷误判。

- [ ] **步骤 5：更新发布校验和 URL 查询**

所有目录、电影详情、剧集详情和管理列表 SQL 同时选择 `storage_volume`。将 URL 辅助函数改成：

```rust
pub(crate) fn media_url(volume: Option<i32>, key: Option<String>, expected: &str) -> Option<String> {
    let volume = volume.filter(|value| *value >= 0)?;
    key.filter(|key| controlled_storage_key(key, expected))
        .map(|key| format!("/media/v{volume}/{key}"))
}
```

`is_publishable_asset` 通过 `MediaStorageSet::volume(asset.storage_volume)` 定位，不允许扫描其他卷寻找同名键。

- [ ] **步骤 6：增加结构化错误和中文提示**

`MediaError::InsufficientStorage` 映射为：

```rust
(StatusCode::INSUFFICIENT_STORAGE,
 Json(json!({"error":"media storage is unavailable or full", "code":"media_storage_insufficient"})))
```

前端 `classifyEditorWriteError` 把该代码映射为“媒体存储空间不足或不可用，请检查硬盘连接和剩余空间后重试。”，不展示路径。

- [ ] **步骤 7：运行任务测试并提交**

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test media_upload_test -- --nocapture
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test catalog_test --test admin_content_test --test movies_test --test series_test
npm test --workspace @movie-harbor/admin-web
```

提交：

```bash
git add backend frontend/admin-web
git commit -m "feat: persist and expose media volume locations"
```

### 任务 4：跨卷替换、删除与恢复

**文件：**
- 修改：`backend/src/media/{removal,upload,volumes}.rs`
- 修改：`backend/src/{movies,series}/service.rs`
- 测试：`backend/tests/{media_removal,media_upload,movies,series}_test.rs`

- [ ] **步骤 1：编写跨卷失败与恢复测试**

覆盖剧集海报位于卷 0、两个单集视频分别位于卷 1/2 的删除；在卷 2 注入 stage 失败后断言三个文件和数据库都保留。再覆盖提交成功后的全部清理，以及新旧文件跨卷替换：

```rust
let result = delete_series(&db, &storage_set, series.id).await;
assert!(matches!(result, Err(DeleteError::Media)));
for asset in assets {
    assert!(volume(asset.storage_volume).join(asset.storage_key).is_file());
}
assert!(series::Entity::find_by_id(series.id).one(&db).await.unwrap().is_some());
```

- [ ] **步骤 2：运行测试确认 RED**

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test media_removal_test multi_volume -- --nocapture
```

预期：FAIL，`OwnedMedia` 没有卷编号且 `RemovalSession` 只持有一个卷锁。

- [ ] **步骤 3：按卷分组并复用全局媒体变更锁**

为 `OwnedMedia` 与 manifest entry 增加 `storage_volume: i32`。`load_owned_media` 必须读取该列。`MediaStorageSet::acquire_removal()` 取得所有卷共享的单一 mutation lock；上传完成后 `VolumeStoredFile` 持有的同一 guard 可以直接交给 replacement removal session，禁止在持有该 guard 时再次加锁。

```rust
pub(crate) async fn acquire_removal(&self) -> Result<OwnedMutexGuard<()>, MediaError> {
    Ok(self.mutations.clone().lock_owned().await)
}
```

- [ ] **步骤 4：实现多卷 staged operation**

`MultiVolumeStagedRemoval` 保存按卷编号排序的 `Vec<(i32, LocalMediaStorage, StagedOperation)>`。所有卷使用同一 `operation_id`，但每卷 manifest 只包含本卷条目并显式记录卷编号。stage 失败时按相反顺序恢复已完成卷；finish 失败保留仍可恢复的清单并返回现有 finalization 错误语义。

```rust
pub struct MultiVolumeStagedRemoval {
    operations: Vec<VolumeStagedOperation>,
    _guard: OwnedMutexGuard<()>,
}

struct VolumeStagedOperation {
    volume_id: i32,
    storage: LocalMediaStorage,
    staged: StagedOperation,
}
```

- [ ] **步骤 5：恢复时绑定卷和数据库引用**

启动时依次扫描所有卷。manifest 中 `storage_volume` 必须等于当前扫描卷；`is_referenced` SQL 同时匹配资产 ID、卷编号和键：

```sql
WHERE a.id = $1 AND a.storage_volume = $2 AND a.storage_key = $3
```

缺失任何被引用卷时在扫描前失败，不允许从其他卷恢复同名文件。

- [ ] **步骤 6：运行删除矩阵并提交**

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test media_removal_test -- --nocapture
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test -p movie-harbor-api --test media_upload_test --test movies_test --test series_test
cargo clippy -p movie-harbor-api --all-targets -- -D warnings
```

提交：

```bash
git add backend/src backend/tests
git commit -m "feat: coordinate media removal across volumes"
```

### 任务 5：Compose 多挂载与卷身份

**文件：**
- 创建：`tools/storage-compose.mjs`
- 创建：`tools/start-compose.sh`
- 修改：`docker-compose.yml`
- 修改：`.env.example`
- 修改：`.gitignore`
- 修改：`Caddyfile`
- 创建：`tests/storage-compose.test.mjs`
- 修改：`tests/compose-storage.test.mjs`

- [ ] **步骤 1：编写失败的存储配置生成测试**

测试分号列表解析和覆盖文件的三个服务挂载：

```js
const config = renderStorageCompose([
  "/mnt/disk one/media",
  "/mnt/disk-two/media",
]);
assert.deepEqual(config.services.api.volumes.map(v => v.target), [
  "/media/volumes/0", "/media/volumes/1",
]);
assert.equal(config.services.caddy.volumes[1].read_only, true);
assert.equal(config.services.api.environment.MEDIA_DIRS,
  "/media/volumes/0;/media/volumes/1");
```

同时断言空项、重复、分号注入、相对追加路径和缺失目录被拒绝，生成文件不包含 `.env` 中的任何密码字段。

- [ ] **步骤 2：运行 Node 测试确认 RED**

运行：`node --test tests/storage-compose.test.mjs tests/compose-storage.test.mjs`

预期：FAIL，生成器和新挂载目标尚不存在。

- [ ] **步骤 3：实现纯函数生成器和原子 CLI**

`tools/storage-compose.mjs` 导出 `parseMediaHostDirs`、`renderStorageCompose`、`readVolumeMarker`。覆盖文件使用 `JSON.stringify(..., null, 2)`，避免路径形成 YAML 注入。CLI 先写同目录临时文件，`fsync` 后原子 rename 为 `compose.storage.generated.json`。

```js
export function renderStorageCompose(hostDirs) {
  return { services: {
    "media-init": { volumes: mounts(hostDirs, "/media/volumes", false) },
    api: {
      environment: { MEDIA_DIRS: containerDirs(hostDirs.length).join(";") },
      volumes: mounts(hostDirs, "/media/volumes", false),
    },
    caddy: { volumes: mounts(hostDirs, "/srv/media/volumes", true) },
  } };
}
```

- [ ] **步骤 4：实现卷身份初始化与启动入口**

卷标记固定为 `.movie-harbor-volume.json`：

```json
{"version":1,"volume":0}
```

`start-compose.sh` 只允许为现有卷 0 或空的新卷创建缺失标记；非空的新卷必须显式报错。它验证全部标记后生成覆盖，并执行：

```sh
docker compose -f docker-compose.yml -f compose.storage.generated.json --env-file .env up -d --build --wait
```

脚本不得 `source .env`，避免把配置内容解释为 shell 代码。

- [ ] **步骤 5：更新单卷默认 Compose 和 Caddy 路由**

基础 Compose 将默认目录挂载到卷 0 目标，并设置 `create_host_path: false`。Caddy 使用带名捕获组的路径匹配，严格限制非负十进制卷号和现有三段受控键，再改写到 `/media/volumes/<编号>/...`；原 `/media/video/...` 和 `/media/poster/...` 在升级后不再生成。

```caddyfile
@public_media path_regexp public_media ^/media/v([0-9]+)/(poster|video)/([0-9a-f]{2}/[0-9a-f]{32}\.[A-Za-z0-9]+)$
handle @public_media {
    rewrite * /media/volumes/{re.public_media.1}/{re.public_media.2}/{re.public_media.3}
    root * /srv
    file_server
}
```

- [ ] **步骤 6：验证合并后的 Compose 与路径安全**

运行：

```bash
node --test tests/storage-compose.test.mjs tests/compose-storage.test.mjs
node tools/storage-compose.mjs --env .env.example --output compose.storage.generated.json
docker compose -f docker-compose.yml -f compose.storage.generated.json --env-file .env.example config
caddy validate --config Caddyfile --adapter caddyfile
git diff --check
```

测试结束删除生成文件；它必须已被 `.gitignore` 忽略。

- [ ] **步骤 7：提交**

```bash
git add .env.example .gitignore Caddyfile docker-compose.yml tools tests/storage-compose.test.mjs tests/compose-storage.test.mjs
git commit -m "feat: generate multi-volume compose mounts"
```

### 任务 6：真实多卷端到端流程与文档

**文件：**
- 修改：`tests/e2e/run.mjs`
- 修改：`tests/e2e/run-safety.mjs`
- 修改：`tests/e2e/helpers.ts`
- 修改：`tests/e2e/playback.spec.ts`
- 修改：`README.md`
- 修改：`AGENTS.md`

- [ ] **步骤 1：扩展 E2E runner 创建两个隔离媒体卷**

让 runner 创建 `media-0` 和 `media-1`，生成合法卷标记与 Compose 覆盖文件，并把两个绝对路径留在临时测试根内。安全测试断言任何生产 `MEDIA_HOST_DIR` 都被覆盖，且 cleanup 只处理本次随机项目目录。

- [ ] **步骤 2：编写失败的真实流程测试**

Playwright 使用两个隔离挂载验证生成配置、卷身份、上传、播放、删除和重启；两个目录位于同一测试文件系统时容量相同，因此按确定性规则落到卷 0。断言：

```ts
expect(movie.poster_url).toMatch(/^\/media\/v0\/poster\//);
expect(movie.video_url).toMatch(/^\/media\/v0\/video\//);
expect((await request.get(movie.video_url!)).status()).toBe(200);
```

随后替换视频、删除电影、重启 Compose，验证两个卷没有旧文件、内部目录不公开且恢复无残留。

- [ ] **步骤 3：运行 E2E 确认 RED**

运行：`npm run test:e2e`

预期：FAIL，runner 尚未生成多卷配置或媒体 URL 仍没有卷编号。

- [ ] **步骤 4：完成 runner 与测试辅助实现**

跨卷选择和跨卷回滚由 Rust 集成测试注入确定容量的 `CapacityProbe` 覆盖；生产 `app::build` 和 Compose E2E 始终使用 `fstatvfs`，不增加环境变量或 HTTP 接口形式的伪造容量开关。两个真实物理卷的容量差异留给 Linux/Windows 实机验收。

```js
const storage = await createIsolatedStorageVolumes(run.root, 2);
await writeStorageOverride(run.composeOverride, storage.hostDirs);
run.composeFiles = ["docker-compose.yml", run.composeOverride];
```

- [ ] **步骤 5：同步使用与协作文档**

README 写明分号数组、只追加规则、10 GiB 保留值、卷初始化、扩容、全卷一致备份和故障处理。AGENTS.md 更新实际目录边界、媒体卷约束和相关规格/计划链接，不重复整份设计。

- [ ] **步骤 6：运行完整验证**

运行：

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

- [ ] **步骤 7：提交**

```bash
git add tests/e2e README.md AGENTS.md
git commit -m "test: verify multi-volume media deployment"
```

- [ ] **步骤 8：请求代码审查**

使用 superpowers:requesting-code-review，逐项核对 `2026-09-16-multi-volume-media-storage-design.md`，重点审查路径逃逸、共享变更锁、跨卷回滚、启动恢复和既有卷 0 兼容性。发现问题后使用 superpowers:receiving-code-review 验证并修复，再重新运行步骤 6。
