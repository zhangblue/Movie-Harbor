# MCP 元数据补全、访问范围与电影分钟制实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Movie Harbor MCP 在完整入库确认后，以默认公开或明确私密的范围创建带简介的电影和剧集，对电影统一使用整数分钟，并要求入库写操作携带确认；同时约束 Codex 联网补全缺失元数据和单集名称。

**架构：** Codex 负责联网搜索、来源比较、展示完整计划和取得用户确认；MCP 保持原子工具，只验证参数、换算电影时长并调用现有 Movie Harbor API。后端继续使用 `is_private` 和 `duration_seconds`，MCP 边界使用 `visibility` 和电影专属 `duration_minutes`，共享 schema/helper 负责唯一映射。

**技术栈：** TypeScript 6、Node.js 26 ESM、Node test runner、Zod 4、Model Context Protocol TypeScript SDK；Movie Harbor 现有 Rust/Axum API（不修改）。

**设计依据：** `docs/superpowers/specs/2026-10-27-mcp-metadata-visibility-design.md`

---

## 文件结构

- 修改 `mcp/src/schemas/common.ts`：定义简介、访问范围、确认标记、电影分钟边界和秒/分钟转换函数。
- 修改 `mcp/src/schemas/content.ts`：调整创建、更新和搜索 schema，给入库内容写操作增加确认参数。
- 修改 `mcp/src/tools/catalog.ts`：电影候选从 API 秒数转换为整数分钟。
- 修改 `mcp/src/tools/movies.ts`：创建电影映射简介、访问范围和分钟；更新电影把分钟转换回秒；海报暂存增加确认守卫。
- 修改 `mcp/src/tools/series.ts`：创建剧集映射简介和访问范围；创建季、单集剥离确认字段后调用 API。
- 修改 `mcp/src/tools/genres.ts`：创建题材必须有入库确认且不向 API 转发确认字段。
- 修改 `mcp/src/tools/uploads.ts`：普通上传和替换上传都必须携带入库确认。
- 修改 `mcp/src/server.ts`：声明联网补全、来源展示、默认公开、单集名称补全和确认失效规则。
- 修改 `mcp/tests/content-tools.test.ts`：覆盖电影分钟制、简介、访问范围、层级创建和题材/海报确认。
- 修改 `mcp/tests/upload-publish-tools.test.ts`：覆盖普通上传和替换上传确认。
- 修改 `mcp/tests/server.test.ts`：覆盖工作流说明和工具 JSON schema。
- 修改 `docs/guides/codex-mcp.md`：说明完整元数据计划、来源、默认公开和重新安装步骤。

## 任务 1：交付电影简介、访问范围和整数分钟契约

**文件：**

- 修改：`mcp/src/schemas/common.ts`
- 修改：`mcp/src/schemas/content.ts`
- 修改：`mcp/src/tools/catalog.ts`
- 修改：`mcp/src/tools/movies.ts`
- 测试：`mcp/tests/content-tools.test.ts`

- [ ] **步骤 1：编写电影契约失败测试**

在 `mcp/tests/content-tools.test.ts` 中保持电影 fixture 为后端秒制，并新增/修改断言：

```ts
test('movie creation requires synopsis and confirmation, defaults public, and sends minutes as seconds', async () => {
  const f = clientFixture([
    { ...movie, duration_seconds: 7020, is_private: false },
    { ...movie, duration_seconds: 7020, is_private: true },
  ]);
  const t = await tools(f.client);
  const common = {
    name: ' Alien ', synopsis: ' 太空货船遭遇未知生命。 ', year: 1979,
    genre_ids: [genreId], staged_poster_token: 'poster-token',
    duration_minutes: 117, confirmed: true,
  };
  await t.call('create_movie', common);
  await t.call('create_movie', { ...common, visibility: 'private' });
  assert.deepEqual(f.calls.map(call => call.body), [
    { name: 'Alien', synopsis: '太空货船遭遇未知生命。', year: 1979,
      genre_ids: [genreId], staged_poster_token: 'poster-token', duration_seconds: 7020, is_private: false },
    { name: 'Alien', synopsis: '太空货船遭遇未知生命。', year: 1979,
      genre_ids: [genreId], staged_poster_token: 'poster-token', duration_seconds: 7020, is_private: true },
  ]);
});

test('movie tools expose integer minutes and convert updates back to API seconds', async () => {
  const f = clientFixture([[{ ...movie, duration_seconds: 10176 }], movie]);
  const t = await tools(f.client);
  const found = await t.call('search_movies', { name: 'Alien' });
  assert.equal(found.matches[0].duration_minutes, 170);
  assert.equal('duration_seconds' in found.matches[0], false);
  await t.call('update_movie_metadata', { movie_id: movieId, version: 3, duration_minutes: 170 });
  assert.deepEqual(f.calls[1]!.body, { version: 3, duration_seconds: 10200 });
});
```

