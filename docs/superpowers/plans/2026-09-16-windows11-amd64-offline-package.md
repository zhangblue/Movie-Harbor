# Movie Harbor Windows 11 AMD64 半离线发布包实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 扩展现有半离线发布工具，生成可在 Windows 11 64 位 Intel/AMD 电脑的 Docker Desktop Linux 容器模式中运行的 `linux/amd64` 部署包。

**架构：** 把发布平台建模为经过白名单验证的值，并让镜像标签、构建参数、检查和归档名从同一平台对象派生。构建仍在 macOS、Linux 或 CI 完成；AMD64 包增加不执行远程代码的 PowerShell 校验、导入和多卷启动入口，目标机只运行导入的 Linux AMD64 自研镜像。

**技术栈：** Node.js、Docker Buildx/BuildKit、Docker Compose v2、PowerShell 5.1+、Windows 11 Docker Desktop WSL2、Linux AMD64 OCI 镜像、Node 内置测试。

---

## 前置条件

先完成并合并 `2026-09-16-multi-volume-media-storage.md`，使基础 Compose、Caddy、API 和宿主机配置已经支持 `MEDIA_HOST_DIR` 路径列表及生成的存储覆盖文件。本计划只扩展发布平台和 Windows 主机入口，不重复实现多卷业务逻辑。

## 文件结构

- 修改 `tools/offline-package.mjs`：平台参数、Buildx 构建、平台派生标签、归档白名单和 PowerShell 内容生成。
- 修改 `tools/build-offline-package.sh`：保持薄入口并转发新参数。
- 修改 `package.json`：保持 npm 发布入口并补充聚焦验证脚本。
- 修改 `tests/offline-package.test.mjs`：双平台 CLI、镜像构建、归档和失败清理契约。
- 创建 `tests/offline-package-powershell.test.mjs`：PowerShell 文本、安全边界和可执行行为测试。
- 修改 `docker-compose.yml` 与多卷生成器测试：保证 AMD64 包沿用相同运行拓扑且不从源码构建。
- 修改 `README.md`：平台矩阵、构建、Windows 解压、Docker Desktop 和 PowerShell 部署说明。
- 修改 `AGENTS.md`：更新发布边界、目录职责和完成前验证要求。
- 创建 `docs/verification/windows11-amd64-package.md`：真实 Windows 11 验收记录模板和最终证据。

### 任务 1：平台参数与命名模型

**文件：**
- 修改：`tools/offline-package.mjs`
- 修改：`tests/offline-package.test.mjs`

- [ ] **步骤 1：编写失败的平台解析测试**

增加默认 ARM64、显式双平台、非法平台、重复参数和版本位置测试：

```js
assert.deepEqual(parseArguments([]), { platform: "linux/arm64", version: undefined });
assert.deepEqual(parseArguments(["--platform", "linux/amd64", "v2"]), {
  platform: "linux/amd64", version: "v2",
});
assert.throws(() => parseArguments(["--platform", "windows/amd64"]), /unsupported platform/i);
assert.throws(() => parseArguments(["--platform", "linux/amd64", "v1", "extra"]), /Usage/);
```

测试 `normalizeImagePlatform("linux", "x86_64")` 和 `normalizeImagePlatform("linux", "amd64")` 都返回 `linux/amd64`，但 ARM64 不会被误认为 AMD64。

- [ ] **步骤 2：运行测试确认 RED**

运行：`node --test tests/offline-package.test.mjs --test-name-pattern='platform|argument|tag'`

预期：FAIL，CLI 只接受一个可选版本，平台常量固定为 ARM64。

- [ ] **步骤 3：实现白名单平台对象**

定义单一派生边界：

```js
const PLATFORMS = new Map([
  ["linux/arm64", { os: "linux", architecture: "arm64", slug: "linux-arm64" }],
  ["linux/amd64", { os: "linux", architecture: "amd64", slug: "linux-amd64" }],
]);

export function platformInfo(value) {
  const info = PLATFORMS.get(value);
  if (!info) throw new Error(`unsupported platform: ${value}`);
  return info;
}
```

