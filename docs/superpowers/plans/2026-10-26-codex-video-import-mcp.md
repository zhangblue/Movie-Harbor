# Codex 本机视频入库 MCP 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在仓库根目录交付 TypeScript STDIO MCP，使 Codex 能用原子工具安全读取本地媒体、创建完整私密草稿、按需转换和上传视频，并在独立确认后发布，同时提供可重复执行的全局安装命令。

**架构：** MCP 工具层只注册独立能力并验证 schema，共享路径、媒体、HTTP 和上传逻辑位于专属服务；视频转换复用现有 Node 模块。后端增加受限 Bearer 主体和一次性海报暂存资产，继续复用领域服务、媒体存储、乐观版本和发布状态机。

**技术栈：** TypeScript 6、Node.js 24 ESM、`@modelcontextprotocol/server` 2.3.1、Zod 4、Node test runner；Rust 2024、Axum 0.8、SeaORM 1.1、PostgreSQL、Tokio；FFmpeg/FFprobe；Codex CLI STDIO MCP。

---

## 文件结构

- `mcp/package.json`、`mcp/package-lock.json`、`mcp/tsconfig.json`：独立构建和测试。
- `mcp/src/config.ts`：目标 URL、凭据文件、允许目录和生成目录。
- `mcp/src/server.ts`：创建 `McpServer`、注册工具并启动 STDIO。
- `mcp/src/schemas/`：工具输入输出 Zod schema。
- `mcp/src/services/`：路径、探测、转换、生成文件、API、上传和错误服务。
- `mcp/src/tools/`：本地媒体、目录、题材、电影、剧集、上传和发布工具。
- `mcp/tests/`：模块、工具、STDIO 和安装测试。
- `mcp/install.sh`：全局 Codex 安装入口。
- `tools/http/stream-multipart.mjs`：内容导入 CLI 与 MCP 共用的 multipart 文件流。
- `backend/src/auth/mcp.rs`：MCP Bearer 身份和精确路由策略。
- `backend/src/media/staged_poster.rs`：海报暂存、消费和过期清理。
- `backend/migration/src/m20261026_000007_mcp_staged_poster.rs`：暂存表。
- `docs/guides/codex-mcp.md`、`tests/e2e/mcp.spec.ts`：使用说明与隔离验收。

## 任务 1：建立 MCP 工程、配置和路径边界

**文件：**

- 创建：`mcp/package.json`
- 创建：`mcp/package-lock.json`
- 创建：`mcp/tsconfig.json`
- 创建：`mcp/src/config.ts`
- 创建：`mcp/src/services/path-policy.ts`
- 创建：`mcp/tests/config.test.ts`
- 创建：`mcp/tests/path-policy.test.ts`

- [ ] **步骤 1：创建依赖和严格配置**

```bash
mkdir mcp
cd mcp
npm init -y
npm install @modelcontextprotocol/server@2.3.1 zod@4
npm install --save-dev typescript@^6.0.2 tsx @types/node@^24
```

`package.json` 使用 ESM，并提供 `build: tsc -p tsconfig.json`、`test: node --import tsx --test tests/*.test.ts`、`start: node dist/server.js`。`tsconfig.json` 使用 `NodeNext`、`strict`、`noUncheckedIndexedAccess`，输出到 `dist/`。

- [ ] **步骤 2：编写配置和路径失败测试**

```ts
const config = await loadConfig(await privateConfigFixture(t, 0o600));
assert.equal(config.baseUrl.origin, "http://127.0.0.1:8080");
assert.match(config.apiKey, /^mhmcp_/);

await assert.rejects(loadConfig(await privateConfigFixture(t, 0o644)), /0600/);
await assert.rejects(inspectAllowedFile(outsideSymlink, [downloads]), /不在允许目录/);
const checked = await inspectAllowedFile(video, [downloads]);
await mutate(video);
await assert.rejects(revalidateAllowedFile(checked, [downloads]), /文件已经变化/);
```

- [ ] **步骤 3：运行测试确认 RED**

```bash
npm test --prefix mcp
```

预期：FAIL，配置和路径模块尚不存在。

- [ ] **步骤 4：实现最小接口**