增加 `durationMinutesFromSeconds(10176.1) === 170`、不足一分钟最小为 `1`、超范围分钟被拒绝的直接断言。更新创建 schema 的拒绝列表，覆盖缺失/空白 `synopsis`、缺失或 `false` 的 `confirmed`、非法 `visibility`、旧字段 `duration_seconds` 和超范围 `duration_minutes`；断言失败时 `f.calls.length === 0`。增加后端返回错误访问范围或错误时长时按 `invalid_response` 拒绝的断言。把本文件中其余成功调用 `create_movie` 的 fixture 全部迁移到新字段，保证本任务结束时整个测试文件可独立通过。

- [ ] **步骤 2：运行聚焦测试验证 RED**

运行：

```bash
cd mcp
node --import tsx --test --test-concurrency=1 \
  --test-name-pattern='movie creation requires synopsis|movie tools expose integer minutes|schemas reject missing' \
  tests/content-tools.test.ts
```

预期：FAIL。失败显示当前 schema 仍要求 `duration_seconds`、创建仍强制 `is_private: true`、搜索仍返回 `duration_seconds`，或转换 helper 尚不存在；不能是 fixture、导入或语法错误。

- [ ] **步骤 3：实现共享电影分钟和访问范围边界**

在 `mcp/src/schemas/common.ts` 增加唯一公共定义：

```ts
export const maxDurationSeconds = 2_147_483_647;
export const synopsis = z.string().trim().min(1);
export const visibility = z.enum(['public', 'private']).default('public');
export const confirmed = z.literal(true);
export const durationMinutes = positiveInt.max(Math.floor(maxDurationSeconds / 60));

export function durationMinutesFromSeconds(seconds: number | null): number | null {
  if (seconds === null) return null;
  return Math.max(1, Math.round(seconds / 60));
}

export function durationSecondsFromMinutes(minutes: number): number {
  const seconds = minutes * 60;
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > maxDurationSeconds) {
    throw new Error('电影时长超出 Movie Harbor 支持范围');
  }
  return seconds;
}
```

让既有 `duration` 复用 `maxDurationSeconds`。在 `mcp/src/schemas/content.ts` 使用：

```ts
const createFields = { name, year, genre_ids: genreIds, staged_poster_token: token };
export const createMovieInput = z.strictObject({
  ...createFields, synopsis, duration_minutes: durationMinutes, visibility, confirmed,
});
export const createSeriesInput = z.strictObject(createFields);
export const updateMovieInput = z.strictObject({
  movie_id: id, version, ...metadata, duration_minutes: durationMinutes.optional(),
}).refine(value => [value.name, value.synopsis, value.year, value.genre_ids, value.duration_minutes]
  .some(field => field !== undefined), '至少提供一个修改字段');
```

把 `movieMatch.duration_seconds` 改成 `duration_minutes`。API response schema `apiMovie.duration_seconds` 保持不变。

- [ ] **步骤 4：实现电影工具双向映射**

在 `catalog.ts` 生成候选时使用：

```ts
duration_minutes: durationMinutesFromSeconds(movie.duration_seconds),
```

在 `movies.ts` 显式剥离 MCP 专属字段：

```ts
const { visibility, confirmed: _confirmed, duration_minutes, ...metadata } = createMovieInput.parse(input);
const movie = parseApi(apiMovie, await client.json('POST', '/api/admin/movies', {
  ...metadata,
  duration_seconds: durationSecondsFromMinutes(duration_minutes),
  is_private: visibility === 'private',
}));
if (movie.is_private !== (visibility === 'private')
  || movie.duration_seconds !== durationSecondsFromMinutes(duration_minutes)) {
  throw new MovieHarborClientError('invalid_response');
}
```

更新时把可选 `duration_minutes` 转为 `duration_seconds`，其他 patch 字段保持原样。创建结果文案根据范围显示公开或私密电影草稿；工具描述明确简介、整数分钟、默认公开和入库确认。

- [ ] **步骤 5：运行测试验证 GREEN 并提交**

