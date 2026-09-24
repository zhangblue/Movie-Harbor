# Movie Harbor 内容导入 CLI 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 构建一个可断点续传的 Node.js CLI，通过现有 Movie Harbor 管理 API 把导出 JSON 及本地媒体安全导入到全新平台，并自动补充缺失题材。

**架构：** CLI 先完成 JSON、重名和媒体真实路径预检，再通过 Cookie、CSRF 与乐观版本调用现有 API。校验、路径、进度、HTTP 和导入编排各处于专注模块；媒体使用原生流式 multipart，进度绑定源摘要与目标 origin，并在每个成功步骤后原子落盘。

**技术栈：** Node.js 24+ ESM、内置 `http`/`https` 与文件流、`node:crypto`、Node.js test runner、Docker Compose、Playwright。

---

## 文件结构

- 创建 `tools/import-content.mjs`：CLI 参数、隐藏密码、依赖组装、日志与退出码。
- 创建 `tools/content-import/schema.mjs`：读取、散列并严格校验导出 JSON。
- 创建 `tools/content-import/media-path.mjs`：安全映射 `/media/...`。
- 创建 `tools/content-import/progress.mjs`：校验并原子保存进度。
- 创建 `tools/content-import/client.mjs`：认证、JSON 请求、错误分类和流式上传。
- 创建 `tools/content-import/importer.mjs`：题材、冲突、电影与剧集导入状态机。
- 创建 `tests/content-import-{schema,progress,client,importer,cli}.test.mjs`：模块契约测试。
- 创建 `tests/e2e/import.spec.ts`：真实 Compose 导入验收。
- 修改 `playwright.config.ts`、`package.json`、`README.md`。

### 任务 1：导出 JSON 与媒体目录预检

**文件：**

- 创建：`tools/content-import/schema.mjs`
- 创建：`tools/content-import/media-path.mjs`
- 创建：`tests/content-import-schema.test.mjs`
- 修改：`package.json`

- [ ] **步骤 1：编写失败的结构与路径测试**

使用临时目录创建有效与恶意夹具：

```js
test("loads valid export and resolves controlled media", async () => {
  const fixture = await exportFixture({ movies: [movie("Movie")] });
  const loaded = await loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot);
  assert.equal(loaded.movies[0].video.localPath, fixture.videoPath);
  assert.match(loaded.identity.sha256, /^[a-f0-9]{64}$/);
});

test("rejects duplicate names in one content type", async () => {
  const fixture = await exportFixture({ movies: [movie("Same"), movie("Same")] });
  await assert.rejects(
    loadAndValidateExport(fixture.jsonPath, fixture.mediaRoot),
    /duplicate movie name: Same/,
  );
});
```

再覆盖：缺字段/错类型、空名称、同剧重复季集号、非正编号、`/media/poster/../../outside`、错误媒体用途、指向根外的符号链接、缺失文件和非普通文件。

- [ ] **步骤 2：运行测试确认 RED**

```bash
node --test tests/content-import-schema.test.mjs
```

预期：FAIL，两个模块尚不存在。

- [ ] **步骤 3：实现受控路径**

```js
export async function resolveMediaReference(mediaRoot, mediaPath, expectedKind) {
  if (mediaPath === null) return null;
  const prefix = `/media/${expectedKind}/`;
  if (!mediaPath.startsWith(prefix) || mediaPath.includes("\\") || mediaPath.includes("\0")) {
    throw new Error(`invalid ${expectedKind} media path`);
  }
  const root = await realpath(mediaRoot);
  const actual = await realpath(resolve(root, mediaPath.slice("/media/".length)));
  const remainder = relative(root, actual);
  if (remainder.startsWith("..") || isAbsolute(remainder)) throw new Error("media path escapes media root");
  const info = await stat(actual);
  if (!info.isFile()) throw new Error("media path is not a regular file");
  return { sourcePath: mediaPath, localPath: actual, byteSize: info.size };
}
```

在 `realpath` 前拒绝空分段、`.`、`..` 和用途错误；把 `ENOENT` 转成含源媒体路径的稳定错误。