`parseArguments` 只接受 `[--platform <白名单值>] [version]`；`--help` 更新精确用法。`imageTags(version, platform)` 和 `archiveName(version, platform)` 只使用 `platformInfo().slug`，禁止散落字符串替换。

- [ ] **步骤 4：移除宿主机架构等于目标架构的限制**

Docker daemon 必须报告 Linux 容器 OS，但宿主/daemon 架构不再决定目标平台。保留构建后镜像元数据验证。将原 `wrong-host` 测试改为拒绝 Windows containers daemon，而不是拒绝 AMD64 daemon。

- [ ] **步骤 5：运行测试并提交**

运行：

```bash
node --check tools/offline-package.mjs
node --test tests/offline-package.test.mjs --test-name-pattern='platform|argument|tag'
git diff --check
```

提交：

```bash
git add tools/offline-package.mjs tests/offline-package.test.mjs
git commit -m "feat: model offline package target platforms"
```

### 任务 2：Buildx 单平台构建与安全归档

**文件：**
- 修改：`tools/offline-package.mjs`
- 修改：`tests/offline-package.test.mjs`

- [ ] **步骤 1：扩展 Docker 替身并编写失败测试**

Docker 替身记录 `buildx version` 和 `buildx build`。AMD64 成功用例断言三个构建均包含：

```js
assert.deepEqual(build.slice(0, 4), ["buildx", "build", "--platform", "linux/amd64"]);
assert.ok(build.includes("--load"));
assert.equal(build.at(-1), ".");
```

另加 Buildx 不可用、构建后某镜像为 ARM64、`docker image save` 混入额外标签和 AMD64 同名归档已存在的失败测试。

- [ ] **步骤 2：运行测试确认 RED**

运行：`node --test tests/offline-package.test.mjs --test-name-pattern='buildx|amd64|archive'`

预期：FAIL，当前实现仍调用 `docker build --platform linux/arm64`。

- [ ] **步骤 3：实现 Buildx 构建流水线**

环境检查依次执行：

```text
docker info --format {{.OSType}}
docker compose version --short
docker buildx version
```

每个 Dockerfile 使用：

```js
await run("docker", [
  "buildx", "build", "--platform", platform,
  "--load", "--file", dockerfile, "--tag", tag, ".",
], { signal, capture: false });
```

构建后逐个 `docker image inspect`，把 `x86_64` 规范化为 `amd64` 再与目标比较。只有全部匹配后才允许 `docker image save`。

- [ ] **步骤 4：保持原子发布与平台隔离**

临时目录、allowlist、manifest RepoTags、SHA-256 和最终 hard-link 发布协议保持现状。ARM64 与 AMD64 同版本产生不同文件；同平台同版本继续拒绝覆盖。失败和信号中断不得留下任何平台的半成品。

- [ ] **步骤 5：运行完整替身测试并提交**

运行：

```bash
node --check tools/offline-package.mjs
node --test tests/offline-package.test.mjs
git diff --check
```

提交：

```bash
git add tools/offline-package.mjs tests/offline-package.test.mjs
git commit -m "feat: build amd64 offline images with buildx"
```

### 任务 3：PowerShell 镜像校验与导入

**文件：**
- 修改：`tools/offline-package.mjs`
- 创建：`tests/offline-package-powershell.test.mjs`
- 修改：`tests/offline-package.test.mjs`

- [ ] **步骤 1：编写失败的 PowerShell 内容契约**

对 `renderLoadPowerShell(version, platform)` 断言：

