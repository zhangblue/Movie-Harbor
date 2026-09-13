# Movie Harbor 项目文档同步实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不改动产品代码或既有文档结构的前提下，让根 README 和代理协作约定准确反映已完成的生产应用、宿主目录映射、媒体所有权与半离线发布能力。

**架构：** 保留 `README.md` 面向部署者和首次进入仓库者的入口职责，只补齐状态、权威链接和目录说明；保留 `AGENTS.md` 面向开发代理的工程约束职责，只替换失效事实并补齐当前边界与验证命令。两个文件由不同的全新子 agent 分别修改、验证和提交，集成者最后只做跨文件事实与范围审查。

**技术栈：** Markdown、Git、ripgrep、POSIX shell、仓库现有 Docker Compose、Cargo、npm 与 Node.js 命令。

---

## 文件结构

- 修改：`README.md`，同步项目状态，增加半离线设计与计划入口，并说明 `tools/` 和 `dist/offline/`。
- 修改：`AGENTS.md`，同步当前工程事实、实际目录、媒体与存储边界、半离线限制和完整验证命令。

## 执行责任与范围护栏

- 任务 1 必须调度一个全新子 agent；该 agent 只允许修改并提交 `README.md`。
- 任务 2 必须调度另一个全新子 agent；不得复用任务 1 的 agent；该 agent 只允许修改并提交 `AGENTS.md`。
- 每个任务开始时工作树必须干净，结束时必须先检查暂存区文件清单，再各自创建一个提交。
- 任一任务审查发现问题时，只交回该任务对应的文件执行者修正；不得让一个实现 agent 代改另一个文件。
- 集成者不新增第三个实现任务，只在两个提交完成后执行本文末尾的计划级验收；若必须修正文案，先明确归属并交回对应 agent 做最小修正。

### 任务 1：同步 README 项目入口

**文件：**
- 修改：`README.md:5-10`
- 修改：`README.md:30-34`
- 修改：`README.md:182-192`

- [ ] **步骤 1：调度独立执行者并锁定单文件范围**

为任务 1 调度一个此前未参与本计划实现的全新子 agent，把本任务全文交给它，并明确禁止修改 `AGENTS.md`、产品代码、配置、测试、规格和计划。执行者先运行：

```bash
git status --short
git diff --name-only HEAD
```

预期：两条命令都没有输出；若有输出，停止任务并由集成者确认来源，不覆盖现有改动。

- [ ] **步骤 2：用当前文本证明 README 的精确缺口**

运行：

```bash
rg -n --fixed-strings -- '- 生产代码：已实现，可通过 Docker Compose 自托管。' README.md
rg -n --fixed-strings 'docs/superpowers/specs/2026-09-12-offline-application-image-bundle-design.md' README.md
rg -n --fixed-strings 'docs/superpowers/plans/2026-09-12-offline-application-image-bundle.md' README.md
rg -n '^tools/ +半离线发布包构建入口与核心工具$' README.md
rg -n '^dist/offline/ +构建生成且被 Git 忽略的半离线归档输出目录$' README.md
```

预期：第一条命令命中且退出码为 0，证明当前状态已经正确；其余四条命令均无输出且退出码为 1，分别证明两条权威文档入口和两个目录说明尚未写入。纯文档同步不人为创建测试文件，这四个失败的内容契约就是修改前证据。

- [ ] **步骤 3：补充两条半离线权威文档入口**

保留“项目文档”现有三项及其顺序，在“实现计划”和“协作约定”之间增加且只增加：

```markdown
- [半离线发布包设计](docs/superpowers/specs/2026-09-12-offline-application-image-bundle-design.md)
- [半离线发布包实现计划](docs/superpowers/plans/2026-09-12-offline-application-image-bundle.md)
```

不把半离线文档内容复制进该列表，不修改后文现有“半离线发布包”操作说明。

- [ ] **步骤 4：补充两个实际目录说明**

保留“目录结构”代码块的既有条目与顺序，在 `docs/superpowers/` 之前增加：

```text
tools/                      半离线发布包构建入口与核心工具
dist/offline/               构建生成且被 Git 忽略的半离线归档输出目录
```

保持“当前状态”的四条既有内容不变；不重排或压缩生产部署、媒体安全、同步删除、宿主目录映射、半离线包、测试和 Demo 章节。

- [ ] **步骤 5：验证链接、目录事实和单文件 diff**

运行：

