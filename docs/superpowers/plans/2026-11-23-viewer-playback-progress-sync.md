# 普通用户观看进度与跨设备同步实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为登录普通用户提供跨设备观看进度、剧集游标、已看完状态、匿名可选合并和“继续观看”移除能力，同时保留本地离线降级。

**架构：** PostgreSQL 保存规范进度、剧集游标和永久删除墓碑，Axum 在现有普通用户会话中间件后提供逐项同步 API。公开站把版本化 `localStorage` 作为本地缓存和离线队列，通过共享 API 客户端合并服务端快照；播放器先写本地再异步同步，首页从规范缓存生成续播卡片。

**技术栈：** Rust 2024、Axum 0.8、SeaORM 1.1、PostgreSQL 17、React、TypeScript、Vitest、Playwright。

**规格：** `docs/superpowers/specs/2026-11-23-viewer-playback-progress-sync-design.md`

## 全局约束

- 每个命名函数、方法、React 组件、Hook、类型、DTO、测试和迁移都添加说明功能与调用时机的中文注释。
- 后端进度路由全部复用现有普通用户会话、同源、CSRF 和 `Cache-Control: no-store` 边界。
- 客户端不得提交用户 ID；服务端只使用当前会话的 `viewer_user_id`。
- 批量合并最多 500 个操作，客户端时间不得晚于服务端当前时间 24 小时。
- 进度、游标和删除按原始客户端时间解决冲突；删除墓碑不按时间清理。
- 匿名记录只有用户明确选择且服务端确认条目后才从匿名空间清除。
- 任何进度服务故障都不得阻止公开内容加载或视频播放。
- 不新增收藏、评分、评论、完整历史页或自动播放下一集。

## 审查重点（Review Focus）

- 长期离线设备提交早于电影、单集或整剧墓碑的记录时必须被忽略，不能恢复已移除卡片。
- 延迟删除早于另一设备的新播放时，新播放必须保留，不能被重试时刻覆盖。
- 混有已归档、已删除或无视频目标的批量请求必须逐项拒绝，同时提交其他有效条目。
- 会话切换期间迟到的同步响应不能写入新账号缓存或清除匿名记录。
- 版本 1 本地数据只有 `recentEpisodes`、没有进度时，升级后仍能在本机定位原单集且不会压过服务端较新游标。

---

## 文件结构

### 新建

- `backend/migration/src/m20261123_000010_viewer_playback_progress.rs`：创建进度、剧集游标、删除墓碑及约束索引。
- `backend/src/entities/viewer_playback_progress.rs`：进度 SeaORM 实体。
- `backend/src/entities/viewer_series_cursor.rs`：剧集游标 SeaORM 实体。
- `backend/src/entities/viewer_playback_removal.rs`：删除墓碑 SeaORM 实体。
- `backend/src/viewer_progress/mod.rs`：观看进度领域入口。
- `backend/src/viewer_progress/dto.rs`：同步输入、逐项结果和规范快照 DTO。
- `backend/src/viewer_progress/service.rs`：校验目标、按时间合并、生成规范快照。
- `backend/src/viewer_progress/routes.rs`：受普通用户认证保护的进度路由。
- `backend/tests/viewer_progress_test.rs`：真实 PostgreSQL 路由、冲突和权限测试。
- `frontend/public-web/src/player/progressSync.ts`：本地缓存与服务端同步、离线重试及身份代次保护。
- `frontend/public-web/src/player/progressSync.test.ts`：同步引擎测试。
- `frontend/public-web/src/auth/ProgressMergeDialog.tsx`：匿名进度合并确认界面。

### 修改

- `backend/migration/src/lib.rs`、`backend/tests/migration_test.rs`：注册并验证可逆迁移。
- `backend/src/entities/mod.rs`、`backend/src/lib.rs`、`backend/src/app.rs`：注册实体、领域和路由。
- `frontend/packages/api-client/src/types.ts`、`public.ts`、`public.test.ts`：共享进度契约与请求函数。
- `frontend/public-web/src/player/progressStore.ts`、`progressStore.test.ts`：本地格式 v2、游标、墓碑和 v1 迁移。
- `frontend/public-web/src/auth/ViewerContext.ts`、`frontend/public-web/src/app/App.tsx`、`auth/ViewerAuth.test.tsx`：会话同步、匿名合并提示和身份切换安全。
- `frontend/public-web/src/player/VideoPlayer.tsx`、`PlayerPage.tsx` 及对应测试：保存、完成、从头播放和下一集定位。
- `frontend/public-web/src/catalog/ContinueWatching.tsx`、`ContinueWatching.test.tsx`、`frontend/public-web/src/styles.css`：服务端规范续播和移除操作。
- `tests/e2e/public.spec.ts`：跨会话进度、匿名合并和移除验收。

