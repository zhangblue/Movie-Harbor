# ARM64 宿主机 cargo-zigbuild 构建实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 `linux/arm64` 半离线发布流程在 macOS Apple Silicon 或 Linux 构建机上使用固定宿主机工具链编译静态 musl 后端，再由 Docker 只组装 Linux ARM64 运行镜像，同时保持 AMD64 与发布包接口不变。

**架构：** `tools/offline-package.mjs` 在 ARM64 分支先校验 Rust、cargo-zigbuild、Zig 和 Rust target，再把 Cargo 输出写入本次运行的临时 target 目录，并用 `file` 拒绝非 ARM64、非 Linux ELF 或动态链接程序。验证后的程序被复制到独立临时上下文，由新增的纯运行时 Dockerfile 组装 API 镜像；AMD64 仍走现有 `backend/Dockerfile`，前端、镜像校验、归档白名单、校验和与原子发布流程保持不变。

**技术栈：** Node.js ESM、Node Test Runner、Rust 1.91、cargo-zigbuild 0.23.4、Zig 0.15.2、`aarch64-unknown-linux-musl`、Docker Buildx、Debian bookworm-slim。

---

依据：`../specs/2026-10-31-arm64-host-zigbuild-design.md`。

## 文件结构

- 创建 `backend/Dockerfile.prebuilt`：只把已经校验的后端程序装入现有 Debian 运行环境，不包含 Rust、Cargo、Zig 或源码构建阶段。
- 修改 `tests/backend-build.test.mjs`：将旧的 ARM64 GNU 构建断言替换为预编译运行镜像契约，同时锁定 AMD64 容器化 musl 构建不变。
- 修改 `tools/offline-package.mjs`：增加固定宿主机工具链检查、临时 ARM64 target、ELF 静态链接检查、预编译 API 上下文和 ARM64/AMD64 分流。
- 修改 `tests/offline-package.test.mjs`：扩展命令替身与集成测试，覆盖精确 Cargo 参数、版本和 target 早失败、错误产物拒绝、临时目录清理及 AMD64 回归。
- 修改 `docs/guides/offline-package.md`：记录 ARM64 宿主机构建要求、安装与检查命令，以及“构建机可为 Mac、运行目标仅为 Linux ARM64”的边界。
- 修改 `tests/documentation.test.mjs`：锁定指南中的新命令、版本和平台说明，防止文档退回旧的 GNU ARM64 叙述。

### 任务 1：建立纯运行时 ARM64 API 镜像

**文件：**
- 创建：`backend/Dockerfile.prebuilt`
- 修改：`tests/backend-build.test.mjs:1-38`

- [ ] **步骤 1：把后端镜像契约测试改为读取两个 Dockerfile**

在 `tests/backend-build.test.mjs` 中保留现有 `backend/Dockerfile` 读取，并增加：

```js
const prebuiltDockerfile = readFileSync(
  new URL("../backend/Dockerfile.prebuilt", import.meta.url),
  "utf8",
);
```

删除“ARM64 backend retains the target-platform GNU Cargo build”测试，新增以下失败测试：

```js
test("prebuilt backend image only assembles the verified binary in the Debian runtime", () => {
  assert.match(prebuiltDockerfile, /^FROM debian:bookworm-slim AS runtime/m);
  assert.match(prebuiltDockerfile, /ca-certificates curl/);
  assert.match(
    prebuiltDockerfile,
    /COPY movie-harbor-api \/usr\/local\/bin\/movie-harbor-api/,
  );
  assert.match(prebuiltDockerfile, /USER 10001:10001/);
  assert.match(prebuiltDockerfile, /EXPOSE 3000/);
  assert.match(prebuiltDockerfile, /ENTRYPOINT \["movie-harbor-api"\]/);
  assert.doesNotMatch(prebuiltDockerfile, /\brust\b|cargo|zig|backend\/src|COPY Cargo/iu);
});
```