- [ ] **步骤 4：实现严格解析和身份**

```js
export async function loadAndValidateExport(jsonPath, mediaRoot) {
  const bytes = await readFile(jsonPath);
  const parsed = JSON.parse(bytes);
  const identity = {
    exportedAt: requireTimestamp(parsed.exported_at),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return { identity, movies: await parseMovies(parsed, mediaRoot), series: await parseSeries(parsed, mediaRoot) };
}
```

使用 object、string、nullable integer、string array 专用读取函数；契约字段不可省略，对象可含未来字段。用 `Set` 拒绝电影名、剧集名和单剧季集组合重复。

- [ ] **步骤 5：接入脚本、验证并提交**

`package.json` 增加：

```json
"test:content-import": "node --test tests/content-import-*.test.mjs"
```

```bash
npm run test:content-import
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
git diff --check
git add package.json tools/content-import/schema.mjs tools/content-import/media-path.mjs tests/content-import-schema.test.mjs
git commit -m "feat: validate content import sources"
```

### 任务 2：安全且可恢复的进度文件

**文件：**

- 创建：`tools/content-import/progress.mjs`
- 创建：`tests/content-import-progress.test.mjs`

- [ ] **步骤 1：编写失败测试**

覆盖首次创建、保存与恢复、目标/源不匹配、格式版本、`0600`、临时文件清理，以及 rename 失败不破坏正式文件：

```js
test("persists successful state with private permissions", async () => {
  const store = await openProgressStore({ path, targetOrigin, sourceIdentity });
  store.state.movies.Movie = { id: "movie-id", version: 2, metadataUpdated: true };
  await store.save();
  const restored = await openProgressStore({ path, targetOrigin, sourceIdentity });
  assert.deepEqual(restored.state.movies.Movie, store.state.movies.Movie);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
```

- [ ] **步骤 2：运行 RED**

运行：`node --test tests/content-import-progress.test.mjs`

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现格式与校验**

```js
const EMPTY_PROGRESS = {
  formatVersion: 1,
  targetOrigin: "",
  source: { exportedAt: "", sha256: "" },
  genres: {}, movies: {}, series: {},
};

export async function openProgressStore({ path, targetOrigin, sourceIdentity, fs = defaultFs }) {
  // 不存在则绑定当前身份；存在则严格校验版本、origin、exportedAt、sha256。
}
```

映射键使用任务 1 已保证唯一的名称；禁止认证信息和完整响应。

- [ ] **步骤 4：实现原子保存**

同目录随机临时名，以 `flag: "wx"`、`mode: 0o600` 写完整 JSON，`FileHandle.sync()`、关闭、`rename`，finally 只清理本次临时文件；正式文件再 `chmod(0o600)`。注入文件操作仅用于测试 rename 失败。

- [ ] **步骤 5：验证并提交**

```bash
npm run test:content-import
git diff --check
git add tools/content-import/progress.mjs tests/content-import-progress.test.mjs
git commit -m "feat: persist content import progress"
```

### 任务 3：认证 API 与流式 multipart 客户端

**文件：**

- 创建：`tools/content-import/client.mjs`
- 创建：`tests/content-import-client.test.mjs`

- [ ] **步骤 1：编写失败的认证和错误测试**

启动仅监听 `127.0.0.1` 的 fake HTTP 服务：

```js
test("retains cookie and authorizes writes", async () => {
  const server = await fakeMovieHarbor();
  const client = createAdminClient(server.origin);
  await client.login("admin", "secret");
  await client.json("POST", "/api/admin/genres", { name: "自定义" });
  assert.equal(server.requests[1].headers.cookie, "mh_session=session-value");
  assert.equal(server.requests[2].headers["x-csrf-token"], "csrf-value");
});
```

测试 URL 只接受无凭据且无路径的 HTTP/HTTPS origin；登录 Cookie；session CSRF；业务 `4xx` 为内容错误；`401/403`、连接拒绝、超时、响应中断为致命错误；摘要限长且不含密码、Cookie、Token。

