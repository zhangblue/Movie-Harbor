# 首页继续观看实现计划

> 面向 AI 代理的工作者使用 executing-plans 或 subagent-driven-development 逐任务执行。

**目标**  
登录的普通观影用户可在首页续播当前浏览器中自己看过的公开和私密影片。

**架构**  
会话响应提供稳定用户标识。播放器按用户保存进度，首页复用公开详情接口确认当前可播放内容。

**技术栈**  
Rust、Axum、React、TypeScript、Vitest、Playwright。

**规格**  
[首页继续观看设计](../specs/2026-11-23-home-continue-watching-design.md)

## 约束与审查重点

首页最多显示六张卡片，剧集每部一张。旧进度继续供匿名播放器使用。重点覆盖同名重建、登出时迟到请求、归档或删除、旧存储兼容、自动播放被拒绝。同步维护中文代码注释。

## 任务 1 — 会话提供稳定账号标识

涉及 `backend/src/viewer_auth/{model,routes}.rs`、`frontend/packages/api-client/src/types.ts`、会话契约测试及 `frontend/public-web/src/{app/App.tsx,auth/ViewerContext.ts}`。

- [ ] 先断言普通用户会话 JSON 的 `viewer_id` 等于已认证用户 UUID，同名重建取得不同 ID。运行对应 Rust 测试，确认缺少字段导致失败。
- [ ] 为会话响应增加 `viewer_id: Uuid`，由当前已认证用户填充。共享客户端使用字符串类型。公开站保存此标识，以它判断身份是否切换，并将它随认证状态提供给播放器和首页。更新会话 fixture 和类型契约。
- [ ] 运行 Rust fmt、Clippy、相关真实 PostgreSQL 测试及 API 客户端测试。

## 任务 2 — 按账号积累进度

涉及 `frontend/public-web/src/player/{progressStore.ts,progressStore.test.ts,VideoPlayer.tsx,PlayerPage.tsx,PlayerPage.test.tsx}`。

- [ ] 添加失败测试，验证 A、B 与匿名的进度互不可见，账号首次登录不读取旧匿名进度，未播放的选集不覆盖首页可续播记录。
- [ ] 为现有存储函数增加可选账号作用域，保留匿名存储键。单集进度额外记录所属剧集 ID。新增 `listContinueWatching(viewerId: string, storage?: Storage)`，返回带更新时间与进度的电影和单集候选，按时间倒序，每部剧取最新有进度的单集。
- [ ] 按账号身份重新挂载播放器。卸载时仍将旧播放器的位置写入它原本的作用域。普通播放入口保留原有续播提示。
- [ ] 运行公开站播放器测试。

## 任务 3 — 首页卡片与直达续播

涉及 `frontend/public-web/src/catalog/{CatalogPage.tsx,ContinueWatching.tsx,ContinueWatching.test.tsx}` 及播放器路由。

- [ ] 添加失败测试，断言登录后可见公开与私密卡片，匿名无区块，详情失败或视频不可用被跳过，登出或换号时旧请求不能恢复旧卡片，剧集链接指向保存的单集。
- [ ] 在无筛选首页挂载按账号隔离的区块。调用现有电影、剧集详情接口，顺序核对候选，直到收集六个可播放条目或候选耗尽。复用剧集选集排序及现有详情权限边界。每次身份代次变化或卸载时停止接收旧结果。
- [ ] 首页卡片链接携带 `resume=1`。播放页仅在已登录且当前账号有该影片或单集进度时自动定位并尝试播放，播放被拒绝时保留定位。补充播放器失败优先测试。
- [ ] 更新 README 并添加隔离 E2E，验证公开与私密电影及剧集续播和退出后隐藏。运行受影响 workspace 测试与构建、文档契约、`npm run test:e2e` 和 `git diff --check`。