把原“runtime selects...”测试收窄为现有 Dockerfile 的 AMD64/开发运行时回归，继续断言 `FROM builder-${TARGETARCH}`、Debian、curl、非 root 用户和入口。保留 AMD64 测试中的以下精确断言，不改变目标或固定版本：

```js
assert.match(amd, /ziglang==0\.15\.2/);
assert.match(amd, /cargo install --locked cargo-zigbuild --version 0\.23\.4/);
assert.match(amd, /rustup target add x86_64-unknown-linux-musl/);
assert.match(
  amd,
  /cargo zigbuild --locked --release --target x86_64-unknown-linux-musl -p movie-harbor-api/,
);
```

- [ ] **步骤 2：运行测试验证缺少预编译 Dockerfile**

运行：`node --test tests/backend-build.test.mjs`

预期：FAIL，`readFileSync` 报告 `backend/Dockerfile.prebuilt` 不存在。

- [ ] **步骤 3：创建只负责运行时组装的 Dockerfile**

创建 `backend/Dockerfile.prebuilt`：

```dockerfile
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 movie-harbor \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin movie-harbor

COPY movie-harbor-api /usr/local/bin/movie-harbor-api

USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["movie-harbor-api"]
```

不要把 Dockerfile 放入后续临时上下文；Buildx 使用仓库中的这个文件，但 `COPY` 只能看到临时上下文内唯一的 `movie-harbor-api`。

- [ ] **步骤 4：运行契约测试并检查 Dockerfile 内容**

运行：`node --test tests/backend-build.test.mjs`

预期：全部 PASS，AMD64 的容器化 `x86_64-unknown-linux-musl` 断言仍通过。

运行：`git diff --check`

预期：无输出，退出码为 0。

- [ ] **步骤 5：提交独立运行时镜像**

```bash
git add backend/Dockerfile.prebuilt tests/backend-build.test.mjs
git commit -m "feat: add prebuilt backend runtime image"
```

### 任务 2：让 ARM64 离线打包使用宿主机 cargo-zigbuild

**文件：**
- 修改：`tests/offline-package.test.mjs:1-383`
- 修改：`tools/offline-package.mjs:1-153`

- [ ] **步骤 1：扩展测试 fixture，使宿主机命令可观察且能生成伪 ARM64 程序**

在 fixture 复制文件列表中加入 `backend/Dockerfile.prebuilt`。把现有 Docker 日志改名为通用命令日志，或为宿主机替身增加 `HOST_TOOL_TEST_LOG`。在临时 `bin` 中创建可执行的 `rustc`、`rustup`、`zig`、`cargo`、`file` 替身；每个替身把 `[命令基本名, ...参数]` 以 JSON 行写入日志，并按 `HOST_TOOL_TEST_MODE` 返回结果。

`rustc`、`rustup`、`zig` 和 `file` 的输出必须分别覆盖以下默认成功值：

```text
rustc 1.91.0 (f8297e351 2025-10-28)
aarch64-unknown-linux-musl
0.15.2
movie-harbor-api: ELF 64-bit LSB pie executable, ARM aarch64, statically linked
```

`cargo` 替身要支持版本检查和构建两种调用，并在构建时按 `--target-dir` 创建预期程序：

```js
if (args[0] === "zigbuild" && args[1] === "--version") {
  console.log("cargo-zigbuild 0.23.4");
} else if (args[0] === "zigbuild") {
  const targetDirectory = args[args.indexOf("--target-dir") + 1];
  const binary = path.join(
    targetDirectory,
    "aarch64-unknown-linux-musl",
    "release",
    "movie-harbor-api",
  );
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "fixture aarch64 static ELF");
  fs.chmodSync(binary, 0o755);
} else {
  fail(`Unexpected cargo command: ${args.join(" ")}`);
}
```