```js
const script = renderLoadPowerShell("test-v1", "linux/amd64");
assert.match(script, /Get-FileHash/);
assert.match(script, /docker image load/);
assert.match(script, /linux\/amd64/);
for (const tag of imageTags("test-v1", "linux/amd64")) assert.ok(script.includes(tag));
assert.doesNotMatch(script, /Invoke-WebRequest|Invoke-Expression|iex\b/i);
```

归档测试要求 AMD64 包包含 `load-images.ps1` 且 `SHA256SUMS` 覆盖它；ARM64 包保持原有 shell 文件集合。两个平台各自的白名单必须与实际产物精确一致。

- [ ] **步骤 2：运行测试确认 RED**

运行：`node --test tests/offline-package-powershell.test.mjs tests/offline-package.test.mjs`

预期：FAIL，渲染函数和 PowerShell 文件尚不存在。

- [ ] **步骤 3：实现失败优先的 SHA-256 校验**

PowerShell 5.1 兼容脚本逐行接受严格格式 `64 个十六进制字符 + 两个空格 + 白名单文件名`，先验证清单恰好覆盖预期文件，再执行全部哈希比较。核心比较使用：

```powershell
$actual = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "checksum mismatch: $name" }
```

校验完成前不得调用 Docker。脚本用 `$PSScriptRoot` 定位包目录，不依赖当前工作目录，不输出清单文件内容。

- [ ] **步骤 4：实现镜像导入与平台检查**

执行 `docker image load --input images.tar` 后，对三个精确标签调用：

```powershell
$platform = docker image inspect --format '{{.Os}}/{{.Architecture}}' $image
if ($LASTEXITCODE -ne 0 -or $platform.Trim() -ne 'linux/amd64') {
    throw "expected $image to use linux/amd64"
}
```

任何失败设置非零退出码。不得拉取镜像或接受标签前缀匹配。

- [ ] **步骤 5：在可用 PowerShell 环境运行行为测试**

Node 测试创建 `docker.cmd` 替身和临时包，使用以下入口执行校验失败、成功导入、缺失镜像和错误架构四种场景：

```text
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File load-images.ps1
```

非 Windows 开发机运行文本契约；Windows 11 验收必须运行行为测试且不得跳过。

- [ ] **步骤 6：提交**

运行：

```bash
node --test tests/offline-package-powershell.test.mjs tests/offline-package.test.mjs
git diff --check
```

提交：

```bash
git add tools/offline-package.mjs tests/offline-package-powershell.test.mjs tests/offline-package.test.mjs
git commit -m "feat: add verified PowerShell image loader"
```

### 任务 4：Windows 多卷启动入口

**文件：**
- 修改：`tools/offline-package.mjs`
- 修改：`tests/offline-package-powershell.test.mjs`
- 修改：`tests/offline-package.test.mjs`

- [ ] **步骤 1：编写失败的 `start.ps1` 契约测试**

断言脚本检查 Docker OS、Compose、`.env`、绝对 Windows 路径、卷标记和生成文件编码，并使用两个 Compose 文件启动：

```js
const script = renderStartPowerShell("test-v1", "linux/amd64");
assert.match(script, /docker info/);
assert.match(script, /MEDIA_HOST_DIR/);
assert.match(script, /\.movie-harbor-volume\.json/);
assert.match(script, /compose\.storage\.generated\.json/);
assert.match(script, /--no-build/);
assert.doesNotMatch(script, /Invoke-Expression|Start-Process.*-Verb\s+RunAs/i);
```

- [ ] **步骤 2：运行测试确认 RED**

运行：`node --test tests/offline-package-powershell.test.mjs --test-name-pattern='start|storage|Docker mode'`

预期：FAIL，包内没有 Windows 启动入口。

- [ ] **步骤 3：实现安全的 `.env` 单字段解析**

脚本只解析第一条有效 `MEDIA_HOST_DIR=`，接受无引号或成对双引号值，按分号拆分并 trim。拒绝空项、重复项、相对路径、UNC 网络路径、通配符和不存在的盘符。它不得 dot-source 或执行 `.env`。