```bash
cd mcp
node --import tsx --test --test-concurrency=1 tests/content-tools.test.ts
npm run build
cd ..
git diff --check
git add mcp/src/schemas/common.ts mcp/src/schemas/content.ts mcp/src/tools/catalog.ts mcp/src/tools/movies.ts mcp/tests/content-tools.test.ts
git commit -m "feat(MCP): 支持电影简介访问范围与分钟时长"
```

预期：内容工具测试全部通过，TypeScript 构建成功，提交只包含本任务文件。

## 任务 2：交付剧集完整元数据和内容层级确认

**文件：**

- 修改：`mcp/src/schemas/content.ts`
- 修改：`mcp/src/tools/series.ts`
- 测试：`mcp/tests/content-tools.test.ts`

- [ ] **步骤 1：编写剧集和单集失败测试**

在 `mcp/tests/content-tools.test.ts` 增加：

```ts
test('series creation requires synopsis and confirmation and defaults public', async () => {
  const f = clientFixture([{ ...series, is_private: false }, { ...series, is_private: true }]);
  const t = await tools(f.client);
  const common = {
    name: 'Alien', synopsis: '围绕未知生命展开的系列故事。', year: 1979,
    genre_ids: [genreId], staged_poster_token: 'poster-token', confirmed: true,
  };
  await t.call('create_series', common);
  await t.call('create_series', { ...common, visibility: 'private' });
  assert.deepEqual(f.calls.map(call => call.body), [
    { name: 'Alien', synopsis: '围绕未知生命展开的系列故事。', year: 1979,
      genre_ids: [genreId], staged_poster_token: 'poster-token', is_private: false },
    { name: 'Alien', synopsis: '围绕未知生命展开的系列故事。', year: 1979,
      genre_ids: [genreId], staged_poster_token: 'poster-token', is_private: true },
  ]);
});

test('season and named episode require confirmation without forwarding it', async () => {
  const f = clientFixture([series, series]);
  const t = await tools(f.client);
  await t.call('create_season', { series_id: seriesId, version: 2, number: 1, confirmed: true });
  await t.call('create_episode', {
    series_id: seriesId, season_id: seasonId, version: 2, number: 1,
    name: 'Pilot', duration_seconds: 500, confirmed: true,
  });
  assert.deepEqual(f.calls[0]!.body, { version: 2, number: 1 });
  assert.deepEqual(f.calls[1]!.body, { version: 2, number: 1, name: 'Pilot', duration_seconds: 500 });
});
```

补充无简介、空白简介、未确认、`confirmed: false`、空白单集名称的拒绝断言，并验证这些输入不会产生 HTTP 调用。增加后端返回错误 `is_private` 时按 `invalid_response` 拒绝的断言。把本文件中其余成功调用 `create_series`、`create_season` 和 `create_episode` 的 fixture 全部补齐新字段，保证整个测试文件保持 GREEN。

- [ ] **步骤 2：运行聚焦测试验证 RED**

```bash
cd mcp
node --import tsx --test --test-concurrency=1 \
  --test-name-pattern='series creation requires synopsis|season and named episode require confirmation' \
  tests/content-tools.test.ts
```

预期：FAIL。当前剧集仍强制私密，创建季和单集也不要求确认。

- [ ] **步骤 3：实现剧集和层级映射**

在 `mcp/src/schemas/content.ts` 给创建季和单集增加共享 `confirmed`：

```ts
export const createSeriesInput = z.strictObject({
  ...createFields, synopsis, visibility, confirmed,
});
export const createSeasonInput = z.strictObject({
  series_id: id, version, number: positiveInt.max(2_147_483_647), confirmed,
});
export const createEpisodeInput = z.strictObject({
  series_id: id, season_id: id, version, number: positiveInt.max(2_147_483_647),
  name, duration_seconds: duration, confirmed,
});
```

在 `mcp/src/tools/series.ts` 显式剥离确认和访问范围：

```ts
const { visibility, confirmed: _confirmed, ...metadata } = createSeriesInput.parse(input);
const series = parseApi(apiSeries, await client.json('POST', '/api/admin/series', {
  ...metadata, is_private: visibility === 'private',
}));
if (series.is_private !== (visibility === 'private')) {
  throw new MovieHarborClientError('invalid_response');
}

const { series_id, confirmed: _confirmed, ...body } = createSeasonInput.parse(input);
const { series_id, season_id, confirmed: _confirmed, ...body } = createEpisodeInput.parse(input);
```

创建剧集结果文案区分公开/私密草稿。更新三个工具描述，明确简介、默认公开、单集名称和入库确认；不增加季或单集的访问范围字段。

