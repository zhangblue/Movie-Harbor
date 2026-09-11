# Movie Harbor 项目协作约定

## 当前阶段

项目已完成需求设计、UI Demo 和实现计划，生产代码尚未开始。开始实现前必须先阅读：

- `docs/superpowers/specs/2026-09-11-self-hosted-media-library-design.md`
- `docs/superpowers/plans/2026-09-11-self-hosted-media-library-implementation.md`

`demo/` 是已通过用户审核的视觉与交互参考。实现生产页面时应保持其信息层级、深色主题、紧凑表单和操作按钮布局，但不要把 Demo 的原生 DOM 代码直接当作生产架构。

## 技术栈

- 公开站：React、Vite、TypeScript。
- 管理后台：React、Vite、TypeScript，与公开站独立构建。
- 后端：Rust、Axum。
- 数据访问：SeaORM、PostgreSQL。
- 异步运行时与异步文件操作：Tokio。
- 部署：Docker Compose；同一域名下暴露 `/`、`/admin`、`/api` 和 `/media`。

使用库、框架、SDK、API 或 CLI 前，必须先通过 Context7 查询当前官方文档。优先采用稳定版本，除非任务明确要求预览版或候选版本。

## 预期目录边界

- `frontend/public-web/`：公开浏览、搜索、详情和播放。
- `frontend/admin-web/`：认证、内容管理、题材配置和系统设置。
- `frontend/packages/api-client/`：共享 API 类型与请求封装。
- `frontend/packages/ui/`：共享主题和基础交互组件。
- `backend/`：Axum API、SeaORM entities、迁移与后端测试。
- `demo/`：审核通过的静态 UI Demo，不参与生产构建。
- `docs/superpowers/specs/`：已确认的产品设计。
- `docs/superpowers/plans/`：逐任务实现计划。

## 领域约束

- 首版内容形态固定为电影和剧集。
- 剧集层级是“剧集 → 季 → 集”；季只保存季序号，单集名称必须由管理员输入。
- 电影、剧集和单集拥有草稿、已发布、已归档状态；只有草稿允许编辑。
- 已发布内容必须先归档，才能转回草稿或永久删除。
- 不设回收站，永久删除不可恢复。
- 已发布剧集允许新增季和草稿单集，但剧集自身保持只读。
- 有已发布单集的季不可修改季序号或删除。
- 公开 API 只能返回有效发布内容；草稿和归档内容对访客表现为不存在。
- 视频不自动转码，只接受浏览器可直接播放的文件；首版不管理外挂字幕。
- 媒体文件保存在挂载目录，数据库只保存受控文件标识和元数据。
- 发布后的媒体 URL 是公开地址，不承诺防下载或防盗链。

## 开发工作流

- 按实现计划中的任务顺序推进，每个任务形成可独立测试和审查的交付物。
- 新功能、修复和行为变更必须先编写失败测试，确认失败原因后再实现最少代码。
- 后端路由测试优先使用 `Router::oneshot`；事务、迁移和约束测试使用真实 PostgreSQL。
- 文件上传必须使用 Tokio 流式写入临时文件，校验成功后原子替换，禁止把大视频完整载入内存。
- 状态转换和删除约束必须在后端执行，不能只依赖前端隐藏按钮。
- 保持公开站、管理后台和后端 API 边界清晰，不跨目录复制业务逻辑。
- 不实现设计规格明确列出的首版非目标。
- 不要修改或删除与当前任务无关的用户文件。

## 完成前验证

根据变更范围运行相关命令；声称完成前必须读取并确认最新输出：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm test --workspaces
npm run build --workspaces
```

涉及跨服务流程或部署时，还必须运行计划中的 Docker Compose 和 Playwright 端到端测试。当前生产工程尚未初始化时，不要伪称上述命令已经可用或通过。
