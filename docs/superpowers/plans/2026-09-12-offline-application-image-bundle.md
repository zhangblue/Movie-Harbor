# Movie Harbor 半离线 Docker 发布包实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 提供一个可重复执行的工具，为当前 `linux/arm64` Docker 平台生成不含源码、只内置 3 个 Movie Harbor 自研镜像的半离线部署包。

**架构：** 使用一个无第三方 Node 依赖的发布模块集中处理版本、平台、模板、命令执行、白名单与原子产物，再由薄 Shell 入口提供稳定命令。单元/黑盒测试用临时仓库和 Docker CLI 替身隔离外部构建成本，最终任务再使用真实 Docker 构建、导出、导入并启动隔离 Compose 栈。

**技术栈：** Node.js 标准库、POSIX Shell、Docker Engine、Docker Compose v2、Docker image save/load、tar、SHA-256。

---

## 全局约束

- 首版只支持构建机和目标机均为 `linux/arm64` Docker 平台；不实现 `linux/amd64` 或多架构输出。
- `images.tar` 只允许包含 `movie-harbor-api`、`movie-harbor-public-web`、`movie-harbor-admin-web` 三个自研镜像及指定版本标签。
- `postgres:17-alpine`、`alpine:3.22`、`caddy:2.10-alpine` 不打入归档；目标服务器启动时从 Docker Hub 下载。
- 三个自研服务必须设置 `pull_policy: never`，官方镜像保持缺失时拉取的默认行为。
- 发布包固定输出到 `dist/offline/`，不得提供改变输出目录的公开 CLI 参数，也不得覆盖已有同名产物。
- 发布包不得包含源码、`.git`、本地 `.env`、凭据或运行数据；只分发 `.env.example`。
- 外层归档只能包含一个 `movie-harbor/` 根目录以及设计中约定的 7 个文件；所有交付文件（`SHA256SUMS` 自身除外）必须受 SHA-256 校验保护。
- 构建或校验任一步失败都不得发布最终归档，并须清理本次创建的临时文件。

---

## 文件结构

- 创建 `tools/offline-package.mjs`：发布包核心模块和 CLI，负责校验、渲染、构建、导出、检查及原子归档。
- 创建 `tools/build-offline-package.sh`：从任意目录调用核心 CLI 的可执行入口。
- 创建 `tests/offline-package.test.mjs`：模板契约、平台/版本校验、Docker 命令边界、归档白名单和失败清理测试。
- 修改 `.gitignore`：忽略 `dist/offline/` 发布产物。
- 修改 `package.json`：提供 `npm run package:offline` 命令。
- 修改 `README.md`：记录构建机要求、半离线边界、打包和目标服务器部署流程。

### 任务 1：定义部署包模板与纯校验边界

**文件：**
- 创建：`tools/offline-package.mjs`
- 创建：`tests/offline-package.test.mjs`

- [ ] **步骤 1：编写失败的版本、平台和模板行为测试**

测试先导入尚不存在的模块，并用手工字面量断言：

```js
assert.equal(normalizePlatform("linux", "aarch64"), "linux/arm64");
assert.throws(() => normalizePlatform("linux", "x86_64"), /only supports linux\/arm64/);
assert.equal(validateVersion("v1.2.3-rc_1"), "v1.2.3-rc_1");
assert.throws(() => validateVersion("../secret"), /invalid version/);
```

渲染固定版本 `test-v1` 后解析真实 Compose JSON，断言：

- `api`、`public-web`、`admin-web` 精确使用 `movie-harbor-*:<版本>-linux-arm64` 且 `pull_policy` 为 `never`。
- `postgres:17-alpine`、`alpine:3.22`、`caddy:2.10-alpine` 没有 `pull_policy: never`。
- 没有任何 `build`、源码 bind mount 或开发目录。
- 数据 bind、健康检查、依赖关系、环境变量和入口端口与生产 Compose 保持一致。

再断言生成的 `load-images.sh` 会先校验 SHA-256，再 `docker image load -i images.tar`，并检查 3 个精确标签与 `linux/arm64`；生成的部署 README 明确目标机需联网下载官方镜像。

