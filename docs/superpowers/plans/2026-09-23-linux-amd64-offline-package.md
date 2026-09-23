# Linux AMD64 半离线发布包实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 保留现有默认 `linux/arm64` 发布行为，并允许通过 `--platform linux/amd64` 生成可在 Intel/AMD 64 位 Ubuntu 上运行的单平台半离线 Docker 包。

**架构：** 将目标平台作为发布模块的显式输入，统一驱动参数解析、Buildx 构建、镜像标签、Compose、加载脚本、包内 README 和归档名。现有 Docker 替身继续只替换外部 Docker 边界，真实执行 CLI、文件生成、tar、SHA-256、归档白名单与失败清理，以 TDD 覆盖 ARM64 兼容和 AMD64 新行为。

**技术栈：** Node.js 标准库、POSIX Shell、Docker Buildx/BuildKit、Docker Compose v2、Docker image save/load、tar、SHA-256。

---

## 文件结构

- 修改 `tests/offline-package.test.mjs`：增加平台参数、AMD64 产物、Buildx 调用、目标平台校验和 ARM64 兼容回归测试。
- 修改 `tools/offline-package.mjs`：解析可选平台，把平台贯穿构建、模板和归档发布流程。
- 修改 `README.md`：说明 ARM64 默认行为、AMD64 构建命令和 Intel Ubuntu 部署方式。
- 修改 `AGENTS.md`：把已过时的“只支持 ARM64”协作约束更新为双平台单包边界。

### 任务 1：参数化离线包目标平台

**文件：**
- 修改：`tests/offline-package.test.mjs`
- 修改：`tools/offline-package.mjs`

- [ ] **步骤 1：编写失败的纯函数和 CLI 参数测试**

在测试文件中先点名要捕获的破坏：忽略 `--platform`、把默认平台意外改为 AMD64、接受任意平台字符串，或者没有把平台传到标签和模板。使用手工字面量断言：

```js
test("accepts only the two supported target platforms", () => {
  assert.equal(normalizePlatform(), "linux/arm64");
  assert.equal(normalizePlatform("linux/arm64"), "linux/arm64");
  assert.equal(normalizePlatform("linux/amd64"), "linux/amd64");
  assert.throws(() => normalizePlatform("linux/386"), /linux\/arm64.*linux\/amd64/i);
});

test("uses AMD64 image tags and templates when requested", () => {
  assert.deepEqual(imageTags("test-v1", "linux/amd64"), [
    "movie-harbor-api:test-v1-linux-amd64",
    "movie-harbor-public-web:test-v1-linux-amd64",
    "movie-harbor-admin-web:test-v1-linux-amd64",
  ]);
  const compose = JSON.parse(renderCompose("test-v1", "linux/amd64"));
  assert.equal(compose.services.api.image, "movie-harbor-api:test-v1-linux-amd64");
  assert.match(renderLoadScript("test-v1", "linux/amd64"), /linux\/amd64/);
  assert.match(renderBundleReadme("test-v1", "linux/amd64"), /linux\/amd64/);
});
```

扩展真实 Shell CLI 黑盒参数表，验证以下调用在 Docker 前失败：

```js
[
  ["--platform"],
  ["--platform", "linux/386"],
  ["--platform", "linux/amd64", "one", "two"],
  ["--unknown"],
]
```

同时断言 `--help` 输出包含 `--platform linux/arm64|linux/amd64`，现有 `[版本]` 位置参数仍有效。

- [ ] **步骤 2：运行测试并确认正确失败**

运行：

```bash
node --test tests/offline-package.test.mjs
```

预期：FAIL。失败原因应为现有函数忽略第二个平台参数、拒绝 `--platform`，而不是 fixture 或语法错误。

- [ ] **步骤 3：实现最小平台模型和参数解析**

在 `tools/offline-package.mjs` 中用显式白名单替换单个固定平台：

```js
const DEFAULT_PLATFORM = "linux/arm64";
const SUPPORTED_PLATFORMS = new Set([DEFAULT_PLATFORM, "linux/amd64"]);

export function normalizePlatform(value = DEFAULT_PLATFORM) {
  if (!SUPPORTED_PLATFORMS.has(value)) {
    throw new Error("supported platforms are linux/arm64 and linux/amd64");
  }
  return value;
}

function platformSuffix(platform) {
  return normalizePlatform(platform).replace("/", "-");
}

export function imageTags(version, platform = DEFAULT_PLATFORM) {
  const safeVersion = validateVersion(version);
  const suffix = platformSuffix(platform);
  return ["api", "public-web", "admin-web"]
    .map(name => `movie-harbor-${name}:${safeVersion}-${suffix}`);
}
```

新增内部 `parseArguments(args)`，只接受零或一个版本位置参数，以及位于版本前的可选 `--platform <值>`。`--help` 保持无 Docker 副作用；其他未知选项和多余参数返回统一用法错误。

将 `platform = DEFAULT_PLATFORM` 作为 `renderCompose`、`renderLoadScript`、`renderBundleReadme` 的可选末尾参数，保持现有调用默认产生 ARM64 内容。

- [ ] **步骤 4：运行纯函数和参数测试确认通过**

运行：

```bash
node --test tests/offline-package.test.mjs
```

预期：新增平台函数和非法参数测试通过；黑盒 AMD64 构建测试仍因构建命令及 Docker 替身尚未支持目标平台而失败。

- [ ] **步骤 5：编写失败的 AMD64 黑盒打包测试**

让 fixture 可按平台计算目标文件名，并让 Docker 替身完整模拟 Buildx、inspect 与 save 的目标架构元数据。新增真实 CLI 测试：

