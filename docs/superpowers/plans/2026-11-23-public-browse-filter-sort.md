# 公开站浏览筛选与排序实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 保留简洁首页并新增 URL 驱动的 `/browse` 页面，提供类型、关键词、题材、年份、访问范围、排序与稳定分页。

**架构：** 扩展现有 `catalog` 候选集合和一致性分页查询，新增同身份可见的 facets 聚合接口。前端把现有完整目录职责迁移到 `BrowsePage`，新增无分页的首页最近添加区；所有浏览状态从 URL 解析和规范化，facets 与目录独立加载。

**技术栈：** Rust、Axum、SeaORM、PostgreSQL、React、TypeScript、Vitest、Playwright。

**规格：** `docs/superpowers/specs/2026-11-23-public-browse-filter-sort-design.md`

## 全局约束

- `/browse` 固定每页 20 条；首页最近添加固定最多 20 条且无数字分页。
- 题材同维度为 OR，跨维度为 AND；最多 20 个去重并按 UUID 文本排序。
- 匿名身份绝不暴露只由私密内容产生的 facets，响应继续 `private, no-store` 与 `Vary: Cookie`。
- URL 是唯一可恢复筛选状态；修改非页码条件回到第 1 页。
- 不新增推荐、热度、单集搜索、跨账号筛选存储或可变页面大小。
- 所有新增命名函数、类型、测试和关键调用点维护中文说明。

## 审查重点（Review Focus）

- 匹配多个所选题材的同一内容只能出现一次，总数也不能重复。
- 年份排序必须把空年份放最后，并在所有排序中保留稳定最终键。
- facets 与目录在匿名、登录和会话失效三个身份阶段不能交叉污染。
- 格式正确但不存在的题材先返回空结果，再由 facets 规范化 URL；格式错误 UUID 必须 `400`。
- 快速修改 URL 时，迟到 facets 或目录响应都不能覆盖新条件，facets 失败也不能清空目录。

---

### 任务 1：目录筛选、排序与 facets 后端

**文件：**
- 修改：`backend/src/catalog/dto.rs`
- 修改：`backend/src/catalog/query.rs`
- 修改：`backend/src/catalog/routes.rs`
- 修改：`backend/src/site_agent.rs`
- 测试：`backend/tests/catalog_test.rs`

- [ ] 编写失败的真实 PostgreSQL 测试：单项/组合筛选、题材 OR 去重、年份为空、四种排序、私密范围、facets 可见性与停用题材、非法参数及分页快照。
- [ ] 运行 `cargo test --test catalog_test -- --nocapture`，确认新参数与路由缺失。
- [ ] 扩展 `CatalogRequest`/`CatalogFilter` 为 `genre_ids: Vec<Uuid>`、`year: Option<i32>`、`sort: CatalogSort`，严格校验 UUID、数量、年份范围与排序枚举。
- [ ] 重构统一候选投影，使筛选先于计数/分页，按排序枚举生成完全一致的候选窗口、分页与最终输出顺序。
- [ ] 增加 `CatalogFacets` 聚合查询与 `GET /api/catalog/facets`；调整站点助手构造默认筛选时显式填入新增字段。
- [ ] 重跑目录、助手与 Clippy 测试并提交 `feat: add catalog facets filtering and sorting`。

### 任务 2：公开 API 客户端契约

**文件：**
- 修改：`frontend/packages/api-client/src/types.ts`
- 修改：`frontend/packages/api-client/src/public.ts`
- 修改：`frontend/packages/api-client/src/public.test.ts`

- [ ] 编写失败测试，断言 genres 以逗号连接、year/sort 被转发，facets 使用独立路径。
- [ ] 运行 API 客户端测试确认失败。
- [ ] 增加 `CatalogSort`、`CatalogFacets`、完整 `CatalogQuery` 和 `listCatalogFacets()`。
- [ ] 重跑并提交 `feat: extend public catalog client`。

### 任务 3：简洁首页

**文件：**
- 创建：`frontend/public-web/src/catalog/HomePage.tsx`
- 创建：`frontend/public-web/src/catalog/HomePage.test.tsx`
- 修改：`frontend/public-web/src/catalog/CatalogToolbar.tsx`
- 修改：`frontend/public-web/src/app/App.tsx`
- 修改：`frontend/public-web/src/styles.css`

- [ ] 编写失败测试：继续观看优先、最近添加 20 条、无分页、类型入口和搜索进入 `/browse`、浏览全部链接。
- [ ] 运行公开前端聚焦测试确认首页组件缺失。
- [ ] 实现 `HomePage`，最近添加调用 `listCatalog({ sort: "recent", page: 1, size: 20 })`；将头部入口变为导航而非首页筛选。
- [ ] 扩展路由和链接拦截以识别 `/browse`，重跑测试并提交 `feat: simplify public home catalog`。

### 任务 4：URL 驱动浏览页

**文件：**
- 创建：`frontend/public-web/src/catalog/BrowsePage.tsx`
- 创建：`frontend/public-web/src/catalog/BrowseFilters.tsx`
- 创建：`frontend/public-web/src/catalog/browseUrl.ts`
- 创建：`frontend/public-web/src/catalog/BrowsePage.test.tsx`
- 创建：`frontend/public-web/src/catalog/browseUrl.test.ts`
- 修改：`frontend/public-web/src/catalog/CatalogPage.tsx`
- 修改：`frontend/public-web/src/app/App.tsx`
- 修改：`frontend/public-web/src/styles.css`

- [ ] 先写 URL 单元测试：规范化、去重排序、非法值清理、条件变化重置页码、匿名私密条件移除。
- [ ] 写页面失败测试：facets/目录并行独立失败、标签移除、清除全部、移动抽屉焦点、过期响应保护、空状态、分页后标题焦点。
- [ ] 运行聚焦测试确认失败。
- [ ] 实现纯函数 `parseBrowseUrl`、`buildBrowseUrl`，再实现筛选器和页面；保留已显示目录直到新目录成功，facets 有独立重试状态。
- [ ] 将旧 `CatalogPage` 收敛为共享结果网格/分页边界或移除重复职责，不复制请求和规范化逻辑。
- [ ] 重跑公开前端全部测试与构建并提交 `feat: add URL-driven browse page`。

### 任务 5：跨服务浏览验收

**文件：**
- 修改：`tests/e2e/public.spec.ts`

- [ ] 增加超过 20 条、多个年份/题材、公开/私密混合内容的失败 E2E，验证匿名与登录筛选、稳定排序、分享 URL 和返回恢复。
- [ ] 运行聚焦 E2E 确认失败，再补齐必要的种子辅助函数。
- [ ] 运行完整 Rust、前端、根契约、`npm run test:e2e` 与 `git diff --check`。
- [ ] 提交 `test: cover public browse filters`。