为每一种错误模式返回明确结果：`rust-missing`、`rust-wrong-version`、`zigbuild-missing`、`zigbuild-wrong-version`、`zig-missing`、`zig-wrong-version`、`target-missing`、`zigbuild-fails`、`binary-missing`、`binary-wrong-arch`、`binary-dynamic`。三个 `*-missing` 模式让对应替身以 127 退出，模拟命令不可用；fixture 返回 `hostCalls()` 和现有 `calls()`，分别读取宿主机与 Docker 调用。

- [ ] **步骤 2：添加精确命令、临时目录、镜像上下文和清理的失败测试**

把当前第一个 ARM64 成功测试改成以下契约；不要只检查命令包含某个单词：

```js
test("ARM64 packaging cross-compiles on the host and assembles only the verified binary", async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);

  const hostCalls = await f.hostCalls();
  const build = hostCalls.find(args => args[0] === "cargo" && args[1] === "zigbuild" && !args.includes("--version"));
  assert.ok(build, "ARM64 package must invoke cargo zigbuild");
  assert.deepEqual(build.slice(1, 7), [
    "zigbuild", "--locked", "--release", "--target",
    "aarch64-unknown-linux-musl", "--target-dir",
  ]);
  assert.equal(build.at(-2), "-p");
  assert.equal(build.at(-1), "movie-harbor-api");
  const targetDirectory = build[7];
  assert.equal(targetDirectory.startsWith(f.temporary), true);
  assert.equal(targetDirectory.includes(join(f.repo, "target")), false);

  const dockerBuilds = (await f.calls()).filter(
    args => args[0] === "buildx" && args[1] === "build",
  );
  assert.equal(dockerBuilds.length, 3);
  assert.equal(dockerBuilds[0][dockerBuilds[0].indexOf("--file") + 1], "backend/Dockerfile.prebuilt");
  const apiContext = dockerBuilds[0].at(-1);
  assert.equal(apiContext.startsWith(f.temporary), true);
  assert.notEqual(apiContext, ".");
  assert.deepEqual(await readdir(apiContext).catch(() => []), []);
  assert.deepEqual(dockerBuilds.slice(1).map(args => args.at(-1)), [".", "."]);

  await assertClean(f, [BUNDLE_NAME]);
});
```

由于成功后上下文已经删除，Docker 替身还必须在 API build 调用期间断言上下文恰好包含 `movie-harbor-api`，并断言它是普通可执行文件；不能依赖成功后的 `readdir(apiContext)` 来证明构建时内容。将上述 `readdir` 断言仅用于证明路径已被清理。

添加 AMD64 不调用宿主机 Rust/Zig 的回归断言：

```js
test("AMD64 packaging keeps the existing containerized backend build", async t => {
  const f = await fixture(t, "success", "linux/amd64");
  const result = f.run(["--platform", "linux/amd64", VERSION]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await f.hostCalls(), []);
  const builds = (await f.calls()).filter(args => args[0] === "buildx" && args[1] === "build");
  assert.equal(builds[0][builds[0].indexOf("--file") + 1], "backend/Dockerfile");
  assert.equal(builds[0].at(-1), ".");
});
```

- [ ] **步骤 3：添加工具链和程序校验的失败矩阵**

加入以下表驱动测试：

```js
for (const [mode, error] of [
  ["rust-missing", /rustc.*failed|Rust.*missing/i],
  ["rust-wrong-version", /Rust 1\.91/i],
  ["zigbuild-missing", /cargo zigbuild.*failed|cargo-zigbuild.*missing/i],
  ["zigbuild-wrong-version", /cargo-zigbuild 0\.23\.4/i],
  ["zig-missing", /zig.*failed|Zig.*missing/i],
  ["zig-wrong-version", /Zig 0\.15\.2/i],
  ["target-missing", /aarch64-unknown-linux-musl.*target/i],
  ["zigbuild-fails", /cargo zigbuild/i],
  ["binary-missing", /movie-harbor-api.*missing/i],
  ["binary-wrong-arch", /ARM64|aarch64/i],
  ["binary-dynamic", /static/i],
]) {
  test(`ARM64 packaging fails cleanly when ${mode}`, async t => {
    const f = await fixture(t, "success", "linux/arm64", mode);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    const apiBuild = (await f.calls()).find(args =>
      args[0] === "buildx" && args[1] === "build" &&
      args.includes("backend/Dockerfile.prebuilt")
    );
    assert.equal(apiBuild, undefined);
    await assertClean(f);
  });
}
```