```bash
test "$(rg -c --fixed-strings -- '- 生产代码：已实现，可通过 Docker Compose 自托管。' README.md)" -eq 1
test "$(rg -c --fixed-strings 'docs/superpowers/specs/2026-09-12-offline-application-image-bundle-design.md' README.md)" -eq 1
test "$(rg -c --fixed-strings 'docs/superpowers/plans/2026-09-12-offline-application-image-bundle.md' README.md)" -eq 1
test -f docs/superpowers/specs/2026-09-12-offline-application-image-bundle-design.md
test -f docs/superpowers/plans/2026-09-12-offline-application-image-bundle.md
test -x tools/build-offline-package.sh
test -f tools/offline-package.mjs
rg -n --fixed-strings '/dist/offline/' .gitignore
rg -n '^tools/ +半离线发布包构建入口与核心工具$' README.md
rg -n '^dist/offline/ +构建生成且被 Git 忽略的半离线归档输出目录$' README.md
git diff --check -- README.md
test "$(git diff --name-only HEAD)" = 'README.md'
```

预期：全部退出码为 0；两条链接目标存在，工具入口可执行，核心工具存在，`.gitignore` 忽略输出目录，README 中每项只出现一次，diff 只包含 `README.md` 且没有空白错误。

- [ ] **步骤 6：审查局部改动并提交任务 1**

运行：

```bash
git diff -- README.md
git add README.md
git diff --cached --name-only
git diff --cached --check
git commit -m "docs: 补齐 README 半离线文档入口"
```

预期：人工阅读 diff 确认只新增两条项目文档链接和两个目录条目，“当前状态”保持正确；暂存清单仅为 `README.md`；检查通过并生成标题为 `docs: 补齐 README 半离线文档入口` 的独立提交，提交后 `git status --short` 无输出。

### 任务 2：同步 AGENTS 工程约定

**文件：**
- 修改：`AGENTS.md:3-10`
- 修改：`AGENTS.md:23-32`
- 修改：`AGENTS.md:34-46`
- 修改：`AGENTS.md:59-71`

- [ ] **步骤 1：调度不同的全新执行者并锁定单文件范围**

为任务 2 调度另一个全新子 agent，把本任务全文交给它；明确该 agent 不能是任务 1 的执行者，且只允许修改 `AGENTS.md`。执行者先运行：

```bash
git status --short
git log -1 --format='%h %s'
```

预期：工作树无输出；最新提交是任务 1 的 `docs: 补齐 README 半离线文档入口`，证明两个任务顺序执行且任务 1 已封装为独立交付物。

- [ ] **步骤 2：用旧表述和缺失契约证明 AGENTS 的当前缺口**

运行：

```bash
rg -n --fixed-strings '生产代码尚未开始' AGENTS.md
rg -n --fixed-strings '## 预期目录边界' AGENTS.md
rg -n --fixed-strings '当前生产工程尚未初始化时' AGENTS.md
rg -n --fixed-strings 'docker compose -f docker-compose.test.yml up -d postgres' AGENTS.md
rg -n --fixed-strings "TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace" AGENTS.md
rg -n --fixed-strings 'node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs' AGENTS.md
```

预期：前三条均命中并退出 0，证明阶段、目录标题和尾注仍失效；后三条均无输出且退出 1，证明测试数据库启动、带正确连接串的 Rust 测试和根 Node 契约测试尚未进入完整命令集。

- [ ] **步骤 3：更新当前阶段和权威文档优先级**

把“当前阶段”首段改为明确陈述：需求设计、UI Demo、主实现计划、生产应用、Docker Compose 部署和半离线发布工具均已完成；任何变更前都必须阅读主设计与主实现计划。保留现有两条主文档路径，并在其后按以下顺序增加增量设计与对应计划：

```markdown
- `docs/superpowers/specs/2026-09-12-media-ownership-and-publishing-design.md`
- `docs/superpowers/plans/2026-09-12-media-ownership-and-publishing.md`
- `docs/superpowers/specs/2026-09-12-host-data-bind-mounts-design.md`
- `docs/superpowers/plans/2026-09-12-host-data-bind-mounts-implementation.md`
- `docs/superpowers/specs/2026-09-12-offline-application-image-bundle-design.md`
- `docs/superpowers/plans/2026-09-12-offline-application-image-bundle.md`
```

紧接列表写明：当前实现与日期较新的增量规格覆盖主规格中的旧约定，发生冲突时以前两者为准。保留 Demo 的视觉参考说明，不把 AGENTS 扩写成部署操作手册。

- [ ] **步骤 4：把预期目录替换为实际目录边界**