- [ ] **步骤 4：运行测试验证 GREEN 并提交**

```bash
cd mcp
node --import tsx --test --test-concurrency=1 tests/content-tools.test.ts
npm run build
cd ..
git diff --check
git add mcp/src/schemas/content.ts mcp/src/tools/series.ts mcp/tests/content-tools.test.ts
git commit -m "feat(MCP): 完整创建剧集和具名单集"
```

预期：内容工具测试全部通过，API body 中没有 `confirmed` 或 `visibility`。

## 任务 3：为题材、海报和全部视频上传增加入库确认

**文件：**

- 修改：`mcp/src/schemas/content.ts`
- 修改：`mcp/src/tools/genres.ts`
- 修改：`mcp/src/tools/movies.ts`
- 修改：`mcp/src/tools/uploads.ts`
- 测试：`mcp/tests/content-tools.test.ts`
- 测试：`mcp/tests/upload-publish-tools.test.ts`

- [ ] **步骤 1：编写其余写操作确认失败测试**

在 `content-tools.test.ts` 验证题材和海报在确认前不发出任何请求，确认字段不进入远端请求：

```ts
await assert.rejects(t.call('create_genre', { name: '奇幻' }));
await assert.rejects(t.call('create_genre', { name: '奇幻', confirmed: false }));
assert.equal(f.calls.length, 0);

const created = await t.call('create_genre', { name: '奇幻', confirmed: true });
assert.equal(created.reused, false);
assert.deepEqual(f.calls.at(-1)!.body, { name: '奇幻' });
```

更新真实海报暂存测试，先断言缺少/错误确认时服务端请求数仍为零，再用 `{ path, confirmed: true }` 完成现有成功断言。

在 `upload-publish-tools.test.ts` 增加：

```ts
test('every ordinary and replacement upload requires import confirmation', async t => {
  const f = await fixture(t);
  for (const [name, input] of [
    ['upload_movie_video', { movie_id: movieId, version: 3, path: f.path }],
    ['replace_movie_video', { movie_id: movieId, version: 3, path: f.path }],
    ['upload_episode_video', { series_id: seriesId, season_id: seasonId, episode_id: episodeId, version: 4, path: f.path }],
    ['replace_episode_video', { series_id: seriesId, season_id: seasonId, episode_id: episodeId, version: 4, path: f.path }],
  ] as const) {
    const c = fakeClient([]);
    const registered = await registeredTools(c.client, f);
    await assert.rejects(registered.call(name, input));
    await assert.rejects(registered.call(name, { ...input, confirmed: false }));
    assert.equal(c.calls.length, 0);
  }
});
```

把现有所有成功上传调用补上 `confirmed: true`，避免旧测试绕过新契约。

- [ ] **步骤 2：运行聚焦测试验证 RED**

```bash
cd mcp
node --import tsx --test --test-concurrency=1 \
  --test-name-pattern='genre|stage poster|every ordinary and replacement upload requires' \
  tests/content-tools.test.ts tests/upload-publish-tools.test.ts
```

预期：FAIL。当前创建题材、暂存海报和普通上传可在没有确认时继续。

- [ ] **步骤 3：实现统一确认 schema 和剥离规则**

在 `mcp/src/schemas/content.ts`：

```ts
export const createGenreInput = z.strictObject({ name, confirmed });
export const stagePosterInput = z.strictObject({ path: localPath, confirmed });
```

在 `genres.ts` 和 `movies.ts` 解析后只使用业务字段：

```ts
const { name, confirmed: _confirmed } = createGenreInput.parse(input);
const { path, confirmed: _confirmed } = stagePosterInput.parse(input);
```

在 `uploads.ts` 让四个上传 schema 共用确认字面量：

```ts
export const uploadMovieVideoInput = z.strictObject({ movie_id: id, version, path: localPath, confirmed });
export const replaceMovieVideoInput = uploadMovieVideoInput;
export const uploadEpisodeVideoInput = z.strictObject({
  series_id: id, season_id: id, episode_id: id, version, path: localPath, confirmed,
});
export const replaceEpisodeVideoInput = uploadEpisodeVideoInput;
```

解析成功即代表确认值为 `true`；不要把 `confirmed` 放入查询参数、JSON body 或 multipart。更新工具说明，使普通上传和替换都明确要求入库确认，而发布仍然独立。

- [ ] **步骤 4：运行测试验证 GREEN 并提交**

海报测试会临时监听本机回环端口，使用项目已验证的串行命令：