把 SIGTERM 测试继续保留在镜像导出阶段，并让 `assertClean` 同时拒绝 `movie-harbor-arm64-target-*` 与 `movie-harbor-api-arm64-*` 临时目录，证明成功、失败和中断都清理宿主机编译资源。

- [ ] **步骤 4：运行聚焦测试确认新行为尚未实现**

运行：`node --test tests/offline-package.test.mjs`

预期：FAIL；ARM64 路径没有调用宿主机 `cargo zigbuild`、仍使用 `backend/Dockerfile` 和仓库上下文，且工具链错误模式不会早失败。确认失败来自新契约，而不是替身脚本语法错误。

- [ ] **步骤 5：在打包工具中实现固定版本和 ELF 校验函数**

在 `tools/offline-package.mjs` 中增加常量：

```js
const ARM64_RUST_MINOR = "1.91";
const ARM64_ZIGBUILD_VERSION = "0.23.4";
const ARM64_ZIG_VERSION = "0.15.2";
const ARM64_RUST_TARGET = "aarch64-unknown-linux-musl";
```

增加严格的输出检查函数；错误信息必须包含期望值和实际值：

```js
function requireVersion(output, pattern, expected) {
  if (!pattern.test(output)) {
    throw new Error(`Expected ${expected}, found: ${output || "no version output"}`);
  }
}

function validateArm64BinaryMetadata(output) {
  if (!/ELF 64-bit/i.test(output)) throw new Error(`Expected a Linux ELF binary, found: ${output}`);
  if (!/(ARM aarch64|AArch64|aarch64)/i.test(output)) {
    throw new Error(`Expected an ARM64/aarch64 binary, found: ${output}`);
  }
  if (/dynamically linked/i.test(output) || !/(statically linked|static-pie linked)/i.test(output)) {
    throw new Error(`Expected a statically linked musl binary, found: ${output}`);
  }
}
```

增加 `prepareArm64ApiContext(signal)`，并严格使用以下命令顺序和 Cargo 参数：

```js
async function prepareArm64ApiContext(signal) {
  requireVersion(
    await run("rustc", ["--version"], { signal }),
    /^rustc 1\.91(?:\.|\s)/,
    "Rust 1.91",
  );
  requireVersion(
    await run("cargo", ["zigbuild", "--version"], { signal }),
    /cargo-zigbuild 0\.23\.4(?:\s|$)/,
    "cargo-zigbuild 0.23.4",
  );
  requireVersion(
    await run("zig", ["version"], { signal }),
    /^0\.15\.2$/,
    "Zig 0.15.2",
  );
  const targets = (await run("rustup", ["target", "list", "--installed"], { signal })).split("\n");
  if (!targets.includes(ARM64_RUST_TARGET)) {
    throw new Error(`Required Rust target is missing: ${ARM64_RUST_TARGET}`);
  }

  const targetDirectory = await mkdtemp(join(tmpdir(), "movie-harbor-arm64-target-"));
  let contextDirectory;
  try {
    contextDirectory = await mkdtemp(join(tmpdir(), "movie-harbor-api-arm64-"));
    await run("cargo", [
      "zigbuild", "--locked", "--release", "--target", ARM64_RUST_TARGET,
      "--target-dir", targetDirectory, "-p", "movie-harbor-api",
    ], { signal, capture: false });
    const binary = join(targetDirectory, ARM64_RUST_TARGET, "release", "movie-harbor-api");
    const metadata = await run("file", [binary], { signal });
    validateArm64BinaryMetadata(metadata);
    const destination = join(contextDirectory, "movie-harbor-api");
    await copyFile(binary, destination);
    await chmod(destination, 0o755);
    return { targetDirectory, contextDirectory };
  } catch (error) {
    await Promise.allSettled([
      rm(targetDirectory, { recursive: true, force: true }),
      ...(contextDirectory
        ? [rm(contextDirectory, { recursive: true, force: true })]
        : []),
    ]);
    throw error;
  }
}
```