```ts
export interface McpConfig {
  baseUrl: URL;
  apiKey: string;
  allowedRoots: string[];
  generatedRoot: string;
  requestTimeoutMs: number;
}
export interface CheckedFile {
  requestedPath: string;
  realPath: string;
  identity: { dev: bigint; ino: bigint; size: number; mtimeMs: number };
}
export async function loadConfig(env: NodeJS.ProcessEnv): Promise<McpConfig>;
export async function inspectAllowedFile(path: string, roots: string[]): Promise<CheckedFile>;
export async function revalidateAllowedFile(file: CheckedFile, roots: string[]): Promise<void>;
```

使用 `realpath`、`stat` 和 `relative` 的路径组件判断边界，不使用字符串前缀。

- [ ] **步骤 5：验证并提交**

```bash
npm test --prefix mcp
npm run build --prefix mcp
git diff --check
git add mcp
git commit -m "feat: 初始化 Movie Harbor MCP 工程"
```

## 任务 2：复用转换模块并交付本地媒体工具

**文件：**

- 创建：`mcp/src/schemas/media.ts`
- 创建：`mcp/src/services/media-inspector.ts`
- 创建：`mcp/src/services/video-converter.ts`
- 创建：`mcp/src/services/generated-files.ts`
- 创建：`mcp/src/types/video-conversion.d.ts`
- 创建：`mcp/src/tools/local-media.ts`
- 创建：`mcp/tests/local-media.test.ts`
- 修改：`tools/video-conversion/execute.mjs`
- 修改：`tools/video-conversion/plan.mjs`
- 测试：`tests/video-conversion-plan.test.mjs`
- 测试：`tests/video-conversion-cli.test.mjs`

- [ ] **步骤 1：编写探测、海报和泄漏失败测试**

```ts
const result = await inspectVideoTool({ path: fixture.mp4 }, dependencies);
assert.equal(result.structuredContent.duration_seconds, 10);
assert.equal(result.structuredContent.video.codec, "h264");
assert.equal(JSON.stringify(result).includes(fixture.bytes.toString("base64")), false);
await assert.rejects(validatePosterTool({ path: fakeJpeg }, dependencies), /图片内容与扩展名不匹配/);
```

- [ ] **步骤 2：编写转换和生成文件删除失败测试**

```ts
await assert.rejects(convertVideoTool({ path: input, confirmed: false }, deps), /需要明确确认/);
const converted = await convertVideoTool({ path: input, confirmed: true }, deps);
await assert.rejects(deleteGeneratedVideoTool({ path: input }, deps), /不是 MCP 生成文件/);
await deleteGeneratedVideoTool({ path: converted.structuredContent.output_path }, deps);
```

生成记录写入凭据目录的 `generated-files.json`，以 `0600` 临时文件原子替换，记录设备号、inode、大小和来源身份。

- [ ] **步骤 3：运行测试确认 RED**

```bash
npm test --prefix mcp -- --test-name-pattern="video|poster|convert|generated"
```

- [ ] **步骤 4：实现并注册独立工具**

保持现有 `probeMedia`、`buildConversionPlan`、`verifyRequiredEncoders`、`executeConversion` 行为；MCP 只增加类型声明并导入，不复制 FFmpeg 参数和信号逻辑。

```ts
server.registerTool("inspect_video", {
  inputSchema: inspectVideoInput,
  outputSchema: inspectVideoOutput,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, inspectVideoHandler);
```

同一模块分别注册 `validate_poster`、`convert_video`、`delete_generated_video`；后两项是写操作。

- [ ] **步骤 5：验证并提交**

```bash
npm test --prefix mcp
npm run build --prefix mcp
npm run test:video-conversion
git diff --check
git add mcp/src mcp/tests tools/video-conversion tests/video-conversion-*.test.mjs
git commit -m "feat: 添加 MCP 本地媒体工具"
```

## 任务 3：增加受限 MCP Bearer 身份

**文件：**

- 创建：`backend/src/auth/mcp.rs`
- 创建：`backend/tests/mcp_auth_test.rs`
- 修改：`backend/src/auth/mod.rs`
- 修改：`backend/src/auth/routes.rs`
- 修改：`backend/src/config.rs`
- 修改：`.env.example`
- 修改：`docker-compose.yml`

- [ ] **步骤 1：编写摘要和允许矩阵失败测试**