- [ ] **步骤 2：编写失败的流式上传测试**

用大于多个 `highWaterMark` 的文件和慢速服务端制造背压：

```js
test("streams one file with exact multipart length", async () => {
  const result = await client.upload("/api/admin/media/movies/id/video?version=2", media);
  assert.equal(result.version, 3);
  assert.equal(received.headers["content-length"], String(received.body.length));
  assert.match(received.body.toString("latin1"), /name="file"; filename="movie.mp4"/);
});
```

覆盖文件读取错误、远端提前关闭、超时、不支持扩展名和 CR/LF 文件名；注入 `createReadStream` 包装器证明分块读取。

- [ ] **步骤 3：运行 RED**

运行：`node --test tests/content-import-client.test.mjs`

预期：FAIL，模块不存在。

- [ ] **步骤 4：实现错误类型、origin 与认证**

```js
export class ImportRequestError extends Error {
  constructor(message, { fatal = false, category = "content", status } = {}) {
    super(message);
    this.fatal = fatal;
    this.category = category;
    this.status = status;
  }
}
```

`createAdminClient(target, { timeoutMs = 30_000 })` 规范化 origin，拒绝凭据、路径、查询和 fragment。共享 `request()` 限长读取响应、管理 timeout、保存 Cookie。登录严格执行 login → session。

- [ ] **步骤 5：实现 JSON 与 multipart**

JSON 设置准确长度。上传用随机 boundary，预计算：

```js
const prefix = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
  `Content-Type: ${mimeType}\r\n\r\n`,
);
const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
const contentLength = prefix.length + byteSize + suffix.length;
```

使用 `createReadStream` 与显式背压循环发送；最后 `request.end(suffix)`。一侧错误销毁另一侧。MIME 映射覆盖 JPEG、PNG、WebP；视频仅支持 MP4、WebM（按用户最终裁决）。multipart 按实际传输进展刷新空闲超时，同时保护连接停滞和发送完成后的响应等待；JSON 请求保留明确总时限。

- [ ] **步骤 6：验证并提交**

```bash
npm run test:content-import
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
git diff --check
git add tools/content-import/client.mjs tests/content-import-client.test.mjs
git commit -m "feat: add streaming admin import client"
```

### 任务 4：题材、冲突与电影断点导入

**文件：**

- 创建：`tools/content-import/importer.mjs`
- 创建：`tests/content-import-importer.test.mjs`

- [ ] **步骤 1：编写失败的题材与冲突测试**

用 fake client 和真实 progress store 覆盖启用题材复用、缺失创建、并发冲突后重读、停用同名致命停止、电影/剧集同名互不冲突、外部同类型同名 `SKIP` 并继续：

```js
test("creates missing genres and skips only same-kind conflicts", async () => {
  const result = await importContent({ source, client, progress, logger });
  assert.deepEqual(client.createdGenres, ["自定义"]);
  assert.deepEqual(result.skipped, [{ kind: "movie", name: "Existing" }]);
  assert.ok(client.createdSeries.includes("Existing"));
});
```

- [ ] **步骤 2：编写失败的电影恢复测试**

覆盖 create → metadata → poster → video 版本传递、空媒体、业务失败继续、网络/认证失败停止、成功才保存、重跑不重复、进度目标 404 或版本变化只失败当前项：

```js
test("resumes failed movie video without repeating successful steps", async () => {
  await assert.rejects(firstRun(), /connection lost/);
  assert.equal(progress.state.movies.Movie.posterUploaded, true);
  await secondRun();
  assert.equal(client.count("create-movie"), 1);
  assert.equal(client.count("movie-poster"), 1);
  assert.equal(client.count("movie-video"), 2);
});
```

- [ ] **步骤 3：运行 RED**

运行：`node --test tests/content-import-importer.test.mjs`

预期：FAIL，importer 不存在。

- [ ] **步骤 4：实现题材与分页冲突索引**