在正式实现中，`file` 前必须先用 `lstat(binary)` 给“程序缺失”产生稳定、可读的错误，并确认它是普通文件；上面代码块中的 `run("file", ...)` 只在该检查通过后执行。

- [ ] **步骤 6：在 main 中分流 API 镜像并统一清理临时资源**

在 `main` 的 `try` 之前增加 `let arm64Build;`。完成 Docker 能力检查后，按平台选择：

```js
if (platform === "linux/arm64") {
  arm64Build = await prepareArm64ApiContext(signal);
  await run("docker", [
    "buildx", "build", "--load", "--platform", platform,
    "--file", "backend/Dockerfile.prebuilt", "--tag", tags[0],
    arm64Build.contextDirectory,
  ], { signal, capture: false });
} else {
  await run("docker", [
    "buildx", "build", "--load", "--platform", platform,
    "--file", "backend/Dockerfile", "--tag", tags[0], ".",
  ], { signal, capture: false });
}

for (const [file, tag] of [
  ["frontend/public-web/Dockerfile", tags[1]],
  ["frontend/admin-web/Dockerfile", tags[2]],
]) {
  await run("docker", [
    "buildx", "build", "--load", "--platform", platform,
    "--file", file, "--tag", tag, ".",
  ], { signal, capture: false });
}
```

把 `finally` 的清理集合扩展为 `staging`、`archiveDirectory`、`arm64Build?.targetDirectory` 和 `arm64Build?.contextDirectory`。不要删除 Cargo 缓存、仓库 `target/` 或 Docker 镜像。

若 `prepareArm64ApiContext` 在返回前失败，它必须自行清理已创建的两个目录；若返回后任意 Docker、归档或中断步骤失败，则由 `main` 的 `finally` 清理。

- [ ] **步骤 7：运行聚焦契约并修正测试替身，不放宽产品断言**

运行：`node --test tests/offline-package.test.mjs tests/backend-build.test.mjs`

预期：全部 PASS。确认 ARM64 API 的最后一个 Buildx 参数是临时上下文，AMD64 API 与两个前端的最后一个参数仍是 `.`。

运行：`git diff --check`

预期：无输出，退出码为 0。

- [ ] **步骤 8：提交宿主机 ARM64 构建编排**

```bash
git add tools/offline-package.mjs tests/offline-package.test.mjs
git commit -m "feat: build ARM64 backend with host zigbuild"
```

### 任务 3：同步半离线发布指南和文档契约

**文件：**
- 修改：`docs/guides/offline-package.md:1-27`
- 修改：`tests/documentation.test.mjs:1-90`

- [ ] **步骤 1：先添加会因旧指南而失败的文档契约**

在 `tests/documentation.test.mjs` 中读取 `docs/guides/offline-package.md`，加入：

```js
test("offline guide documents the fixed ARM64 host zigbuild toolchain and Linux-only output", () => {
  const guide = readFileSync(
    path.join(projectRoot, "docs/guides/offline-package.md"),
    "utf8",
  );
  assert.match(guide, /cargo zigbuild[\s\S]*--target aarch64-unknown-linux-musl/);
  assert.match(guide, /--target-dir/);
  assert.match(guide, /Rust 1\.91/);
  assert.match(guide, /cargo-zigbuild 0\.23\.4/);
  assert.match(guide, /Zig 0\.15\.2/);
  assert.match(guide, /macOS Apple Silicon[\s\S]*Linux ARM64/);
  assert.match(guide, /rustup target add aarch64-unknown-linux-musl/);
  assert.doesNotMatch(guide, /ARM64[^\n]*普通 Cargo|aarch64-unknown-linux-gnu/);
});
```