```js
test("shell CLI builds and packages a linux/amd64 release", async t => {
  const f = await fixture(t, "success", "linux/amd64");
  const result = f.run(["--platform", "linux/amd64", VERSION]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.destination.endsWith(
    "movie-harbor-offline-linux-amd64-test-v1.tar.gz",
  ), true);

  const calls = await f.calls();
  const builds = calls.filter(args => args[0] === "buildx" && args[1] === "build");
  assert.equal(builds.length, 3);
  for (const args of builds) {
    assert.equal(args.includes("--load"), true);
    assert.equal(args[args.indexOf("--platform") + 1], "linux/amd64");
  }
});
```

解包 AMD64 产物后，以固定字面量断言三个 RepoTags、Compose 自研镜像、`load-images.sh` 和包内 README 均为 AMD64。把原有 ARM64 黑盒测试保留为默认参数回归，并增加显式 ARM64 调用。

修改 `wrong-host` 场景，使 ARM64 守护进程构建 AMD64 不再因宿主架构被提前拒绝；增加 `wrong-image` 场景，确保最终 inspect 返回非目标架构时失败且不留下产物。

- [ ] **步骤 6：运行 AMD64 黑盒测试并确认正确失败**

运行：

```bash
node --test tests/offline-package.test.mjs
```

预期：FAIL。失败原因应为生产 CLI 仍调用 `docker build`、仍固定 ARM64 归档名或模板平台。

- [ ] **步骤 7：实现 Buildx 单平台构建和平台贯穿**

在主流程中：

1. 从 `parseArguments` 取得 `platform` 和可选版本。
2. 调用 `docker info` 验证守护进程可用，但不再把宿主架构当作目标平台限制。
3. 调用 `docker buildx version` 和 `docker compose version --short` 验证依赖。
4. 对三个 Dockerfile 执行：

```js
await run("docker", [
  "buildx", "build", "--load", "--platform", platform,
  "--file", file, "--tag", tags[index], ".",
], { signal, capture: false });
```

5. 将 `platform` 传给镜像 inspect 比较、归档名、`imageTags` 和三个渲染函数。
6. 继续只把三个精确标签传给 `docker image save`，并保留白名单、校验和、原子发布和清理逻辑。

- [ ] **步骤 8：运行离线包测试与相邻契约测试确认通过**

运行：

```bash
node --test tests/offline-package.test.mjs
node --test tests/compose-storage.test.mjs tests/e2e/run-safety.test.mjs tests/offline-package.test.mjs
node --check tools/offline-package.mjs
sh -n tools/build-offline-package.sh
npm run package:offline -- --help
git diff --check
```

预期：全部退出码为 0；ARM64 默认测试和 AMD64 新测试均通过。

- [ ] **步骤 9：提交平台实现**

```bash
git add tests/offline-package.test.mjs tools/offline-package.mjs
git commit -m "feat: 支持 Linux AMD64 离线包"
```

### 任务 2：同步双平台发布文档并完成回归验证

**文件：**
- 修改：`README.md`
- 修改：`AGENTS.md`

- [ ] **步骤 1：更新根 README 的发布能力与命令**

将项目能力概述和“半离线发布包”章节改为：

- 默认命令仍生成 `linux/arm64`。
- AMD64 使用 `./tools/build-offline-package.sh --platform linux/amd64 [版本]`。
- 构建机需要 Docker Buildx、Docker Compose v2、Node.js、Git 和 tar。
- 原生 AMD64 Linux 是 AMD64 发布首选；跨架构构建依赖 Docker/BuildKit 模拟支持。
- 两个平台的产物名分别包含 `linux-arm64` 或 `linux-amd64`。
- Intel/AMD 64 位 Ubuntu 必须选择 AMD64 包；加载脚本按包平台检查镜像。
- 官方 PostgreSQL、Caddy、Alpine 镜像仍需目标机联网获取。

在规格索引中加入 `docs/superpowers/specs/2026-09-23-linux-amd64-offline-package-design.md`。

- [ ] **步骤 2：更新协作约束**

将 `AGENTS.md` 的“首版只支持 `linux/arm64`”替换为以下稳定边界：

```markdown
- 半离线发布支持 `linux/arm64` 和 `linux/amd64`，不传平台参数时默认 `linux/arm64`。
- 每个归档只包含一个目标平台的三个自研镜像，不生成多架构单包或镜像清单。
```

其余半离线安全边界保持不变。

- [ ] **步骤 3：运行完整相关验证**

启动现有隔离测试数据库后运行项目规定的相关子集：

```bash
docker compose -f docker-compose.test.yml up -d postgres
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
npm test --workspaces
npm run build --workspaces
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
git diff --check
git status --short
```

若当前机器的 Docker/Buildx 环境允许构建 AMD64，再额外运行：

```bash
./tools/build-offline-package.sh --platform linux/amd64 <唯一验证版本>
```

真实产物生成属于环境相关验收；如果本机无法完成跨架构构建，记录具体命令和错误，不得用单元测试结果冒充真实 AMD64 镜像构建成功。

- [ ] **步骤 4：提交文档同步**

```bash
git add README.md AGENTS.md
git commit -m "docs: 说明 AMD64 半离线部署"
```

## 完成定义

- 未指定平台的现有命令、标签、Compose 和归档名保持 ARM64 行为。
- 显式 `linux/amd64` 生成 AMD64 标签、模板、加载校验和独立归档名。
- 宿主 Docker 架构不再被误当作目标平台；最终镜像元数据仍被严格验证。
- 失败清理、拒绝覆盖、归档白名单、SHA-256 和秘密排除行为不回归。
- README 和协作约束不再声称只支持 ARM64，并明确 Intel Ubuntu 使用 AMD64 包。
