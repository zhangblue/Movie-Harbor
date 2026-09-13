# Movie Harbor 项目文档同步设计规格

日期：2026-09-13

## 1. 背景与目标

Movie Harbor 的生产应用、宿主机数据目录映射和半离线发布工具均已实现，但根目录两份入口文档尚未完全同步：`README.md` 已包含主要部署信息，却缺少离线发布文档入口以及 `tools/`、`dist/offline/` 的目录说明；`AGENTS.md` 仍称生产代码尚未开始，并保留了过时的预期目录和不完整的验证命令。

本次采用已确认的“针对性同步”方案：保留两份文件的现有结构和有效内容，只修正失效事实、补齐缺失入口，并使面向使用者与面向开发代理的信息边界清晰。完成后对改动进行独立审查，通过后合并到 `main` 并推送 GitHub。

## 2. 范围

除新增本设计规格外，后续实现只修改根目录的：

- `README.md`
- `AGENTS.md`

两份入口文档的修改必须是局部增补或替换，不重写全文，不调整与同步目标无关的章节，也不改动产品行为、生产代码、测试、部署配置、既有设计规格或实现计划。

## 3. 文档职责

### 3.1 README.md

`README.md` 面向部署者、使用者和首次进入仓库的开发者，负责说明项目是什么、当前能做什么、如何运行与部署、数据和安全边界、半离线包如何生成与使用，以及从哪里继续阅读权威文档。

本次具体改动：

1. 保留“当前状态”既有结构，并确认其明确表达产品设计、UI Demo、实现计划和生产代码均已完成，生产代码可通过 Docker Compose 自托管。
2. 在“项目文档”中补充半离线发布包的设计规格与实现计划链接，不复制这两份文档的详细内容。
3. 在“目录结构”中补充：
   - `tools/`：半离线发布包构建入口与核心工具。
   - `dist/offline/`：构建生成且被 Git 忽略的半离线归档输出目录。
4. 保留现有生产部署、媒体安全、同步删除、宿主目录映射、半离线包、测试和 Demo 说明；除修复与新增内容直接冲突的表述外，不重排或压缩这些章节。

### 3.2 AGENTS.md

`AGENTS.md` 面向后续开发代理和贡献者，负责给出当前工程事实、代码边界、不可破坏的领域约束、开发方式和完成前必须执行的验证命令。它不承担面向最终部署者的完整操作手册职责。

本次具体改动：

1. 将“生产代码尚未开始”更新为生产应用、Compose 部署和半离线发布工具均已实现；继续要求变更前阅读主设计、主实现计划，并增加会覆盖旧约定的后续增量设计与计划入口。
2. 将“预期目录边界”改为“实际目录边界”，至少准确覆盖：
   - `frontend/public-web/`、`frontend/admin-web/`
   - `frontend/packages/api-client/`、`frontend/packages/ui/`
   - `backend/` 与 `backend/migration/`
   - `tests/e2e/`、根目录 `tests/`
   - `tools/`、`dist/offline/`
   - `demo/`、`docs/superpowers/specs/`、`docs/superpowers/plans/`
3. 保留既有生命周期、可见性、上传、TDD 和跨目录边界约束，并补充当前媒体文件规则：媒体资产按电影海报、电影视频、剧集海报或单集视频槽位全局独占；删除电影、剧集、季或单集，以及替换媒体时，成功响应前同步移除对应数据库记录和物理文件；不运行周期垃圾回收，启动恢复只处理带持久清单的中断操作。
4. 补充宿主目录映射：`DATABASE_HOST_DIR` 映射 PostgreSQL 的 `/var/lib/postgresql/data`；`MEDIA_HOST_DIR` 同时映射 API 的 `/media` 和 Caddy 的只读 `/srv/media`；默认值分别为 `./data/postgres` 和 `./data/media`。数据库与媒体目录必须作为同一一致性备份集，改用既有命名卷的部署不会自动迁移。
5. 补充半离线包约束：首版只支持 `linux/arm64`；归档只包含 API、公开站、管理后台三个自研运行镜像；目标机仍需从 Docker Hub 获取固定版本的 PostgreSQL、Caddy 和 Alpine 镜像；包不包含源码、真实 `.env`、凭据、数据库或媒体数据；输出固定在被 Git 忽略的 `dist/offline/`，不得覆盖同名产物。
6. 将“完成前验证”更新为仓库当前可执行的完整命令集：

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

   文档同时说明按变更范围执行相关子集，但声称完整交付通过时必须执行整组命令；E2E runner 自行创建隔离 Compose 项目和数据目录，不得改用生产默认数据目录。数据库测试服务的停止不写入固定的强制清理命令，避免误伤其他并行任务。