该测试直接复用文件顶部已有的 `readFileSync`、`path` 和 `projectRoot`，不新增第二套路径解析逻辑。

- [ ] **步骤 2：运行文档测试确认旧叙述失败**

运行：`node --test tests/documentation.test.mjs`

预期：FAIL；指南仍称 ARM64 在目标 Linux 容器中执行普通 Cargo 并生成 GNU 程序。

- [ ] **步骤 3：改写构建机要求与平台边界**

把指南开头改成明确的两平台说明：

```markdown
ARM64 后端在构建机宿主系统中执行 `cargo zigbuild --locked --release --target aarch64-unknown-linux-musl --target-dir <本次临时目录> -p movie-harbor-api`，再由 Docker 组装 Debian 运行镜像。构建机可以是 macOS Apple Silicon 或 Linux，但生成、打包和部署的程序仅支持 Linux ARM64；它不是 macOS 程序，也不能直接在 macOS 中运行。

AMD64 后端仍在现有 Linux 构建容器中使用固定的 `x86_64-unknown-linux-musl` Zig 工具链，宿主机不需要为 AMD64 单独安装 Zig。
```

在构建命令之前增加 ARM64 前置条件与检查命令：

```bash
rustc --version                         # 必须为 1.91.x
cargo zigbuild --version                # 必须为 cargo-zigbuild 0.23.4
zig version                             # 必须为 0.15.2
rustup target list --installed          # 必须包含 aarch64-unknown-linux-musl
```

给出由使用者主动执行、发布工具不会代劳的安装命令：

```bash
rustup toolchain install 1.91.0
rustup override set 1.91.0
cargo install --locked cargo-zigbuild --version 0.23.4
rustup target add aarch64-unknown-linux-musl
```

说明 Zig 0.15.2 需按操作系统从 Zig 官方发布包安装并加入 `PATH`；发布工具只检查版本，不自动安装或升级任何宿主机工具。保留 Docker Engine、Buildx、Compose v2、Node.js、Git、tar 和依赖下载要求。

- [ ] **步骤 4：运行文档与实现契约**

运行：`node --test tests/documentation.test.mjs tests/backend-build.test.mjs tests/offline-package.test.mjs`

预期：全部 PASS。

运行：`git diff --check`

预期：无输出，退出码为 0。

- [ ] **步骤 5：提交指南同步**

```bash
git add docs/guides/offline-package.md tests/documentation.test.mjs
git commit -m "docs: explain ARM64 host zigbuild requirements"
```

### 任务 4：执行真实双平台发布与全量回归验收

**文件：**
- 验证：`backend/Dockerfile.prebuilt`
- 验证：`backend/Dockerfile`
- 验证：`tools/offline-package.mjs`
- 验证：`tests/e2e/run.mjs`
- 不创建或提交验证产物；`dist/offline/` 保持 Git 忽略状态

- [ ] **步骤 1：确认宿主机固定工具链**

运行：

```bash
rustc --version
cargo zigbuild --version
zig version
rustup target list --installed
```

预期：分别报告 Rust 1.91.x、cargo-zigbuild 0.23.4、Zig 0.15.2，target 列表包含 `aarch64-unknown-linux-musl`。任一项不符合时停止真实打包，修正构建机工具链后重新从本步骤执行；不得通过放宽版本检查继续。

- [ ] **步骤 2：运行根契约、Rust 与前端检查**

运行：

```bash
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
docker compose -f docker-compose.test.yml up -d postgres
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
npm test --workspaces
npm run build --workspaces
```

预期：所有命令退出码为 0。数据库测试使用项目专用测试 Compose，不使用生产 `data/postgres` 或 `data/media`；不在计划中加入会删除共享测试服务的强制清理命令。

