# 管理后台内容批量操作实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 允许管理员对当前页明确勾选的最多 20 部电影或剧集原子执行访问范围、题材或归档操作。

**架构：** 在 `admin_content` 领域增加带判别字段的批量 DTO 和单事务服务，按 `kind + id` 固定顺序锁行、收集全部问题后统一写入。前端仅保存当前页选择，确认框提交一次批量请求，成功后刷新列表，冲突保留选择并呈现问题。

**技术栈：** Rust、Axum、SeaORM、PostgreSQL、React、TypeScript、Vitest、Playwright。

**规格：** `docs/superpowers/specs/2026-11-23-admin-content-bulk-actions-design.md`

## 全局约束

- 目标 1–20 条且 `kind + id` 唯一；题材 1–20 个且唯一。
- 一批请求只开启一个事务，全部成功或全部回滚；禁止前端循环调用单条接口。
- 领域问题统一 `409 bulk_validation_failed`，按规范顺序返回全部 `problems`，不返回名称或当前版本。
- 幂等无效果子操作仍使每个目标版本恰好递增一次。
- 不支持跨页、部分成功、批量删除、发布、媒体或季/单集操作。
- 所有新增命名函数、类型、测试和关键调用点维护中文说明。

## 审查重点（Review Focus）

- 混合电影/剧集批次必须按固定顺序锁定，逆序并发请求不能死锁或部分提交。
- 不存在、旧版本、非法状态和无效题材同时出现时，应一次返回全部问题且零写入。
- 添加停用题材失败，移除同一停用题材允许；已存在/未关联的无效果子操作也只递增一次版本。
- 成功响应后列表刷新失败不得自动重放写请求，旧表格必须明确标记为过期。
- 翻页、筛选、刷新和普通单条操作都必须清空选择，冲突则保留选择等待人工刷新。

---

### 任务 1：批量请求、问题与响应 DTO

**文件：**
- 修改：`backend/src/admin_content/dto.rs`
- 测试：`backend/tests/admin_content_bulk_test.rs`

- [ ] 编写失败的 Router 输入测试：空/超限/重复目标、非法 kind/version、动作字段混用、空/重复/超限题材。
- [ ] 运行 `cargo test --test admin_content_bulk_test bulk_request -- --nocapture`，确认路由缺失。
- [ ] 定义 `BulkActionRequest` 判别枚举、`BulkTarget`、`BulkProblem`、`BulkActionResponse` 与结果题材摘要；解析阶段完成结构和 UUID/数量校验。
- [ ] 重跑输入测试并提交 `feat: define admin bulk action contract`。

### 任务 2：原子批量服务与路由

**文件：**
- 创建：`backend/src/admin_content/service.rs`
- 修改：`backend/src/admin_content/mod.rs`
- 修改：`backend/src/admin_content/routes.rs`
- 修改：`backend/src/movies/repository.rs`
- 修改：`backend/src/series/repository.rs`
- 测试：`backend/tests/admin_content_bulk_test.rs`

- [ ] 先写真实 PostgreSQL 失败测试：混合成功、并发逆序、完整问题集合、版本/状态回滚、题材增删与停用规则、版本递增、重复提交和归档公开不可见。
- [ ] 运行测试确认服务缺失或行为失败。
- [ ] 实现 `execute_bulk_action(db, request)`：规范排序、逐类锁行但按统一目标顺序维持锁定、锁定题材、收集问题，问题为空时调用可加入外层事务的仓储更新并一次提交。
- [ ] 为电影/剧集仓储增加事务内批量所需的窄接口，复用 `content::transition` 维护归档时间，不调用单条服务开启嵌套事务。
- [ ] 注册 `POST /api/admin/contents/bulk-actions`，沿用管理员认证、CSRF 和来源中间件；409 返回稳定 code 与 problems。
- [ ] 重跑批量、电影、剧集、目录测试及 Clippy，提交 `feat: add atomic admin content bulk actions`。

### 任务 3：共享 API 客户端

**文件：**
- 修改：`frontend/packages/api-client/src/types.ts`
- 修改：`frontend/packages/api-client/src/admin.ts`
- 修改：`frontend/packages/api-client/src/admin.test.ts`

- [ ] 编写失败测试，断言三种判别请求体原样发送，409 详情可由显式类型安全解析。
- [ ] 运行 API 客户端测试确认失败。
- [ ] 增加批量动作、目标、问题、结果类型和 `bulkUpdateAdminContent()`。
- [ ] 重跑并提交 `feat: add admin bulk action client`。

### 任务 4：当前页选择与批量确认界面

**文件：**
- 创建：`frontend/admin-web/src/content/BulkActionBar.tsx`
- 创建：`frontend/admin-web/src/content/BulkActionDialog.tsx`
- 创建：`frontend/admin-web/src/content/BulkActionDialog.test.tsx`
- 修改：`frontend/admin-web/src/content/ContentTable.tsx`
- 修改：`frontend/admin-web/src/content/ContentPage.tsx`
- 修改：`frontend/admin-web/src/content/ContentPage.test.tsx`
- 修改：`frontend/admin-web/src/styles.css`

- [ ] 编写失败测试：逐项选择、表头三态与无障碍名称、当前页全选、翻页/筛选/刷新/普通操作清空、未选禁用、三种确认内容和请求体版本。
- [ ] 编写失败测试：409 保留选择并标行，成功清空后刷新，刷新失败只提示“操作已完成，列表刷新失败”且不重写。
- [ ] 运行管理前端聚焦测试确认失败。
- [ ] 实现以 `kind:id` 为键的页内选择；题材确认框读取现有管理题材列表，移除模式包含已停用题材，添加模式只显示启用题材。
- [ ] 解析 `bulk_validation_failed` problems 到行级/题材级错误；403 只恢复会话不重放，401 退出后台。
- [ ] 重跑管理前端全部测试与构建并提交 `feat: add admin bulk action interface`。

### 任务 5：跨服务批量验收

**文件：**
- 修改：`tests/e2e/admin.spec.ts`

- [ ] 增加失败 E2E：混合选择原子成功、一个旧版本使整批失败、题材和归档效果，以及批量入口不存在删除/媒体操作。
- [ ] 运行聚焦 E2E 确认失败，再补齐必要测试数据辅助函数。
- [ ] 运行完整 Rust、前端、根契约、`npm run test:e2e` 与 `git diff --check`。
- [ ] 提交 `test: cover admin content bulk actions`。