### 任务 1：数据库结构与实体

**文件：**
- 创建：`backend/migration/src/m20261123_000010_viewer_playback_progress.rs`
- 创建：`backend/src/entities/viewer_playback_progress.rs`
- 创建：`backend/src/entities/viewer_series_cursor.rs`
- 创建：`backend/src/entities/viewer_playback_removal.rs`
- 修改：`backend/migration/src/lib.rs`
- 修改：`backend/src/entities/mod.rs`
- 修改：`backend/tests/migration_test.rs`

- [ ] **步骤 1：编写失败的迁移测试**

新增 `viewer_progress_schema_is_reversible_and_enforces_targets`：升级后验证三张表、外键级联、三种“恰好一个目标”、部分唯一索引、位置/时长有限且 `0 <= position <= duration`；降级一步后验证三张表消失且用户和内容仍存在。

- [ ] **步骤 2：运行测试验证失败**

运行：`TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --test migration_test viewer_progress_schema_is_reversible_and_enforces_targets -- --nocapture`

预期：FAIL，迁移或新表不存在。

- [ ] **步骤 3：实现迁移和实体**

创建三张表并注册第 10 个迁移；为每个实体定义精确列和关系。墓碑对 movie、episode、series 分别建立部分唯一索引且永久保留，内容和用户删除使用 `ON DELETE CASCADE`。

- [ ] **步骤 4：运行聚焦测试并格式化**

运行：`cargo fmt --all -- --check` 与步骤 2 命令。

预期：格式通过，迁移测试 PASS。

- [ ] **步骤 5：Commit**

```bash
git add backend/migration backend/src/entities backend/tests/migration_test.rs
git commit -m "feat: add viewer playback progress schema"
```

### 任务 2：后端同步领域与受保护 API

**文件：**
- 创建：`backend/src/viewer_progress/mod.rs`
- 创建：`backend/src/viewer_progress/dto.rs`
- 创建：`backend/src/viewer_progress/service.rs`
- 创建：`backend/src/viewer_progress/routes.rs`
- 创建：`backend/tests/viewer_progress_test.rs`
- 修改：`backend/src/lib.rs`
- 修改：`backend/src/app.rs`

- [ ] **步骤 1：编写失败的认证和基本写读测试**

新增 `viewer_progress_requires_viewer_session_and_csrf`、`viewer_progress_round_trips_movies_episodes_and_cursors`，断言匿名和管理员 Cookie 为 401，缺少/错误 CSRF 为 403，普通用户只能看到自己的进度，所有响应为 `no-store`。

- [ ] **步骤 2：运行测试验证失败**

运行：`TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --test viewer_progress_test -- --nocapture`

预期：FAIL，进度路由不存在。

- [ ] **步骤 3：实现 DTO、路由骨架和目标校验**

定义 `PlaybackTargetKind`、`ProgressInput`、`CursorInput`、`RemovalInput`、`MergeRequest`、`MergeItemResult`、`ProgressSnapshot`；将 GET、POST merge、PUT、DELETE 路由放在 `viewer_auth::routes::require_session` 后。目标查询必须把草稿、归档、无视频和关系失效统一映射为 404。

- [ ] **步骤 4：编写失败的冲突和批量测试**

新增：较新进度胜出、较旧/相同输入忽略；较旧墓碑阻止进度而较新播放恢复；整剧墓碑阻止所有旧单集；单集墓碑不删除其他集；批量中 `not_found` 不影响有效条目；重复目标、超过 500、非有限值、位置大于时长和未来超过 24 小时返回 400。

- [ ] **步骤 5：运行测试验证正确失败**

运行步骤 2 命令，预期新增冲突断言 FAIL。

- [ ] **步骤 6：实现事务合并和规范快照**

使用单事务处理批次：逐项验证后返回 `accepted/ignored/rejected`；数据库故障回滚整批。进度 upsert 使用复合目标唯一边界和时间条件；游标事务内验证单集属于剧集；删除保存原始时间并仅清理时间不晚于墓碑的进度/游标。快照只返回当前有效、晚于适用墓碑的记录和游标。

- [ ] **步骤 7：运行后端聚焦验证**