- [ ] **步骤 3：运行隔离的跨服务 E2E**

运行：`npm run test:e2e`

预期：Playwright 全部 PASS，runner 使用自己的隔离 Compose 项目和临时数据目录。

- [ ] **步骤 4：生成真实 ARM64 半离线包并检查程序与镜像**

选择当前仓库中尚不存在的版本字符串，例如 `arm64-host-zigbuild-check-20261031-1`，运行：

```bash
./tools/build-offline-package.sh --platform linux/arm64 arm64-host-zigbuild-check-20261031-1
```

预期：生成 `dist/offline/movie-harbor-offline-linux-arm64-arm64-host-zigbuild-check-20261031-1.tar.gz`。

用以下命令列出并解压归档：

```bash
tar -tzf dist/offline/movie-harbor-offline-linux-arm64-arm64-host-zigbuild-check-20261031-1.tar.gz
ARM64_VERIFY_DIR="$(mktemp -d)"
tar -xzf dist/offline/movie-harbor-offline-linux-arm64-arm64-host-zigbuild-check-20261031-1.tar.gz -C "$ARM64_VERIFY_DIR"
cd "$ARM64_VERIFY_DIR/movie-harbor"
```

确认列表只有 `movie-harbor/`、`.env.example`、`Caddyfile`、`README.md`、`SHA256SUMS`、`compose.yml`、`images.tar` 和 `load-images.sh`。然后运行：

```bash
shasum -a 256 -c SHA256SUMS
docker image inspect --format '{{.Os}}/{{.Architecture}} {{.Config.User}}' movie-harbor-api:arm64-host-zigbuild-check-20261031-1-linux-arm64
ARM64_VERIFY_CONTAINER="$(docker create movie-harbor-api:arm64-host-zigbuild-check-20261031-1-linux-arm64)"
docker cp "$ARM64_VERIFY_CONTAINER:/usr/local/bin/movie-harbor-api" "$ARM64_VERIFY_DIR/movie-harbor-api"
docker rm "$ARM64_VERIFY_CONTAINER"
file "$ARM64_VERIFY_DIR/movie-harbor-api"
```

预期：校验和全部成功；镜像输出 `linux/arm64 10001:10001`；`file` 输出含 `ELF 64-bit`、`ARM aarch64` 或 `AArch64`，并含 `statically linked` 或 `static-pie linked`，不含 `dynamically linked`。验证完成后返回仓库根目录，只删除 `$ARM64_VERIFY_DIR` 临时检查目录，不删除归档或仓库文件。

- [ ] **步骤 5：生成真实 AMD64 包并验证回归边界**

使用另一唯一版本运行：

```bash
./tools/build-offline-package.sh --platform linux/amd64 amd64-regression-check-20261031-1
```

预期：生成 `dist/offline/movie-harbor-offline-linux-amd64-amd64-regression-check-20261031-1.tar.gz`，API、公开站和管理后台镜像均为 `linux/amd64`，标签后缀为 `-linux-amd64`。检查运行日志确认 AMD64 API 仍由 `backend/Dockerfile` 内的 `x86_64-unknown-linux-musl` cargo-zigbuild 阶段构建，而不是宿主机 ARM64 分支。

对两个归档分别再次使用相同版本执行打包。预期：都因目标文件已存在而失败，原归档 SHA-256 不变。

- [ ] **步骤 6：完成最终差异检查**

运行：

```bash
git diff --check
git status --short
git log --oneline --decorate -4
```

预期：`git diff --check` 无输出；状态中只有用户原有且与任务无关的 `.team/` 未跟踪目录，不包含构建产物或未提交的任务文件；最近提交依次包含运行时镜像、ARM64 宿主机构建和指南同步。若测试或验收导致任务文件发生修正，先重跑对应聚焦检查，再以范围明确的新提交保存修正，不修改、删除或提交 `.team/`。
