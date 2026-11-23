# 管理后台系统概览实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为已认证管理员提供只读系统概览，展示一致的数据库摘要、单媒体卷容量状态、应用版本和真实的备份边界。

**架构：** 新建 `admin_system` 后端边界，数据库摘要在 Repeatable Read 只读事务中聚合，容量通过 `LocalMediaStorage` 暴露的可注入只读采样接口取得。管理前端新增独立页面并通过共享 API 客户端加载；容量采样失败只降级卷状态，数据库失败使请求失败。

**技术栈：** Rust、Axum、SeaORM、rustix、React、TypeScript、Vitest。

**规格：** `docs/superpowers/specs/2026-11-23-admin-system-overview-design.md`

## 全局约束

- 页面与 API 只读，不执行备份、恢复、升级、清理、迁移或写探针。
- 首期仅报告卷 0；安全保留空间固定为 `10 * 1024 * 1024 * 1024` 字节，未来多卷实现再接管配置。
- 未知容量返回 `null`，不得用零代替；只允许 `storage_capacity_unavailable`、`storage_space_low` 告警码。
- 不返回路径、存储键、数据库连接、环境变量或底层错误。
- 所有新增命名函数、类型、测试和关键调用点维护中文说明。

## 审查重点（Review Focus）

- 容量系统调用失败时，数据库统计仍返回且卷为不可访问，响应不泄漏底层错误。
- 可用字节恰好等于保留值时必须为空间不足、不可上传、可上传字节为零。
- 海报与视频统计不能重复计数，未知或非法目的不得被悄悄归入已有分类。
- 数据库分项必须来自同一快照，不能返回互相矛盾的内容和媒体统计。
- 管理页面失败后不得继续展示旧的“正常”徽标，手动刷新不得形成并发覆盖。

---

### 任务 1：媒体容量只读边界

**文件：**
- 修改：`backend/src/media/storage.rs`
- 修改：`backend/src/media/mod.rs`
- 测试：`backend/tests/media_upload_test.rs`

- [ ] 编写失败测试：注入容量采样成功、失败以及可用字节等于 10 GiB 的边界，断言只读采样不产生存储事件或文件。
- [ ] 运行 `cargo test --test media_upload_test storage_capacity -- --nocapture`，确认因容量接口不存在而失败。
- [ ] 增加 `StorageCapacity { total_bytes, available_bytes }`、`StorageCapacityReader` 与 `LocalMediaStorage::capacity()`；生产实现用已打开媒体根目录的文件系统信息，不重新读环境变量。
- [ ] 重跑聚焦测试，确认通过。
- [ ] 提交 `feat: expose read-only media capacity`。

### 任务 2：系统概览后端接口

**文件：**
- 创建：`backend/src/admin_system/mod.rs`
- 创建：`backend/src/admin_system/dto.rs`
- 创建：`backend/src/admin_system/query.rs`
- 创建：`backend/src/admin_system/routes.rs`
- 修改：`backend/src/lib.rs`
- 修改：`backend/src/app.rs`
- 测试：`backend/tests/admin_system_test.rs`

- [ ] 先写 Router 测试：未认证 `401`、成功响应 `private, no-store`、统计及媒体类型汇总、低空间、容量失败降级、敏感字段缺席和数据库失败 `500`。
- [ ] 运行 `cargo test --test admin_system_test -- --nocapture`，确认路由或模块缺失导致失败。
- [ ] 定义 `SystemOverview`、状态、计数、卷、备份和告警 DTO；字节字段使用可序列化的非负 `u64`/`Option<u64>`。
- [ ] 在 `query::summary<C: ConnectionTrait>` 中聚合电影、剧集、单集、普通用户、有效会话用户和媒体资产，并由 `overview` 在只读一致性事务中组合容量结果。
- [ ] 注册 `GET /api/admin/system/overview`，共享管理员认证状态与 `LocalMediaStorage`，应用版本取 `env!("CARGO_PKG_VERSION")`。
- [ ] 重跑 `admin_system_test` 与相关认证测试，确认通过。
- [ ] 提交 `feat: add admin system overview API`。

### 任务 3：共享 API 类型与客户端

**文件：**
- 修改：`frontend/packages/api-client/src/types.ts`
- 修改：`frontend/packages/api-client/src/admin.ts`
- 修改：`frontend/packages/api-client/src/admin.test.ts`

- [ ] 编写失败测试，断言 `getAdminSystemOverview()` 请求唯一的只读路径并保留 `null` 容量字段。
- [ ] 运行 `npm test --workspace @movie-harbor/api-client`，确认导出缺失。
- [ ] 增加系统状态、摘要、卷、告警和备份类型以及客户端函数。
- [ ] 重跑 API 客户端测试并提交 `feat: add system overview API client`。

### 任务 4：管理后台系统概览页面

**文件：**
- 创建：`frontend/admin-web/src/system/SystemOverviewPage.tsx`
- 创建：`frontend/admin-web/src/system/SystemOverviewPage.test.tsx`
- 修改：`frontend/admin-web/src/app/App.tsx`
- 修改：`frontend/admin-web/src/styles.css`

- [ ] 编写失败测试覆盖加载、正常摘要、低空间/容量未知、失败重试、手动刷新、字节格式化、无障碍状态文字和“应用无法验证备份”说明。
- [ ] 运行管理前端聚焦测试，确认页面尚不存在。
- [ ] 实现页面；请求代次阻止旧刷新覆盖新结果，失败状态清除旧概览，不提供任何运维写按钮。
- [ ] 将“系统设置”导航指向新页面并保持现有会话失效处理。
- [ ] 重跑管理前端测试和构建并提交 `feat: add read-only system overview page`。

### 任务 5：跨服务验收

**文件：**
- 修改：`tests/e2e/admin.spec.ts`

- [ ] 增加失败的 E2E：匿名无法读取系统概览，管理员页面显示卷 0、版本、资源统计和备份边界，页面不存在写操作按钮。
- [ ] 运行聚焦 E2E 确认失败，再实现必要的测试数据适配。
- [ ] 运行完整 Rust、前端、根契约、`npm run test:e2e` 与 `git diff --check`。
- [ ] 提交 `test: cover admin system overview`。
