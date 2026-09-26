# 开发指南

本文说明源码环境、测试与构建、E2E 隔离与清理、UI Demo 和项目目录。

[返回项目 README](../../README.md)

## 开发与验收

源码开发需要 Rust stable（支持 Rust 2024 edition）、Node.js 24、npm、Docker Engine 和 Docker Compose v2。首次进入仓库先安装前端依赖并启动隔离测试数据库：

```bash
npm install
docker compose -f docker-compose.test.yml up -d postgres
```

单元测试与构建：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test cargo test --workspace
npm test --workspaces
npm run build --workspaces
```

旧版测试曾在中断时遗留按测试套件命名的 schema。确认没有 Movie Harbor 测试正在运行后，可用 `psql "$TEST_DATABASE_URL" -f backend/tests/cleanup_test_schemas.sql` 仅清理本项目已知前缀的遗留 schema；脚本不会匹配其他项目或普通业务 schema。

完整 E2E 会为每次运行生成以 `mh-task15-e2e-` 开头的唯一 Compose 项目名，并在被忽略的 `tests/e2e/.generated/runs/` 下创建带所有权标记的唯一运行目录。该目录内的 PostgreSQL 与媒体子目录会被显式传给 Compose 和 Playwright；验证生命周期与持久化后，runner 先正常停止该轮服务，再用只挂载这两个已验证 bind 目录的临时 root 容器清空容器属主文件。该步骤成功后才会 down 精确项目，并由宿主重新验证所有权标记和路径后删除已清空的本轮目录。测试不会读取或修改生产默认的 `data/postgres` 和 `data/media`；若容器内清理失败，runner 会保留已停止的项目与目录并明确报错，不会尝试宿主权限兜底。

```bash
npx playwright install chromium
npm run test:e2e
```

设置 `E2E_KEEP=1` 可在失败后跳过全部清理，保留隔离容器和本轮目录供排查；runner 会在终端打印本轮的完整项目名、绝对运行目录、媒体目录和数据库目录。人工收尾时也必须遵循 runner 的顺序：先停止该精确项目，再用临时 root 容器只挂载并清空输出中的媒体和数据库目录、恢复宿主权限，成功后才 down 项目并删除对应的本轮运行目录。不要先 down 后直接用宿主递归删除容器属主目录，也不要把生产默认目录传给清理容器。

## 查看 UI Demo

Demo 使用模拟数据，用于审核访客首页、管理后台和添加剧集页面，不连接真实后端。

在项目根目录执行：

```bash
python3 -m http.server 4173 --directory demo --bind 127.0.0.1
```

服务启动后，可访问以下页面：

- 访客首页：http://127.0.0.1:4173/?view=home
- 管理后台：http://127.0.0.1:4173/?view=admin
- 添加剧集：http://127.0.0.1:4173/?view=series-editor

停止服务时，在运行服务的终端按 `Ctrl+C`。

如果 `4173` 端口已被占用，可以更换端口，例如：

```bash
python3 -m http.server 4174 --directory demo --bind 127.0.0.1
```

此时将访问地址中的端口同步改为 `4174`。

## 目录结构

```text
backend/                    Axum API、迁移与后端测试
backend/src/admin_content/  电影与剧集统一管理列表和分页
backend/src/admin_export/   全量内容只读快照与 JSON 导出
backend/src/content.rs      跨内容类型的字段与生命周期基础规则
backend/src/route_params.rs 公共 UUID 路由参数解析
frontend/public-web/        公开 React 应用
frontend/admin-web/         管理后台 React 应用
frontend/packages/          共享 API 客户端与 UI
tests/e2e/                  Playwright 跨服务验收
demo/                       已审核的静态 UI Demo
tools/                      半离线发布包构建入口与核心工具
dist/offline/               构建生成且被 Git 忽略的半离线归档输出目录
docs/superpowers/           产品规格与实现计划
```

数据库结构与迁移说明见[数据库表设计](database-schema.md)。