Windows 路径规范化为 `D:/MovieHarbor/media` 后再写 JSON。密码和代理秘密由 `docker compose --env-file .env` 自行读取，PowerShell 不解析或输出这些字段。

- [ ] **步骤 4：实现卷身份与覆盖文件生成**

使用 `ConvertFrom-Json` 校验 `.movie-harbor-volume.json` 的 `version=1` 和数组位置。卷 0 允许对已有 Movie Harbor 媒体目录初始化标记；编号大于 0 的新目录只有为空时才允许初始化。缺盘或标记不符立即退出。

使用 PowerShell 对象和 `ConvertTo-Json -Depth 12` 生成与 Node 多卷生成器语义相同的挂载，最后使用无 BOM UTF-8 和原子 `Move-Item` 发布：

```powershell
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($temporary, $json, $utf8)
Move-Item -LiteralPath $temporary -Destination $output -Force
```

- [ ] **步骤 5：检查 Docker Desktop 模式并启动**

要求 `docker info --format '{{.OSType}}/{{.Architecture}}'` 的 OS 为 `linux`；目标镜像仍由 `load-images.ps1` 验证为 AMD64。启动命令固定为：

```powershell
docker compose --env-file .env -f compose.yml -f compose.storage.generated.json up -d --no-build --wait
if ($LASTEXITCODE -ne 0) { throw 'docker compose startup failed' }
```

不自动安装 Docker Desktop、切换容器模式或修改驱动器共享设置。

同时把多卷计划创建的 `tools/start-compose.sh` 以 `start.sh` 加入 AMD64 包，或由同一纯函数渲染等价脚本；它与 `start.ps1` 必须生成相同的服务挂载、容器路径和 `MEDIA_DIRS`，并纳入归档白名单及 `SHA256SUMS`。

- [ ] **步骤 6：运行文本与 Windows 行为测试并提交**

运行开发机契约：

```bash
node --test tests/offline-package-powershell.test.mjs tests/offline-package.test.mjs
```

在 Windows 11 运行：

```powershell
node --test tests/offline-package-powershell.test.mjs
```

预期：所有适用测试通过，Windows 行为测试没有 skip。

提交：

```bash
git add tools/offline-package.mjs tests/offline-package-powershell.test.mjs tests/offline-package.test.mjs
git commit -m "feat: add Windows multi-volume deployment entrypoint"
```

### 任务 5：真实 AMD64 包构建与归档检查

**文件：**
- 修改：`package.json`
- 修改：`tests/offline-package.test.mjs`
- 创建：`docs/verification/windows11-amd64-package.md`

- [ ] **步骤 1：增加真实构建前置检查测试**

锁定 `--platform linux/amd64` 会先检查 Buildx，构建失败不会调用 `image save`，而三镜像全部验证通过后才生成归档。package.json 增加不会覆盖常规测试的聚焦入口：

```json
"test:package": "node --test tests/offline-package.test.mjs tests/offline-package-powershell.test.mjs"
```

- [ ] **步骤 2：运行契约测试**

运行：

```bash
npm run test:package
node --check tools/offline-package.mjs
```

预期：全部退出码为 0。

- [ ] **步骤 3：在原生 AMD64 Linux 构建机或 CI 构建真实包**

运行：

```bash
./tools/build-offline-package.sh --platform linux/amd64 windows11-i7-validation
```

预期生成 `dist/offline/movie-harbor-offline-linux-amd64-windows11-i7-validation.tar.gz`，且工具输出零错误。Apple Silicon 模拟构建只能作为补充，不替代此项正式证据。

- [ ] **步骤 4：独立检查归档与镜像清单**

运行：