```rust
values.insert("MCP_API_KEY_SHA256", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
assert!(Config::from_lookup(lookup).unwrap().mcp_api_key_digest.is_some());

assert_eq!(mcp_get("/api/admin/genres", valid_key).await.status(), StatusCode::OK);
assert_eq!(mcp_delete("/api/admin/genres/id", valid_key).await.status(), StatusCode::UNAUTHORIZED);
assert_eq!(mcp_get("/api/admin/contents/export", valid_key).await.status(), StatusCode::UNAUTHORIZED);
assert_eq!(mcp_post("/api/admin/password", valid_key, json!({})).await.status(), StatusCode::UNAUTHORIZED);
```

补充错误摘要、多 Authorization、Basic scheme、管理员 Cookie/CSRF 回归，以及 Bearer 写请求无需 CSRF。

- [ ] **步骤 2：运行测试确认 RED**

```bash
cargo test -p movie-harbor-api --test mcp_auth_test -- --nocapture
```

- [ ] **步骤 3：实现主体和精确策略**

```rust
#[derive(Clone, Debug)]
pub enum ManagementPrincipal {
    Admin(session::CurrentSession),
    Mcp { key_digest: String },
}
pub fn route_allowed(method: &Method, path: &str) -> bool;
pub fn authenticate(headers: &HeaderMap, expected: Option<&str>) -> Option<ManagementPrincipal>;
```

Bearer 使用 SHA-256 和 `subtle::ConstantTimeEq`。中间件先验证 Host，再尝试 MCP；失败时进入现有 Cookie/CSRF。允许查询、题材创建、海报暂存、内容创建/更新、媒体上传和发布，默认拒绝。

- [ ] **步骤 4：接入环境、验证并提交**

`.env.example` 增加可空 `MCP_API_KEY_SHA256=`，Compose 只透传摘要。

```bash
cargo fmt --all -- --check
cargo test -p movie-harbor-api --test mcp_auth_test --test auth_test --test genres_test -- --nocapture
git diff --check
git add backend/src/auth backend/src/config.rs backend/tests/mcp_auth_test.rs .env.example docker-compose.yml
git commit -m "feat: 添加受限 MCP API 身份"
```

## 任务 4：实现一次性海报暂存资产

**文件：**

- 创建：`backend/migration/src/m20261026_000007_mcp_staged_poster.rs`
- 创建：`backend/src/entities/mcp_staged_poster.rs`
- 创建：`backend/src/media/staged_poster.rs`
- 创建：`backend/tests/mcp_staged_poster_test.rs`
- 修改：`backend/migration/src/lib.rs`
- 修改：`backend/src/entities/mod.rs`
- 修改：`backend/src/media/mod.rs`
- 修改：`backend/src/media/routes.rs`
- 修改：`backend/src/app.rs`

- [ ] **步骤 1：编写迁移、暂存和一次性消费失败测试**

```rust
let staged = stage_poster(&app, key, valid_png()).await;
assert_eq!(staged.status(), StatusCode::CREATED);
let token = body(staged).await["token"].as_str().unwrap().to_owned();
assert!(token.starts_with("mhposter_"));
let consumed = consume(&db, &token, principal).await.unwrap();
assert_eq!(consumed.asset.id, asset_id);
assert!(matches!(consume(&db, &token, principal).await, Err(StagedPosterError::NotFound)));
```

覆盖 token/asset 唯一约束、损坏图片、类型不匹配、超限、其他主体、过期清理和管理员不能调用暂存端点。

- [ ] **步骤 2：运行真实数据库测试确认 RED**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' \
  cargo test -p movie-harbor-api --test migration_test --test mcp_staged_poster_test -- --nocapture