```js
export async function importContent({ source, client, progress, logger }) {
  const genreIds = await syncGenres({ source, client, progress, logger });
  const conflicts = await loadConflictIndex(client);
  return runContentImports({ source, client, progress, logger, genreIds, conflicts });
}

export async function syncGenres({ source, client, progress, logger }) {
  const requiredNames = collectGenreNames(source);
  return reconcileGenreNames({ requiredNames, client, progress, logger });
}
```

GET genres 精确匹配；停用同名在内容写入前致命失败。缺失题材成功后记录 ID 并保存；创建冲突只能重 GET 后找到启用同名项。

分页读取 `/api/admin/contents?kind=movie&page=N` 和 series，直到收满 `total`。进度中已有 ID 的源内容不做同名跳过。

- [ ] **步骤 5：实现电影状态机**

```js
progress.state.movies[name] = {
  id, version,
  metadataUpdated: true,
  posterUploaded: true,
  videoUploaded: false,
  completed: false,
};
```

每个成功响应后更新并等待 `save()`。恢复前 GET 目标，确认 `draft` 与版本一致。依次 POST create、PATCH metadata、可选 poster/video，最后完成；绝不 publish。致命错误停止，普通错误记 `FAILED` 并继续。汇总包含 completed、resumed、skipped、failed。

- [ ] **步骤 6：验证并提交**

```bash
npm run test:content-import
git diff --check
git add tools/content-import/importer.mjs tests/content-import-importer.test.mjs
git commit -m "feat: import movie drafts with resume support"
```

### 任务 5：剧集层级断点导入

**文件：**

- 修改：`tools/content-import/importer.mjs`
- 修改：`tests/content-import-importer.test.mjs`

- [ ] **步骤 1：编写失败的层级与双版本测试**

输入乱序季集，断言按季/集升序；父写使用上一 `version`/`series_version`，单集写使用单集版本：

```js
test("imports sorted hierarchy and propagates both versions", async () => {
  await importContent({ source, client, progress, logger });
  assert.deepEqual(client.hierarchyCalls, [
    "season:1@series:3",
    "episode:1x1@series:4",
    "episode-update:1x1@episode:1",
    "episode-video:1x1@episode:2",
    "season:2@series:7",
  ]);
});
```

- [ ] **步骤 2：编写失败的恢复测试**

分别在季创建、集创建、时长更新、视频上传后中断，再运行不得重复。覆盖 `null` 时长显式更新、空视频、一集业务失败使当前剧失败但继续下一内容，以及父/子版本改变不覆盖。

- [ ] **步骤 3：运行 RED**

```bash
node --test --test-name-pattern="series|season|episode" tests/content-import-importer.test.mjs
```

预期：FAIL，尚无剧集流程。

- [ ] **步骤 4：实现层级状态机**

```js
progress.state.series[name] = {
  id, version, metadataUpdated: true, posterUploaded: true,
  seasons: {
    "1": { id, episodes: {
      "1": { id, version, metadataUpdated: true, videoUploaded: true, completed: true },
    } },
  },
  completed: false,
};
```

创建季/集后从完整 `SeriesResponse` 按 number 找 ID 和父版本。PATCH 单集读取 `episode.version`、`series_version`；上传读取 `version`、`series_version`。恢复 GET 剧集并确认记录的季/集 ID、草稿状态与版本，异常只失败当前剧集。

- [ ] **步骤 5：验证并提交**

```bash
npm run test:content-import
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
git diff --check
git add tools/content-import/importer.mjs tests/content-import-importer.test.mjs
git commit -m "feat: import series hierarchy with resume support"
```

### 任务 6：CLI、真实 E2E 与文档

**文件：**

- 创建：`tools/import-content.mjs`
- 创建：`tests/content-import-cli.test.mjs`
- 创建：`tests/e2e/import.spec.ts`
- 修改：`package.json`
- 修改：`playwright.config.ts`
- 修改：`README.md`

- [ ] **步骤 1：编写失败的 CLI 测试**

导出可注入依赖的 `run(argv, dependencies)`，直接执行时才调用真实依赖。测试帮助、缺失/重复/未知参数、默认进度、pipe 密码、空密码、TTY raw mode 恢复、脱敏与退出码：