```bash
tar -tzf dist/offline/movie-harbor-offline-linux-amd64-windows11-i7-validation.tar.gz
tar -xOf dist/offline/movie-harbor-offline-linux-amd64-windows11-i7-validation.tar.gz movie-harbor/images.tar > /tmp/movie-harbor-images-amd64.tar
docker image load --input /tmp/movie-harbor-images-amd64.tar
docker image inspect --format '{{.Os}}/{{.Architecture}}' movie-harbor-api:windows11-i7-validation-linux-amd64
```

预期归档只有 allowlist 文件，镜像检查精确返回 `linux/amd64`。临时文件使用明确路径并在检查后删除。

- [ ] **步骤 5：记录可复查证据并提交**

`docs/verification/windows11-amd64-package.md` 记录构建机架构、Docker/Buildx/Compose 版本、归档 SHA-256、三个镜像标签及检查结果，不记录用户名、绝对私有路径或秘密。

提交：

```bash
git add package.json tests/offline-package.test.mjs docs/verification/windows11-amd64-package.md
git commit -m "test: verify linux amd64 offline package build"
```

### 任务 6：Windows 11 实机验收与文档

**文件：**
- 修改：`README.md`
- 修改：`AGENTS.md`
- 修改：`docs/verification/windows11-amd64-package.md`

- [ ] **步骤 1：准备 Windows 11 验收环境**

在 Intel i7-8700K 电脑确认：Windows 11 64 位、Docker Desktop WSL2 backend、Linux containers、Compose v2；准备两个真实硬盘目录，例如 `D:/MovieHarbor/media` 和 `E:/MovieHarbor/media`，并确保 Docker Desktop 能访问。

- [ ] **步骤 2：验证包校验、导入与配置**

PowerShell 中执行：

```powershell
tar -xzf movie-harbor-offline-linux-amd64-windows11-i7-validation.tar.gz
Set-Location movie-harbor
.\load-images.ps1
Copy-Item .env.example .env
```

配置 `MEDIA_HOST_DIR=D:/MovieHarbor/media;E:/MovieHarbor/media`、安全数据库密码、管理员初始密码和独立代理秘密，再执行 `.\start.ps1`。记录命令退出码和 `docker compose ps` 健康状态。

- [ ] **步骤 3：验证多硬盘业务流程**

通过管理后台分别上传海报、电影视频和单集视频，确认它们按真实剩余可用字节选择硬盘；验证公开播放、跨卷替换、电影/剧集删除、容器重建和启动恢复。检查缺盘启动失败不会在其他硬盘创建替代目录。

- [ ] **步骤 4：验证失败路径**

使用归档副本分别篡改一个校验文件、模拟错误镜像架构和错误卷标记，确认 PowerShell 脚本在导入或启动前失败。不得修改唯一一份验收数据。

- [ ] **步骤 5：完成文档与验收记录**

README 增加双平台构建命令、Windows Docker Desktop 前置条件、PowerShell 流程、正斜杠路径、多卷追加规则、官方镜像联网要求和 HTTPS 管理入口提醒。AGENTS.md 把发布边界更新为 ARM64 与 AMD64 两个单平台包，并加入 Windows 实机验证要求。

在验证记录填写 Windows 版本、CPU、Docker 模式、两个卷的选择证据和所有失败路径结果；未取得这份实机证据前不得声称 Windows 11 已完整验证。

- [ ] **步骤 6：运行完整回归验证**

在开发仓库运行：

```bash
docker compose -f docker-compose.test.yml up -d postgres
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
npm test --workspaces
npm run build --workspaces
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
npm run test:e2e
npm run test:package
git diff --check
```

- [ ] **步骤 7：提交并请求审查**

```bash
git add README.md AGENTS.md docs/verification/windows11-amd64-package.md
git commit -m "docs: add Windows 11 amd64 deployment guide"
```

使用 superpowers:requesting-code-review 对照 `2026-09-16-windows11-amd64-offline-package-design.md` 审查平台边界、PowerShell 注入防护、归档白名单和实机证据。处理反馈后重新运行步骤 6。