- [ ] **步骤 2：运行测试确认失败**

```bash
node --test tests/offline-package.test.mjs
```

预期：FAIL，`tools/offline-package.mjs` 尚不存在。

- [ ] **步骤 3：实现最小纯函数与模板**

在 `tools/offline-package.mjs` 导出：

```js
export function validateVersion(value) { /* 严格白名单 */ }
export function normalizePlatform(os, architecture) { /* 只接受当前 linux/arm64 */ }
export function imageTags(version) { /* 固定 3 个标签 */ }
export function renderCompose(version) { /* image-only Compose */ }
export function renderLoadScript(version) { /* 校验、导入、inspect */ }
export function renderBundleReadme(version) { /* 半离线部署说明 */ }
```

Compose 中的官方镜像保持固定版本，自研镜像明确 `pull_policy: never`。所有模板均使用传入的已验证版本，不读取本地 `.env`。

- [ ] **步骤 4：运行测试确认通过**

```bash
node --test tests/offline-package.test.mjs
node --test tests/compose-storage.test.mjs tests/ui-demo.test.mjs tests/e2e/run-safety.test.mjs tests/offline-package.test.mjs
```

预期：新增测试与现有 Node 测试全部通过。

- [ ] **步骤 5：提交**

```bash
git add tools/offline-package.mjs tests/offline-package.test.mjs
git commit -m "feat: 定义半离线部署包模板"
```

### 任务 2：实现可测试的构建、导出与原子打包工具

**文件：**
- 修改：`tools/offline-package.mjs`
- 创建：`tools/build-offline-package.sh`
- 修改：`tests/offline-package.test.mjs`
- 修改：`.gitignore`
- 修改：`package.json`

- [ ] **步骤 1：编写失败的黑盒打包测试**

测试在临时目录创建最小仓库 fixture 和可执行 Docker 替身，再通过真实 Shell 入口运行工具。Docker 替身只替换外部 Docker 边界，实际文件生成、tar、SHA-256、归档检查和清理逻辑保持真实。

成功测试断言：

```js
assert.deepEqual(savedTags, [
  "movie-harbor-api:test-v1-linux-arm64",
  "movie-harbor-public-web:test-v1-linux-arm64",
  "movie-harbor-admin-web:test-v1-linux-arm64",
]);
assert.deepEqual(archiveEntries, [
  "movie-harbor/", "movie-harbor/.env.example", "movie-harbor/Caddyfile",
  "movie-harbor/README.md", "movie-harbor/SHA256SUMS",
  "movie-harbor/compose.yml", "movie-harbor/images.tar",
  "movie-harbor/load-images.sh",
]);
```

并验证归档中不存在源码、`.git`、本地 `.env`、数据目录、Dockerfile、官方镜像标签或额外条目；解压后 `SHA256SUMS` 能验证全部允许文件。

失败测试覆盖非法版本、非 `linux/arm64`、Docker/Compose 不可用、同名产物已存在、构建失败、inspect 平台错误、`images.tar` 标签集合错误，以及任一步失败后没有最终包和临时目录残留。

- [ ] **步骤 2：运行黑盒测试确认失败**

```bash
node --test tests/offline-package.test.mjs
```

预期：FAIL，CLI 尚未执行构建、导出和归档。

- [ ] **步骤 3：实现命令编排与安全发布**

核心 CLI：

1. 从模块路径计算仓库根并读取可选版本；默认调用 `git rev-parse --short=12 HEAD`。
2. 检查 `docker info`、`docker compose version` 和当前 `linux/arm64` 平台。
3. 分别使用 3 个现有 Dockerfile 构建精确标签。
4. inspect 每个运行镜像的 OS/Architecture。
5. 在 `mkdtemp` 创建 staging，复制 `Caddyfile` 与 `.env.example`，生成 Compose、加载脚本和部署 README。
6. 只把 `imageTags(version)` 的返回值传给 `docker image save --output images.tar`。
7. 从 `images.tar` 的 `manifest.json` 验证 RepoTags 集合精确相等。
8. 生成除 `SHA256SUMS` 自身外全部交付文件的 SHA-256。
9. 校验 staging 白名单，生成临时外层 tar，再读取归档条目复核。
10. 用排他创建/重命名发布到 `dist/offline/`；已有目标时失败。