```bash
cd mcp
node --import tsx --test --test-concurrency=1 tests/content-tools.test.ts tests/upload-publish-tools.test.ts
npm run build
cd ..
git diff --check
git add mcp/src/schemas/content.ts mcp/src/tools/genres.ts mcp/src/tools/movies.ts mcp/src/tools/uploads.ts mcp/tests/content-tools.test.ts mcp/tests/upload-publish-tools.test.ts
git commit -m "feat(MCP): 强制确认全部入库写操作"
```

预期：两个测试文件全部通过；未确认路径的 client 调用数为零。

## 任务 4：更新联网补全工作流、指南并完成全量验证

**文件：**

- 修改：`mcp/src/server.ts`
- 修改：`mcp/tests/server.test.ts`
- 修改：`docs/guides/codex-mcp.md`
- 测试：`tests/documentation.test.mjs`

- [ ] **步骤 1：编写 MCP 工作流说明失败测试**

在 `mcp/tests/server.test.ts` 替换旧的“固定私密草稿”断言：

```ts
for (const phrase of [
  '联网', '来源', '年份', '简介', '题材', '单集名称', '海报',
  '默认公开', '完整入库计划', '确认失效', '转换', '上传', '发布', '禁止自动发布',
]) assert.match(instructions, new RegExp(phrase));
assert.doesNotMatch(instructions, /固定.*私密草稿/);
```

从 `client.listTools()` 取得 `create_movie`、`create_series`、`create_episode` 和 `upload_movie_video` 的 JSON schema，断言：

- 电影包含 `synopsis`、`duration_minutes`、`visibility`、`confirmed`，不包含 `duration_seconds`。
- 剧集包含 `synopsis`、`visibility`、`confirmed`。
- 单集包含 `name`、`duration_seconds`、`confirmed`。
- 普通上传包含 `confirmed`。

- [ ] **步骤 2：运行 server 测试验证 RED**

```bash
cd mcp
node --import tsx --test --test-concurrency=1 tests/server.test.ts
```

预期：FAIL。当前 instructions 仍声明固定私密且没有联网和来源规则。

- [ ] **步骤 3：实现 server instructions 和文档**

在 `mcp/src/server.ts` 使用以下约束：

```ts
const instructions = [
  '这是 Movie Harbor 本机原子入库服务。海报必须由用户提供并验证；不得联网下载海报。',
  '用户未提供名称、年份、简介、题材或单集名称时，Codex 必须联网查询可靠来源；冲突时让用户选择，不得虚构。',
  '创建和上传前必须展示完整入库计划、联网字段来源、文件路径、电影整数分钟、访问范围、转换与替换动作。',
  '访问范围未指定时默认公开；公开草稿在发布前仍不可访问。',
  '只有用户明确确认完整入库计划后，才可向入库写工具传 confirmed=true。计划、文件、版本或转换结果变化会使确认失效。',
  '转换确认、入库确认、发布确认相互独立。上传完成后禁止自动发布。',
  '目标已有视频时必须明确展示替换；电视剧先发布单集，父剧集需要再次单独确认发布。',
].join('\n');
```

更新 `docs/guides/codex-mcp.md`：

- 新建电影和剧集默认公开，可明确选择私密。
- 电影显示并提交整数分钟；通用探测和单集保留秒数。
- 创建必须包含简介。
- 用户缺少文字元数据或单集名称时联网查询并展示来源，冲突时停止询问。
- 海报仍由用户指定本地路径。
- 完整入库确认覆盖计划中列明的题材、海报暂存、内容层级和上传，但不覆盖转换或发布。
- 更新 MCP 后重新执行 `./mcp/install.sh`，再在 Codex 桌面版重启 `movie-harbor`。

- [ ] **步骤 4：运行全量验证**

```bash
cd mcp
node --import tsx --test --test-concurrency=1 tests/*.test.ts
npm run build
cd ..
node --test tests/documentation.test.mjs
git diff --check
git status --short
```

预期：MCP 全量测试、TypeScript 构建、文档测试和 diff 检查全部通过；状态只包含本任务预期文件。

- [ ] **步骤 5：提交工作流和指南**

```bash
git add mcp/src/server.ts mcp/tests/server.test.ts docs/guides/codex-mcp.md
git commit -m "docs(MCP): 约束联网补全与入库确认流程"
git status --short
```

预期：提交成功且工作区干净。实现完成后按 `superpowers:requesting-code-review` 和 `superpowers:verification-before-completion` 复核，再进入分支收尾流程。