将标题改为 `## 实际目录边界`，以逐项列表准确说明以下目录，不合并缺少独立职责的条目：

```text
frontend/public-web/              公开浏览、搜索、详情和播放
frontend/admin-web/               认证、内容管理、题材配置和系统设置
frontend/packages/api-client/     共享 API 类型与请求封装
frontend/packages/ui/             共享主题和基础交互组件
backend/                          Axum API、SeaORM entities 与后端测试
backend/migration/                SeaORM 数据库迁移
tests/                            根 Node 契约测试
tests/e2e/                        Playwright 跨服务验收与安全 runner
tools/                            半离线发布包构建入口与核心工具
dist/offline/                     构建生成且被 Git 忽略的半离线归档输出
demo/                             已审核且不参与生产构建的静态 UI Demo
docs/superpowers/specs/           已确认的产品与增量设计
docs/superpowers/plans/           逐任务实现计划
```

文档中的目录名称必须保留反引号；`dist/offline/` 是工具运行后创建的输出路径，不把它误写成 tracked 源码目录。

- [ ] **步骤 5：补充媒体同步处理和启动恢复约束**

保留现有生命周期、公开可见性、格式和公开 URL 条目，在“领域约束”中补充明确规则：

- 媒体资产在电影海报、电影视频、剧集海报和单集视频槽位之间全局独占，不能共享。
- 删除电影、剧集、季或单集以及替换媒体时，成功响应前必须同步移除对应数据库记录和物理文件。
- 系统不运行周期媒体垃圾回收；启动恢复只处理带持久清单的中断删除或替换，不扫描并删除任意孤立文件。

不得写回共享媒体、周期清理队列或成功响应后异步删除旧文件的旧行为。

- [ ] **步骤 6：补充宿主映射和半离线边界**

在领域约束之后增加两个紧凑小节。

“宿主数据目录”必须逐项写明：

- `DATABASE_HOST_DIR` 默认 `./data/postgres`，映射 PostgreSQL 的 `/var/lib/postgresql/data`。
- `MEDIA_HOST_DIR` 默认 `./data/media`，同时映射 API 的 `/media` 和 Caddy 的只读 `/srv/media`。
- 数据库与媒体目录必须作为同一一致性备份集；从既有命名卷部署切换到 bind mount 不会自动迁移数据。

“半离线发布边界”必须逐项写明：

- 首版只支持 `linux/arm64`。
- 归档只内置 API、公开站、管理后台三个自研运行镜像。
- 目标机仍须从 Docker Hub 获取固定版本 `postgres:17-alpine`、`caddy:2.10-alpine` 和 `alpine:3.22`。
- 包不包含源码、真实 `.env`、凭据、数据库或媒体数据。
- 输出固定在被 Git 忽略的 `dist/offline/`，构建工具拒绝覆盖同名产物。

不增加完全断网、额外平台、镜像签名、自动上传或发布流水线承诺。

- [ ] **步骤 7：用仓库当前完整命令集替换验证段**

保留“按变更范围执行相关子集”的原则，同时明确只有运行并读取整组命令的最新输出后才能声称完整交付通过。代码块必须逐字为：

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

代码块后明确说明：E2E runner 自行创建隔离的 Compose 项目和数据目录，不得改用生产默认的 `data/postgres` 或 `data/media`；不要在文档中加入固定的数据库测试服务强制清理命令，以免误伤并行任务。删除“当前生产工程尚未初始化”的失效尾注。

- [ ] **步骤 8：验证文档目标、仓库事实和单文件 diff**

运行：