`tools/build-offline-package.sh` 只定位自身仓库根并 `exec node tools/offline-package.mjs "$@"`。公开 CLI 只接受零个或一个位置参数（版本）；测试通过在临时目录内复制最小仓库 fixture 来隔离固定的 `dist/offline/` 输出，不为测试增加生产参数。

- [ ] **步骤 4：运行测试确认通过**

```bash
node --test tests/offline-package.test.mjs
node --check tools/offline-package.mjs
sh -n tools/build-offline-package.sh
npm run package:offline -- --help
git diff --check
```

预期：黑盒测试通过；语法、帮助输出和 diff 检查通过。

- [ ] **步骤 5：提交**

```bash
git add tools/offline-package.mjs tools/build-offline-package.sh tests/offline-package.test.mjs .gitignore package.json
git commit -m "feat: 添加半离线 Docker 打包工具"
```

### 任务 3：补充文档并生成、验证真实交付包

**文件：**
- 修改：`README.md`
- 生成但不提交：`dist/offline/movie-harbor-offline-linux-arm64-<版本>.tar.gz`

- [ ] **步骤 1：准备真实消费流程验收环境**

在安全临时目录中准备唯一 Compose 项目名、随机可用宿主端口、独立 PostgreSQL/媒体 bind 目录和测试凭据。真实包生成后必须在这个环境中执行：

```bash
./load-images.sh
cp .env.example .env
docker compose --env-file .env config --format json
```

验收时断言自研镜像来自本地导入，官方服务仍引用固定 Docker Hub 标签，Compose 不需要源码构建上下文。此步骤只准备运行参数，不创建或修改生产代码；因此不要求人为制造一个仅因产物尚未生成而失败的测试。

- [ ] **步骤 2：更新根 README**

增加“半离线发布包”章节，记录：

- 构建机与目标机首版都必须是 `linux/arm64` Docker 平台。
- `./tools/build-offline-package.sh [版本]` 和 `npm run package:offline -- [版本]`。
- 包只内置 3 个自研镜像，目标机必须能访问 Docker Hub 获取 PostgreSQL、Caddy、Alpine。
- 解压、校验/导入、复制并修改 `.env`、`docker compose up -d --no-build --wait`。
- 数据目录映射、升级前备份与不打包秘密/数据的边界。

- [ ] **步骤 3：生成真实当前平台发布包**

```bash
./tools/build-offline-package.sh
```

记录实际输出路径、归档大小、SHA-256 和 3 个镜像标签。

- [ ] **步骤 4：在隔离环境验证真实包**

解压到安全临时目录，运行 `load-images.sh`，用独立 Compose 项目、随机宿主端口、独立 PostgreSQL/媒体 bind 目录和测试凭据启动。等待健康后请求 `/api/health`，再按 E2E runner 的安全顺序停止和清理精确测试项目与目录。

目标命令与断言：

```bash
docker compose --env-file .env -p <唯一项目> up -d --no-build --wait
curl --fail http://127.0.0.1:<随机端口>/api/health
docker compose --env-file .env -p <唯一项目> down --remove-orphans
```

预期：官方镜像可在线取得，自研镜像不拉取也不构建，健康检查返回成功，隔离容器和目录无残留。

- [ ] **步骤 5：运行全量回归**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
npm test --workspaces
npm run build --workspaces
node --test tests/compose-storage.test.mjs tests/ui-demo.test.mjs tests/e2e/run-safety.test.mjs tests/offline-package.test.mjs
git diff --check
git status --short
```

预期：全部退出码为 0，只有 README 和测试的预期 tracked 变更，`dist/offline/` 保持忽略。

- [ ] **步骤 6：提交**

```bash
git add README.md
git commit -m "docs: 添加半离线部署包说明"
```
