# 公开站会话重新发现实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让已转为匿名的公开站页面在 focus/visibility 时发现浏览器中新写入的普通用户会话，同时不增加匿名资源错误的会话请求。

**架构：** 给 App 内部 `validate` 增加仅供 focus/visibility 使用的匿名发现选项；普通调用保持原语义。匿名发现的 401 和网络错误静默保留匿名状态，成功响应继续走现有 generation 保护和 `acceptSession`。

**技术栈：** React、TypeScript、Vitest、Testing Library、Playwright。

---

依据：`../specs/2026-11-01-viewer-session-rediscovery-design.md`。

## 文件结构

- 修改 `frontend/public-web/src/app/App.tsx`：区分普通会话校验与 focus/visibility 匿名发现。
- 修改 `frontend/public-web/src/auth/ViewerAuth.test.tsx`：增加稳定竞态回归与匿名错误行为测试。
- 验证 `tests/e2e/public.spec.ts`：不修改现有 late logout/password 场景，使用它们证明真实跨请求行为。

### 任务 1：实现匿名会话重新发现

**文件：**
- 修改：`frontend/public-web/src/auth/ViewerAuth.test.tsx`
- 修改：`frontend/public-web/src/app/App.tsx`

- [ ] 先增加单元测试：登录 Summer，模拟私密海报失败和 `/session` 401 使页面转匿名；随后把 fixture 切换为 Winter 并触发 focus，期望发出新的 session 请求、显示 Winter 且不再显示登录按钮。生产代码修改前运行该测试，确认因匿名短路而 RED。
- [ ] 增加匿名 focus 收到 401 与网络错误的测试，断言保持登录按钮且不显示“登录已失效”或临时错误提示；增加匿名媒体 error 不新增 session 请求的回归断言。
- [ ] 给 `validate` 增加内部可选参数 `discoverAnonymous = false`。只有状态为 authenticated，或参数为 true 且状态为 anonymous 时发请求；记录请求开始状态。401 仅在请求开始状态为 authenticated 时调用 `expire()`；匿名请求的 401/网络错误静默返回 false。继续使用 identity generation 和 `validation.current`。
- [ ] focus/visible 调用 `validate(true)`；其他调用不传参数。
- [ ] 运行：`npm test --workspace @movie-harbor/public-web`。预期全部通过。
- [ ] 运行：`npm run build --workspace @movie-harbor/public-web` 与 `git diff --check`。预期通过。
- [ ] 提交：`git commit -m "fix: rediscover viewer session after external login"`。

### 任务 2：完整回归验收

**文件：**
- 验证：`tests/e2e/public.spec.ts`
- 不修改生产或测试文件；失败时保存 trace 并返回诊断

- [ ] 运行公开站测试与构建的最新结果。
- [ ] 运行完整 `npm run test:e2e`，要求全部 Playwright 项和 persistence 阶段通过。
- [ ] 运行 `node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs` 和 `git diff --check`。
- [ ] 确认工作区只有已提交任务文件，验收产物位于 Git 忽略目录。