## 4. 事实来源与优先级

文案必须由以下来源交叉核对：

1. 当前仓库中的实际目录、`package.json`、Cargo workspace、`docker-compose.yml`、`docker-compose.test.yml`、`.env.example`、`tools/` 和测试 runner，是命令、路径与已实现状态的首要事实来源。
2. `docs/superpowers/specs/2026-09-12-offline-application-image-bundle-design.md` 与 `docs/superpowers/plans/2026-09-12-offline-application-image-bundle.md`，用于半离线模式、平台、归档内容和安全边界。
3. `docs/superpowers/specs/2026-09-12-media-ownership-and-publishing-design.md` 及对应实现计划，用于媒体独占、同步删除/替换和启动恢复；这些增量约定覆盖主规格中的共享媒体、周期清理队列和异步删除旧描述。
4. `docs/superpowers/specs/2026-09-12-host-data-bind-mounts-design.md` 及对应实现计划，用于宿主目录变量、容器挂载点和迁移边界。
5. `docs/superpowers/specs/2026-09-11-self-hosted-media-library-design.md` 与 `docs/superpowers/plans/2026-09-11-self-hosted-media-library-implementation.md`，用于仍有效的产品、架构、领域和开发工作流基线。

来源冲突时，当前实现与较新的增量规格优先；不得为了与旧文档字面一致而恢复已经废弃的行为。

## 5. 非目标

- 不把 README 改造成完整运维手册，也不把 AGENTS 改造成 README 的副本。
- 不重写现有章节、统一全文措辞或顺手修订无关文案。
- 不改变应用功能、接口、数据模型、Compose 拓扑、发布包格式或测试行为。
- 不新增平台支持、完全断网包、镜像签名、自动上传或发布流水线。
- 不修改、补写或生成实现计划。
- 不在本次文档同步中生成真实 `dist/offline/` 归档。

## 6. 实现 Task 边界

### Task 1：同步 README.md

由一个独立子 agent 只修改 `README.md`。其范围限于当前状态核对、离线设计/计划链接和 `tools/`、`dist/offline/` 目录说明。不得修改 `AGENTS.md` 或其他 tracked 文件。

### Task 2：同步 AGENTS.md

由另一个独立子 agent 只修改 `AGENTS.md`。其范围限于当前阶段、实际目录边界、媒体同步删除、宿主目录映射、半离线包约束和完整验证命令。必须保留既有领域约束与 TDD 规则，不得修改 `README.md` 或其他 tracked 文件。

两个 Task 的执行者必须不同。两者完成后由集成者统一检查事实一致性和 diff，不允许任一实现子 agent 跨文件代改。审查发现的问题由对应文件的 Task 执行者修正，或由集成者在明确归属后做最小修正。

## 7. 审查、合并与发布

1. 在功能分支上完成两个文件的独立实现和验证。
2. 审查仅关注文档事实准确性、增量规格优先级、命令可执行性、两文件职责分离和范围控制。
3. 审查通过且工作树只包含预期文档改动后，将功能分支合并到 `main`。
4. 合并后再次确认 `main` 状态与提交内容，再推送至 GitHub；不得在审查失败或存在无关改动时推送。

## 8. 验证标准

- `README.md` 的当前状态与仓库实现一致，项目文档含半离线设计和计划链接，目录结构含 `tools/` 与 `dist/offline/`。
- `AGENTS.md` 不再出现“生产代码尚未开始”或“工程尚未初始化”等失效表述，目录名称与仓库实际结构一致。
- `AGENTS.md` 的媒体规则不再描述共享媒体、周期清理任务或成功响应后的异步文件清理。
- 宿主目录变量、容器目标路径、默认路径和半离线包边界与 Compose、工具及增量规格一致。
- 完整验证命令包含测试 PostgreSQL 启动、Rust 格式与 lint、带正确 `TEST_DATABASE_URL` 的 Rust 测试、前端测试与构建、根 Node 契约测试、Playwright E2E 和 `git diff --check`。
- 两个实现 Task 的最终 diff 各自只触及获准文件；相对本规格提交的实现总 diff 不包含产品代码、配置、测试、规格或计划改动。
- Markdown 链接目标存在，代码块可复制，全文没有未完成标记、占位内容、互相矛盾或可被两种方式理解的要求。