运行：`cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`、步骤 2 命令。

预期：全部 PASS，clippy 无警告。

- [ ] **步骤 8：Commit**

```bash
git add backend/src/viewer_progress backend/src/lib.rs backend/src/app.rs backend/tests/viewer_progress_test.rs
git commit -m "feat: add viewer progress sync API"
```

### 任务 3：共享 API 客户端契约

**文件：**
- 修改：`frontend/packages/api-client/src/types.ts`
- 修改：`frontend/packages/api-client/src/public.ts`
- 修改：`frontend/packages/api-client/src/public.test.ts`

- [ ] **步骤 1：编写失败的客户端测试**

验证 `getViewerProgress`、`mergeViewerProgress`、`putViewerProgress`、`removeViewerProgress` 使用精确路径、方法、JSON 和 CSRF 边界；DELETE 保留调用方提交的原始 `removed_at`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test --workspace @movie-harbor/api-client -- public.test.ts`

预期：FAIL，新导出不存在。

- [ ] **步骤 3：实现共享类型与请求函数**

加入与后端 DTO 同名字段的 TypeScript 类型，路径通过 `apiPath` 构造，响应统一由 `requiredResponse` 解析。

- [ ] **步骤 4：运行客户端测试和构建**

运行：`npm test --workspace @movie-harbor/api-client` 与 `npm run build --workspace @movie-harbor/api-client`。

预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add frontend/packages/api-client
git commit -m "feat: add viewer progress API client"
```

### 任务 4：本地格式 v2 与同步引擎

**文件：**
- 修改：`frontend/public-web/src/player/progressStore.ts`
- 修改：`frontend/public-web/src/player/progressStore.test.ts`
- 创建：`frontend/public-web/src/player/progressSync.ts`
- 创建：`frontend/public-web/src/player/progressSync.test.ts`

- [ ] **步骤 1：编写失败的本地迁移测试**

覆盖 v1 进度迁移为未完成、只有最近单集时生成 Unix 纪元游标、账号/匿名隔离、完成记录不被自动清除、电影/单集/整剧墓碑分别隐藏正确范围。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test --workspace @movie-harbor/public-web -- src/player/progressStore.test.ts`

预期：FAIL，版本 2 行为不存在。

- [ ] **步骤 3：实现版本 2 存储原语**

提供读取快照、写入进度、标记完成、设置带时间游标、写入目标墓碑、应用服务端规范快照、检测/清空匿名记录的函数；每次写入返回实际客户端时间，供网络请求复用。

- [ ] **步骤 4：编写失败的同步引擎测试**

覆盖：同步当前账号本地操作并应用服务端快照；迟到响应不覆盖更晚本地数据；身份代次失效时丢弃响应；批量 `not_found` 移除旧缓存；网络失败保留队列；匿名合并只清除已确认条目。

- [ ] **步骤 5：运行测试验证正确失败**

运行：`npm test --workspace @movie-harbor/public-web -- src/player/progressSync.test.ts`

预期：FAIL，同步模块不存在。

- [ ] **步骤 6：实现同步引擎**

同步函数接收 `viewerId` 和 `isCurrent`，从存储构造不超过 500 个操作的批次，调用共享客户端并以时间比较应用结果；单条保存和删除先写本地，再尽力调用 API，失败不抛到播放器。

- [ ] **步骤 7：运行聚焦测试**

运行任务 4 的两个测试文件。

预期：全部 PASS。

- [ ] **步骤 8：Commit**

```bash
git add frontend/public-web/src/player/progressStore* frontend/public-web/src/player/progressSync*
git commit -m "feat: add offline viewer progress synchronization"
```

### 任务 5：会话、播放器与匿名合并体验

**文件：**
- 创建：`frontend/public-web/src/auth/ProgressMergeDialog.tsx`
- 修改：`frontend/public-web/src/auth/ViewerContext.ts`
- 修改：`frontend/public-web/src/app/App.tsx`
- 修改：`frontend/public-web/src/auth/ViewerAuth.test.tsx`
- 修改：`frontend/public-web/src/player/VideoPlayer.tsx`
- 修改：`frontend/public-web/src/player/PlayerPage.tsx`
- 修改：`frontend/public-web/src/player/PlayerPage.test.tsx`

- [ ] **步骤 1：编写失败的会话同步测试**

登录/恢复会话后触发当前账号同步；匿名数据存在时显示一次确认对话框；“暂不合并”不清数据；合并失败保留并可重试；退出、改密或切换身份后迟到结果无效。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test --workspace @movie-harbor/public-web -- src/auth/ViewerAuth.test.tsx`