```

- [ ] **步骤 3：实现表和服务**

表字段固定为 `id`、`token_hash`、`principal_hash`、`asset_id`、`created_at`、`expires_at`。上传调用现有 `store_new_asset` 创建已验证未归属资产，再插入暂存行；原始 token 只返回一次。

```rust
pub struct StagePosterCommand<'a, S> {
    pub db: &'a DatabaseConnection,
    pub storage: &'a LocalMediaStorage,
    pub policy: &'a UploadPolicy,
    pub principal_hash: &'a str,
    pub original_name: &'a str,
    pub declared_mime: &'a str,
    pub source: S,
}
pub async fn stage<S: ChunkSource + Send>(command: StagePosterCommand<'_, S>)
    -> Result<StagedPosterResponse, StagedPosterError>;
pub async fn lock_for_consumption<C: ConnectionTrait>(
    db: &C, raw_token: &str, principal_hash: &str, now: DateTime<FixedOffset>,
) -> Result<StagedPosterAsset, StagedPosterError>;
pub async fn cleanup_expired(
    db: &DatabaseConnection, storage: &LocalMediaStorage,
    now: DateTime<FixedOffset>, limit: u64,
) -> Result<u64, StagedPosterError>;
```

过期清理只处理暂存表明确记录的资产，复用 removal 协议；启动执行一次，每次新增前限量执行，不扫描媒体目录。

- [ ] **步骤 4：注册端点、验证并提交**

新增 `POST /api/admin/media/posters/stage`，响应 token、格式、大小和过期时间，设置 `cache-control: no-store`。

```bash
cargo fmt --all -- --check
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' \
  cargo test -p movie-harbor-api --test mcp_staged_poster_test --test media_upload_test --test media_removal_test --test migration_test -- --nocapture
git diff --check
git add backend/migration backend/src/entities backend/src/media backend/src/app.rs backend/tests
git commit -m "feat: 添加一次性 MCP 海报暂存"
```

## 任务 5：原子创建带海报的完整草稿

**文件：**

- 修改：`backend/src/movies/dto.rs`
- 修改：`backend/src/movies/routes.rs`
- 修改：`backend/src/movies/service.rs`
- 修改：`backend/src/movies/repository.rs`
- 修改：`backend/src/series/dto.rs`
- 修改：`backend/src/series/routes.rs`
- 修改：`backend/src/series/service.rs`
- 修改：`backend/src/series/repository.rs`
- 修改：`backend/tests/movies_test.rs`
- 修改：`backend/tests/series_test.rs`
- 修改：`backend/tests/mcp_staged_poster_test.rs`

- [ ] **步骤 1：编写电影和电视剧失败测试**

```rust
let response = mcp_create_movie(json!({
  "name":"示例电影", "is_private":true, "year":2024,
  "duration_seconds":7200, "genre_ids":[genre_id],
  "staged_poster_token":token
})).await;
assert_eq!(response.status(), StatusCode::CREATED);
assert_eq!(body(response).await["poster"]["id"], asset_id.to_string());
```

缺 token、过期 token、非私密、空题材或无效时长返回 `422` 且不创建记录；数据库失败时 token 可重试。电视剧必须原子绑定海报、年代、题材和私密状态；单集创建接受 `duration_seconds` 并保持父子版本语义。

- [ ] **步骤 2：运行测试确认 RED**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' \
  cargo test -p movie-harbor-api --test movies_test --test series_test --test mcp_staged_poster_test -- --nocapture
```

- [ ] **步骤 3：扩展 DTO 并实现事务**

```rust
pub struct CreateMovieRequest {
    pub name: String,
    pub is_private: bool,
    #[serde(default)] pub year: Option<i32>,
    #[serde(default)] pub duration_seconds: Option<i32>,
    #[serde(default)] pub genre_ids: Option<Vec<String>>,
    #[serde(default)] pub staged_poster_token: Option<String>,
}
```

电视剧对应包含 `year`、`genre_ids`、`staged_poster_token`；单集增加 `duration_seconds`。管理员主体保持旧输入；MCP 主体要求完整字段。电影和电视剧服务分别在一个事务中锁 token、验证题材、创建内容并引用资产、写题材关系、删除暂存行；失败不消费 token。

- [ ] **步骤 4：验证并提交**

```bash
cargo fmt --all -- --check
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' \
  cargo test -p movie-harbor-api --test movies_test --test series_test --test mcp_staged_poster_test --test media_upload_test -- --nocapture
git diff --check
git add backend/src/movies backend/src/series backend/src/media/staged_poster.rs backend/tests
git commit -m "feat: 原子创建带海报的 MCP 草稿"
```

## 任务 6：共享 multipart 流并实现 MCP API 客户端

**文件：**

- 创建：`tools/http/stream-multipart.mjs`
- 创建：`tools/http/stream-multipart.d.ts`
- 创建：`mcp/src/services/movie-harbor-client.ts`
- 创建：`mcp/src/services/upload-stream.ts`
- 创建：`mcp/src/services/error-mapper.ts`
- 创建：`mcp/tests/client.test.ts`
- 修改：`tools/content-import/client.mjs`
- 修改：`tests/content-import-client.test.mjs`

- [ ] **步骤 1：编写共享流和 Bearer 客户端失败测试**

```js
const multipart = createMultipartFileBody(media);
assert.equal(multipart.headers["content-length"], String(prefix + media.byteSize + suffix));
await multipart.writeTo(slowWritable);
assert.equal(maxBufferedBytes < media.byteSize, true);
```

```ts
await client.json("GET", "/api/admin/genres");
assert.equal(request.headers.authorization, "Bearer " + key);
assert.equal(request.headers.cookie, undefined);
assert.equal(request.headers["x-csrf-token"], undefined);
```

覆盖文件变化、远端中断、`401/403`、`409`、`422`、有界响应和超时。

- [ ] **步骤 2：运行测试确认 RED**

```bash
node --test tests/content-import-client.test.mjs
npm test --prefix mcp -- --test-name-pattern="client|multipart"
```

- [ ] **步骤 3：实现共享原语和客户端**

```js
export function createMultipartFileBody({ localPath, fileName, mimeType, byteSize }) {
  const { headers, prefix, suffix } = multipartParts({ fileName, mimeType, byteSize });
  return { headers, async writeTo(request, { createStream = createReadStream } = {}) {
    await writeChunk(request, prefix);
    let sent = 0;
    for await (const chunk of createStream(localPath)) {
      sent += chunk.length;
      if (sent > byteSize) throw new Error("file size changed");
      await writeChunk(request, chunk);
    }
    if (sent !== byteSize) throw new Error("file size changed");
    request.end(suffix);
  } };
}
```

同文件实现并测试 `multipartParts` 和基于写回调的 `writeChunk`，使每个分块在实际写入完成后再读取下一块。

该模块只拥有 multipart 和流生命周期，不知道认证或业务。内容导入客户端改为调用它，Cookie/CSRF 行为不变。

```ts
export interface MovieHarborClient {
  json<T>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
  upload<T>(path: string, file: CheckedFile, mimeType: string, onProgress?: Progress): Promise<T>;
}
```

客户端只接受受控相对 API 路径，错误只保留状态、稳定 code、字符串 fields 和限长摘要。

- [ ] **步骤 4：验证并提交**

```bash
node --test tests/content-import-client.test.mjs
npm test --prefix mcp
npm run build --prefix mcp
git diff --check
git add tools/http tools/content-import/client.mjs tests/content-import-client.test.mjs mcp/src/services mcp/tests/client.test.ts
git commit -m "refactor: 共享媒体流式上传"
```

## 任务 7：实现目录、题材、电影和剧集原子工具

**文件：**

- 创建：`mcp/src/schemas/common.ts`
- 创建：`mcp/src/schemas/content.ts`
- 创建：`mcp/src/tools/catalog.ts`
- 创建：`mcp/src/tools/genres.ts`
- 创建：`mcp/src/tools/movies.ts`
- 创建：`mcp/src/tools/series.ts`
- 创建：`mcp/tests/content-tools.test.ts`

- [ ] **步骤 1：编写注册、同名和 schema 失败测试**

```ts
assert.deepEqual(toolNames, [
  "search_movies", "search_series", "get_series_structure", "list_genres",
  "create_genre", "stage_poster", "create_movie", "create_series",
  "create_season", "create_episode", "update_movie_metadata",
  "update_series_metadata", "update_episode_metadata"
]);
assert.equal(tool("search_movies").annotations.readOnlyHint, true);
assert.equal(tool("create_movie").annotations.readOnlyHint, false);
assert.equal((await searchMovies({ name: "  Alien " })).matches.length, 2);
await assert.rejects(createGenre({ name: "奇幻" }, disabledConflictClient), /同名题材已停用/);
```

Zod 必须在 HTTP 前拒绝缺少年代、时长、题材、单集名或海报 token 的创建调用。

- [ ] **步骤 2：运行测试确认 RED**

```bash
npm test --prefix mcp -- --test-name-pattern="catalog|genre|movie|series|episode"
```

- [ ] **步骤 3：实现独立工具和结果**

各模块分别导出 `registerCatalogTools`、`registerGenreTools`、`registerMovieTools` 和 `registerSeriesTools`；每个 handler 只调用一个领域 API 或明确的题材冲突恢复。统一返回：

```ts
return {
  content: [{ type: "text", text: summary }],
  structuredContent: { id, version, status, next_actions }
};
```

不增加复合导入工具；工作流顺序写入 server instructions。

- [ ] **步骤 4：验证并提交**

```bash
npm test --prefix mcp
npm run build --prefix mcp
git diff --check
git add mcp/src/schemas mcp/src/tools mcp/tests/content-tools.test.ts
git commit -m "feat: 添加 MCP 内容原子工具"
```

## 任务 8：实现上传、替换、发布和 STDIO 服务

**文件：**

- 创建：`mcp/src/tools/uploads.ts`
- 创建：`mcp/src/tools/publishing.ts`
- 创建：`mcp/src/server.ts`
- 创建：`mcp/tests/upload-publish-tools.test.ts`
- 创建：`mcp/tests/server.test.ts`

- [ ] **步骤 1：编写上传替换与发布失败测试**

```ts
await assert.rejects(uploadMovieVideo({ movie_id, version, path }, occupiedClient), /已有视频.*replace_movie_video/);
await assert.rejects(replaceMovieVideo({ movie_id, version, path, confirmed: false }, client), /需要明确确认替换/);
await assert.rejects(publishMovie({ movie_id, version, confirmed: false }), /需要独立发布确认/);
await publishEpisode({ series_id, season_id, episode_id, version, confirmed: true });
await publishSeries({ series_id, version: returnedSeriesVersion, confirmed: true });
```

断言上传工具不调用发布接口；发布遇 archived 不调用 draft 或归档端点；执行上传前重新验证文件身份。

- [ ] **步骤 2：编写服务初始化失败测试**

使用 SDK 内存 transport 验证 server info、instructions、全部 schema 和结构化输出；子进程启动 `dist/server.js` 时 stdout 只含协议，诊断只写 stderr。

- [ ] **步骤 3：运行测试确认 RED**

```bash
npm test --prefix mcp -- --test-name-pattern="upload|replace|publish|server"
```

- [ ] **步骤 4：实现工具和 server factory**

```ts
export function buildServer(services: Services): McpServer {
  const server = new McpServer({ name: "movie-harbor", version: "0.1.0" });
  registerLocalMediaTools(server, services);
  registerCatalogTools(server, services);
  registerGenreTools(server, services);
  registerMovieTools(server, services);
  registerSeriesTools(server, services);
  registerUploadTools(server, services);
  registerPublishingTools(server, services);
  return server;
}
await serveStdio(() => buildServer(createServices(await loadConfig(process.env))));
```

instructions 明确转换、入库和发布三次确认、海报必需、私密草稿和禁止自动发布。

- [ ] **步骤 5：验证并提交**

```bash
npm test --prefix mcp
npm run build --prefix mcp
git diff --check
git add mcp/src/tools mcp/src/server.ts mcp/tests
git commit -m "feat: 交付 Movie Harbor STDIO MCP"
```

## 任务 9：实现 Codex 全局安装命令

**文件：**

- 创建：`mcp/install.sh`
- 创建：`mcp/tests/install.test.ts`
- 修改：`.gitignore`

- [ ] **步骤 1：编写隔离安装失败测试**

测试使用临时 `HOME`、`CODEX_HOME` 和 fake `codex`：

```ts
const first = await runInstaller(fixture);
assert.equal(first.code, 0);
assert.deepEqual(fixture.codexCalls.at(-1), ["mcp", "add", "movie-harbor", "--env", expectedConfig, "--", "node", absoluteEntry]);
assert.equal((await stat(credentials)).mode & 0o777, 0o600);
const second = await runInstaller(fixture);
assert.equal(second.code, 0);
assert.equal(configuredServersNamed("movie-harbor"), 1);
```

覆盖缺 Node/npm/Codex/FFmpeg/FFprobe、路径含空格、同名条目属于其他工程、构建失败和日志不得包含原始 key。

- [ ] **步骤 2：运行测试确认 RED**

```bash
npm test --prefix mcp -- --test-name-pattern="install"
```

- [ ] **步骤 3：实现凭据、构建和安全更新**

脚本使用 `set -eu`、自身路径和 `umask 077`，创建 `~/.config/movie-harbor-mcp/config.env` 与 `credentials.env`。密钥通过隐藏输入或安全生成，不进入参数或日志。

先运行 `codex mcp list --json`。不存在则 add；存在时通过 `codex mcp get movie-harbor` 验证入口属于本仓库，匹配才 remove 后 add，不匹配就停止。不得直接编辑或整体覆盖 `config.toml`。

```bash
codex mcp add movie-harbor \
  --env "MOVIE_HARBOR_MCP_CONFIG=$config_file" \
  -- node "$repo_root/mcp/dist/server.js"
```

本地部署可在交互确认后只更新当前仓库 `.env` 的摘要字段并保留备份，但不得自动重启 Compose；远程目标只显示摘要配置步骤，不显示原始 key。

- [ ] **步骤 4：验证并提交**

```bash
npm test --prefix mcp -- --test-name-pattern="install"
sh -n mcp/install.sh
npm run build --prefix mcp
git diff --check
git add mcp/install.sh mcp/tests/install.test.ts .gitignore
git commit -m "feat: 添加 Codex MCP 全局安装命令"
```

## 任务 10：文档、隔离 E2E 和完成验证

**文件：**

- 创建：`docs/guides/codex-mcp.md`
- 创建：`tests/e2e/mcp.spec.ts`
- 修改：`README.md`
- 修改：`tests/documentation.test.mjs`
- 修改：`playwright.config.ts`
- 修改：`package.json`

- [ ] **步骤 1：扩展文档测试并确认 RED**

```bash
node --test tests/documentation.test.mjs
```

预期：FAIL，新指南尚未从 README 导航。

- [ ] **步骤 2：编写指南和根命令**

指南写明 `./mcp/install.sh`、密钥分离、Codex 验证、允许目录、海报必填、年代/题材、三类确认、FFmpeg、版本冲突、轮换和卸载。根 `package.json` 增加：

```json
{
  "scripts": {
    "build:mcp": "npm run build --prefix mcp",
    "test:mcp": "npm test --prefix mcp"
  }
}
```

- [ ] **步骤 3：编写隔离 E2E 失败测试**

在 `E2E_RUN_DIR` 生成图片和小视频，通过 MCP SDK 客户端启动 STDIO，依次调用：

```text
validate_poster → inspect_video → list_genres → create_genre
→ stage_poster → create_movie → upload_movie_video → publish_movie
```

再覆盖电视剧、季、单集、发布单集和父剧；断言新内容私密、普通用户可见、匿名不可见。使用不兼容 fixture 验证同意转换后上传和生成文件清理。

- [ ] **步骤 4：运行聚焦 E2E 并完成接线**

```bash
npm run test:e2e -- --project=mcp
```

预期首次 FAIL，暴露真实 Compose、MCP 启动或版本契约差异；只修正规格内接线和测试 fixture。

- [ ] **步骤 5：运行相关和完整验证**

```bash
node --test tests/documentation.test.mjs
npm run test:mcp
npm run build:mcp
npm run test:content-import
npm run test:video-conversion
docker compose -f docker-compose.test.yml up -d postgres
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
npm test --workspaces
npm run build --workspaces
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
npm run test:e2e
git diff --check
git status --short
```

只报告实际读取到退出码为 0 的命令。E2E 使用隔离 Compose 和数据目录，不读取真实 Downloads 媒体。

- [ ] **步骤 6：规格自检并提交**

核对原子工具、公共服务、独立密钥、精确权限、海报原子创建、路径边界、元数据、转换确认、替换确认、发布确认、生成文件清理和全局安装。确认不存在 `execute_video_import` 复合工具或跨领域 `utils`。

```bash
git add README.md package.json playwright.config.ts docs/guides/codex-mcp.md tests/documentation.test.mjs tests/e2e/mcp.spec.ts
git commit -m "docs: 交付 Codex 视频入库 MCP 指南"
```

## 计划自检映射

- MCP 目录和 TypeScript：任务 1、2、7、8。
- 原子工具和公共服务：任务 2、6、7、8。
- 独立密钥和最小权限：任务 3。
- 服务端验证海报后创建：任务 4、5。
- 年代、题材、时长、层级和私密草稿：任务 5、7。
- 不兼容格式经确认转换：任务 2、8、10。
- 上传与替换分离：任务 8。
- 独立发布确认：任务 8、10。
- 允许目录和符号链接防护：任务 1、2、8。
- 转换文件成功删除、失败保留：任务 2、8。
- Codex 全局单命令安装：任务 9。
- 文档、隔离 E2E 和完整回归：任务 10。