```bash
if rg -n '生产代码尚未开始|当前生产工程尚未初始化时|## 预期目录边界|共享媒体|周期清理队列|异步删除旧文件' AGENTS.md; then exit 1; fi
rg -n --fixed-strings '## 实际目录边界' AGENTS.md
rg -n --fixed-strings 'DATABASE_HOST_DIR' AGENTS.md
rg -n --fixed-strings '/var/lib/postgresql/data' AGENTS.md
rg -n --fixed-strings 'MEDIA_HOST_DIR' AGENTS.md
rg -n --fixed-strings '/srv/media' AGENTS.md
rg -n --fixed-strings 'linux/arm64' AGENTS.md
rg -n --fixed-strings 'postgres:17-alpine' AGENTS.md
rg -n --fixed-strings 'caddy:2.10-alpine' AGENTS.md
rg -n --fixed-strings 'alpine:3.22' AGENTS.md
rg -n --fixed-strings 'docker compose -f docker-compose.test.yml up -d postgres' AGENTS.md
rg -n --fixed-strings "TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace" AGENTS.md
rg -n --fixed-strings 'node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs' AGENTS.md
rg -n --fixed-strings 'npm run test:e2e' AGENTS.md
for repo_path in frontend/public-web frontend/admin-web frontend/packages/api-client frontend/packages/ui backend backend/migration tests tests/e2e tools demo docs/superpowers/specs docs/superpowers/plans; do test -d "$repo_path" || exit 1; done
for doc_path in $(rg -o 'docs/superpowers/(specs|plans)/[^`)]+' AGENTS.md | sort -u); do test -f "$doc_path" || exit 1; done
rg -n --fixed-strings 'source: ${DATABASE_HOST_DIR:-./data/postgres}' docker-compose.yml
rg -n --fixed-strings 'source: ${MEDIA_HOST_DIR:-./data/media}' docker-compose.yml
rg -n --fixed-strings '"127.0.0.1:55432:5432"' docker-compose.test.yml
rg -n --fixed-strings 'members = ["backend", "backend/migration"]' Cargo.toml
rg -n --fixed-strings '/dist/offline/' .gitignore
node -e 'const p=require("./package.json"); if (p.scripts.test!=="npm test --workspaces" || p.scripts.build!=="npm run build --workspaces" || p.scripts["test:e2e"]!=="node tests/e2e/run.mjs") process.exit(1)'
git diff --check -- AGENTS.md
test "$(git diff --name-only HEAD)" = 'AGENTS.md'
```

预期：全部退出码为 0；失效与废弃表述均未命中，所有记录的源码目录和文档目标存在，`dist/offline/` 的忽略规则存在，Compose 挂载源与 npm 脚本和文档一致，diff 只包含 `AGENTS.md` 且没有空白错误。

- [ ] **步骤 9：审查保留项并提交任务 2**

运行：

```bash
git diff -- AGENTS.md
git add AGENTS.md
git diff --cached --name-only
git diff --cached --check
git commit -m "docs: 同步 AGENTS 工程事实与验证约定"
```

预期：人工阅读确认既有内容生命周期、可见性、Tokio 流式上传、后端状态约束、TDD、跨目录边界和首版非目标仍保留；暂存清单仅为 `AGENTS.md`；检查通过并生成标题为 `docs: 同步 AGENTS 工程事实与验证约定` 的独立提交，提交后 `git status --short` 无输出。

## 计划级验收

两个实现提交完成后，由集成者运行以下命令；这些检查不构成第三个实现任务：

```bash
git log -2 --format='%h %s'
test "$(git diff --name-only HEAD~2..HEAD)" = $'AGENTS.md\nREADME.md'
git diff --check HEAD~2..HEAD
for doc_path in docs/superpowers/specs/2026-09-11-self-hosted-media-library-design.md docs/superpowers/plans/2026-09-11-self-hosted-media-library-implementation.md docs/superpowers/specs/2026-09-12-media-ownership-and-publishing-design.md docs/superpowers/plans/2026-09-12-media-ownership-and-publishing.md docs/superpowers/specs/2026-09-12-host-data-bind-mounts-design.md docs/superpowers/plans/2026-09-12-host-data-bind-mounts-implementation.md docs/superpowers/specs/2026-09-12-offline-application-image-bundle-design.md docs/superpowers/plans/2026-09-12-offline-application-image-bundle.md; do test -f "$doc_path" || exit 1; done
if rg -n '生产代码尚未开始|当前生产工程尚未初始化时|共享媒体|成功响应后.*异步' README.md AGENTS.md; then exit 1; fi
if rg -n '周期清理队列' AGENTS.md; then exit 1; fi
rg -n --fixed-strings '迁移 v5 会把媒体所有权改为全局独占，并移除旧的 `file_cleanup_job` 周期清理队列。' README.md
if rg -n 'T[D]O|待[定]|后续实[现]|补充细[节]|类似任[务]' README.md AGENTS.md; then exit 1; fi
git status --short
```

预期：最近两条提交分别是两个任务约定的标题；相对执行前基线的总 diff 只含 `AGENTS.md` 和 `README.md`；所有权威文档存在；两份入口文档均无失效、矛盾或未完成表述，且 `AGENTS.md` 不把周期清理队列描述为当前行为；README 保留“迁移 v5 移除旧 `file_cleanup_job` 周期清理队列”的历史升级警告；diff 检查通过；工作树干净。若任一检查失败，不合并或推送，先把问题交回对应文件的执行者修正并重新运行全部计划级验收。