预期：FAIL，没有同步与合并提示。

- [ ] **步骤 3：接入会话同步和合并对话框**

`App` 在会话被当前身份代次接受后同步，不让同步错误改变认证状态；匿名选择由独立对话框呈现，关闭等同“暂不合并”。

- [ ] **步骤 4：编写失败的播放器测试**

覆盖暂停/节流保存先写本地再同步、`ended` 标记完成、从头播放只写当前 movie/episode 墓碑、剧集选择同步游标、完成单集后游标定位下一集、最后一集保持完成且不自动播放。

- [ ] **步骤 5：运行测试验证正确失败**

运行：`npm test --workspace @movie-harbor/public-web -- src/player/PlayerPage.test.tsx`

预期：FAIL，新事件行为不存在。

- [ ] **步骤 6：实现播放器行为**

扩展 `VideoPlayer` 的完成回调和同步调用；`LoadedSeriesPlayer` 计算下一集并更新游标，保持现有按钮和浏览器播放策略不变。

- [ ] **步骤 7：运行会话与播放器测试**

运行任务 5 的两个测试文件。

预期：全部 PASS。

- [ ] **步骤 8：Commit**

```bash
git add frontend/public-web/src/auth frontend/public-web/src/app/App.tsx frontend/public-web/src/player
git commit -m "feat: sync playback during viewer sessions"
```

### 任务 6：“继续观看”服务端规范化与移除

**文件：**
- 修改：`frontend/public-web/src/catalog/ContinueWatching.tsx`
- 修改：`frontend/public-web/src/catalog/ContinueWatching.test.tsx`
- 修改：`frontend/public-web/src/styles.css`
- 修改：`tests/e2e/public.spec.ts`

- [ ] **步骤 1：编写失败的组件测试**

覆盖服务端同步后的电影/剧集卡片、已完成电影隐藏、已完成单集指向下一集、最后一集隐藏、最多 6 张、按时间排序；移除电影和整剧使用不同目标，成功立即消失，失败保留并显示可重试错误。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test --workspace @movie-harbor/public-web -- src/catalog/ContinueWatching.test.tsx`

预期：FAIL，新卡片和移除行为不存在。

- [ ] **步骤 3：实现卡片选择、移除和样式**

先同步当前账号缓存，再加载内容详情；对完成单集使用有序单集列表选择下一集；移除按钮与播放链接并列且操作期间禁用。

- [ ] **步骤 4：扩展 E2E 验收**

使用两个独立浏览器上下文登录同一账号：A 保存电影位置，B 读取并续播；完成单集后 B 定位下一集；匿名记录需确认后合并；B 的旧记录不能恢复 A 已移除的电影或整剧。

- [ ] **步骤 5：运行前端与 E2E 验证**

运行：`npm test --workspaces`、`npm run build --workspaces`、`npm run test:e2e`。

预期：全部 PASS。

- [ ] **步骤 6：Commit**

```bash
git add frontend/public-web/src/catalog frontend/public-web/src/styles.css tests/e2e/public.spec.ts
git commit -m "feat: add cross-device continue watching controls"
```

### 任务 7：全量验证与文档收尾

**文件：**
- 修改：`docs/superpowers/specs/2026-11-23-viewer-playback-progress-sync-design.md`（仅当实现验证发现需要澄清时）
- 修改：`docs/superpowers/plans/2026-11-23-viewer-playback-progress-sync.md`（勾选实际完成步骤）

- [ ] **步骤 1：运行 Rust 全量验证**

运行：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
```

预期：全部 PASS、0 warnings、0 failures。

- [ ] **步骤 2：运行前端、根契约与跨服务验证**

运行：

```bash
npm test --workspaces
npm run build --workspaces
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
npm run test:e2e
```

预期：全部 PASS。

- [ ] **步骤 3：运行最终差异检查**

运行：`git diff --check`、`git status --short`、`git diff --stat main...HEAD`。

预期：无空白错误，只包含本功能规格、计划、迁移、后端、API 客户端、公开站和 E2E 变更。

- [ ] **步骤 4：Commit 文档勾选**

```bash
git add docs/superpowers/specs/2026-11-23-viewer-playback-progress-sync-design.md docs/superpowers/plans/2026-11-23-viewer-playback-progress-sync.md
git commit -m "docs: finalize viewer progress synchronization"
```