```js
test("uses a piped password without echoing it", async () => {
  const output = capture();
  const code = await run(validArgs, {
    readPassword: async () => "top-secret",
    loadAndValidateExport: async () => source,
    createAdminClient: () => client,
    openProgressStore: async () => progress,
    stdout: output, stderr: output,
  });
  assert.equal(code, 0);
  assert.doesNotMatch(output.text, /top-secret/);
});
```

- [ ] **步骤 2：运行 RED**

运行：`node --test tests/content-import-cli.test.mjs`

预期：FAIL，入口不存在。

- [ ] **步骤 3：实现 CLI 与 npm 命令**

精确解析 `--json`、`--media-root`、`--target`、`--admin-name`、`--help`；默认进度为 `\${jsonPath}.movie-harbor-import-progress.json`。TTY 密码使用 readline/raw mode，EOF、SIGINT、异常都恢复；pipe 读取一行。

顺序：参数 → 密码 → 完整预检 → 进度 → 登录 → importer → 汇总。只有 failed 为空才退出 0；冲突跳过仍成功。`package.json` 增加：

```json
"import:content": "node tools/import-content.mjs"
```

- [ ] **步骤 4：运行 CLI 与 Node 测试 GREEN**

```bash
npm run test:content-import
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
git diff --check
```

- [ ] **步骤 5：编写失败的真实 E2E**

在 `tests/e2e/import.spec.ts` 从 `E2E_RUN_DIR` 创建源 media；写有效 PNG、复制 runner 的 `sample.mp4`；生成含新题材、1 部电影、1 部剧集、2 季 2 集的 JSON；spawn CLI 并经 stdin 输入密码；用 AdminApi 断言草稿、题材、层级、时长和媒体；重跑无重复；另一进度路径遇同名打印 `SKIP` 且退出 0。

Playwright 项目链增加：

```ts
{ name: "import", testMatch: /import\\.spec\\.ts/, dependencies: ["export"] },
{ name: "playback", testMatch: /playback\\.spec\\.ts/, dependencies: ["import"] },
```

运行：`npm run test:e2e -- --project=import`

预期：首次 RED，暴露真实契约差异。

- [ ] **步骤 6：最小修正并确认 E2E GREEN**

只修正 Cookie、Origin、CSRF、分页、版本、上传长度、`series_version` 或格式差异，不扩展规格。重跑聚焦 E2E 至通过。

- [ ] **步骤 7：更新 README**

在导出章节后加入命令示例，并明确交互密码、media-root 对应旧 `/media`、题材创建、全草稿、同名跳过、进度权限、同命令恢复、不可禁用 TLS，以及导入不等于备份恢复。

- [ ] **步骤 8：完整验证**

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

读取整组最新输出且全为 0 后才能声明完成。

- [ ] **步骤 9：提交**

```bash
git add tools/import-content.mjs tests/content-import-cli.test.mjs tests/e2e/import.spec.ts package.json playwright.config.ts README.md
git commit -m "feat: deliver resumable content import cli"
```

### 任务 7：最终范围审查

**文件：**

- 检查：`docs/superpowers/specs/2026-09-24-content-import-cli-design.md`
- 检查：本计划列出的全部实现与测试文件

- [ ] **步骤 1：逐项对照规格**

核对预检、题材、停用题材拒绝、同名跳过、草稿、层级、流式上传、断点身份、原子保存、错误分级、脱敏、退出码和 E2E。遗漏项回对应任务补失败测试与最小实现。

- [ ] **步骤 2：检查范围**

```bash
git status --short
git log --oneline --decorate -8
git diff main...HEAD --check
git diff --stat main...HEAD
```

预期：只有规格、计划和导入相关文件；没有媒体、进度、密码、Cookie、构建物或无关文件。

- [ ] **步骤 3：代码审查与复验**

使用 `superpowers:requesting-code-review` 审查完整分支，重点检查路径边界、认证泄露、multipart 流式正确性、断点版本一致性和 E2E 隔离性。修复必须修复项后重跑任务 6 步骤 8。
