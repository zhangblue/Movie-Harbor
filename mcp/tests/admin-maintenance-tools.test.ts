import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer } from '../src/server.js';
import { mapHttpError } from '../src/services/error-mapper.js';
import type { CheckedFile } from '../src/services/path-policy.js';
import { UploadFileChangedAfterSendError } from '../src/services/upload-stream.js';
import { setContentVisibility, transitionContentLifecycle } from '../src/tools/content-maintenance.js';
import { MovieHarborClientError, type HttpMethod, type MovieHarborClient } from '../src/services/movie-harbor-client.js';

const movieId = '11111111-1111-4111-8111-111111111111';
const seriesId = '22222222-2222-4222-8222-222222222222';
const seasonId = '33333333-3333-4333-8333-333333333333';
const episodeId = '44444444-4444-4444-8444-444444444444';
const otherId = '55555555-5555-4555-8555-555555555555';
const moviePath = '/api/admin/movies/' + movieId;
const seriesPath = '/api/admin/series/' + seriesId;
const episodePath = seriesPath + '/seasons/' + seasonId + '/episodes/' + episodeId;

// 准备真实管理接口的响应形状，包含工具不得对外转发的媒体路径。
const media = { id: otherId, local_path: '/private/media/video.mp4' };
const movies = {
  draft: { id: movieId, name: '电影', year: 2000, status: 'draft', version: 3,
    is_private: false, duration_seconds: 120, poster: null, video: media },
  published: { id: movieId, name: '电影', year: 2000, status: 'published', version: 4,
    is_private: false, duration_seconds: 120, poster: null, video: media },
};
const episode = { id: episodeId, season_id: seasonId, number: 1, name: '单集', status: 'draft',
  version: 4, duration_seconds: 120, video: media };
const series = { id: seriesId, name: '剧集', year: 2000, status: 'draft', version: 8,
  is_private: true, poster: null, seasons: [{ id: seasonId, number: 1, episodes: [episode] }] };
const episodeEnvelope = { series_version: 8, episode };
const movieInput = { content_type: 'movie', content_id: movieId, version: 3, confirmed: true };
const seriesInput = { content_type: 'series', content_id: seriesId, version: 8, confirmed: true };
const episodeInput = { content_type: 'episode', content_id: episodeId, series_id: seriesId,
  season_id: seasonId, version: 4, confirmed: true };

// 记录工具对外部管理 API 的方法、路径和正文，并按场景返回预设 API 响应。
function mockApi(...responses: unknown[]) {
  const calls: unknown[][] = [];
  const client: MovieHarborClient = {
    // 模拟管理接口依次完成读取和写入，也能注入确定性的网络或并发错误。
    async json<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
      calls.push(body === undefined ? [method, path] : [method, path, body]);
      assert.ok(responses.length, '发生了额外管理 API 请求');
      const result = responses.shift();
      if (result instanceof Error) throw result;
      return result as T;
    },
    // 此工具组只使用 JSON；走到文件上传即说明路径选错。
    async upload(): Promise<never> { throw new Error('发生了非预期的上传'); },
  };
  return { client, calls };
}

// 验证公开和私密方向均映射至对应资源的 PUT 隐私路径，不转发工具字段。
test('visibility maps movie and series changes to the correct privacy PUT with a checked result', async () => {
  const movie = mockApi(movies.draft, { ...movies.draft, is_private: true, version: 4 });
  const movieResult = await setContentVisibility({ ...movieInput, visibility: 'private' }, movie.client);
  assert.deepEqual(movieResult.structuredContent, {
    content_type: 'movie', content_id: movieId, visibility: 'private', version: 4, next_actions: ['search_movies'],
  });
  assert.deepEqual(movie.calls, [
    ['GET', moviePath],
    ['PUT', moviePath + '/privacy', { version: 3, is_private: true }],
  ]);
  const archivedSeries = { ...series, status: 'archived' };
  const show = mockApi(archivedSeries, { ...archivedSeries, is_private: false, version: 9 });
  const seriesResult = await setContentVisibility({ ...seriesInput, visibility: 'public' }, show.client);
  assert.deepEqual(seriesResult.structuredContent, {
    content_type: 'series', content_id: seriesId, visibility: 'public', version: 9, next_actions: ['get_series_structure'],
  });
  assert.deepEqual(show.calls, [
    ['GET', seriesPath],
    ['PUT', seriesPath + '/privacy', { version: 8, is_private: false }],
  ]);
  assert.doesNotMatch(JSON.stringify([movieResult, seriesResult]), /local_path|\/private\/media/);
});

// 验证大写 UUID 与后端回传的标准小写 UUID 代表同一个内容。
test('visibility and lifecycle accept uppercase UUIDs and return the canonical ID', async () => {
  const id = 'abcdef11-1111-4111-8111-111111111111';
  const path = '/api/admin/movies/' + id;
  const upperInput = { ...movieInput, content_id: id.toUpperCase() };
  const current = { ...movies.draft, id };
  const privacy = mockApi(current);
  const visibility = await setContentVisibility({ ...upperInput, visibility: 'public' }, privacy.client);
  assert.equal(visibility.structuredContent?.content_id, id);
  assert.deepEqual(privacy.calls, [['GET', path]]);
  const lifecycle = mockApi(current, { ...movies.published, id });
  const changed = await transitionContentLifecycle({ ...upperInput, target_status: 'published' }, lifecycle.client);
  assert.equal(changed.structuredContent?.content_id, id);
  assert.deepEqual(lifecycle.calls, [['GET', path], ['POST', path + '/publish', { version: 3 }]]);
});

// 验证同范围保持原版本，陈旧版本即使范围相同也须等待调用者重新读取。
test('visibility skips a redundant write and rejects stale versions before writing', async () => {
  const unchanged = mockApi(movies.draft);
  const result = await setContentVisibility({ ...movieInput, visibility: 'public' }, unchanged.client);
  assert.equal(result.structuredContent?.version, 3);
  assert.deepEqual(unchanged.calls, [['GET', moviePath]]);
  const stale = mockApi(movies.published);
  await assert.rejects(setContentVisibility({ ...movieInput, visibility: 'public' }, stale.client),
    { code: 'version_conflict' });
  assert.deepEqual(stale.calls, [['GET', moviePath]]);
});

// 验证写入前拒绝详情 ID 错配，写入后拒绝目标 ID、范围与版本错配。
test('visibility rejects a mismatched ID, scope, or updated version without retrying', async () => {
  const input = { ...movieInput, visibility: 'private' };
  const wrongDetail = mockApi({ ...movies.draft, id: otherId });
  await assert.rejects(setContentVisibility(input, wrongDetail.client), { code: 'invalid_response' });
  assert.deepEqual(wrongDetail.calls, [['GET', moviePath]]);
  const updated = { ...movies.draft, is_private: true, version: 4 };
  for (const malformed of [{ ...updated, id: otherId }, { ...updated, is_private: false },
    { ...updated, version: 3 }, { ...updated, version: 5 }]) {
    const remote = mockApi(movies.draft, malformed);
    await assert.rejects(setContentVisibility(input, remote.client), { code: 'invalid_response' });
    assert.deepEqual(remote.calls, [['GET', moviePath], ['PUT', moviePath + '/privacy', { version: 3, is_private: true }]]);
  }
});

// 验证版本冲突从后端传回，工具不会在读取与写入之间发生并发时覆盖新版本。
test('visibility propagates a concurrent version conflict without a retry', async () => {
  const remote = mockApi(movies.draft, new MovieHarborClientError('version_conflict', 409));
  await assert.rejects(setContentVisibility({ ...movieInput, visibility: 'private' }, remote.client),
    { code: 'version_conflict', status: 409 });
  assert.deepEqual(remote.calls, [['GET', moviePath], ['PUT', moviePath + '/privacy', { version: 3, is_private: true }]]);
});

// 验证单集发布和父剧发布独立，电影、整剧及单集使用各自的详情与写入路径。
test('lifecycle publishes movie, episode and parent series through separate confirmed calls', async () => {
  const publishedEpisode = { ...episode, status: 'published', version: 5 };
  const remote = mockApi(movies.draft, movies.published, series, episodeEnvelope,
    { series_version: 9, episode: publishedEpisode }, { ...series, version: 9 },
    { ...series, status: 'published', version: 10 });
  const movie = await transitionContentLifecycle({ ...movieInput, target_status: 'published' }, remote.client);
  assert.deepEqual(movie.structuredContent, {
    content_type: 'movie', content_id: movieId, previous_status: 'draft', transitioned_through: ['published'],
    status: 'published', version: 4, next_actions: [],
  });
  const child = await transitionContentLifecycle({ ...episodeInput, target_status: 'published' }, remote.client);
  assert.deepEqual(child.structuredContent, {
    content_type: 'episode', content_id: episodeId, previous_status: 'draft', transitioned_through: ['published'],
    status: 'published', version: 5, series_version: 9, next_actions: ['transition_content_lifecycle'],
  });
  assert.match(JSON.stringify(child.content), /父剧集仍需单独确认发布/);
  const parent = await transitionContentLifecycle({ ...seriesInput, version: 9, target_status: 'published' }, remote.client);
  assert.deepEqual(parent.structuredContent, {
    content_type: 'series', content_id: seriesId, previous_status: 'draft', transitioned_through: ['published'],
    status: 'published', version: 10, next_actions: [],
  });
  assert.deepEqual(remote.calls, [
    ['GET', moviePath], ['POST', moviePath + '/publish', { version: 3 }],
    ['GET', seriesPath], ['GET', episodePath], ['POST', episodePath + '/publish', { version: 4 }],
    ['GET', seriesPath], ['POST', seriesPath + '/publish', { version: 9 }],
  ]);
});

// 验证已达目标状态时不写入、不伪造状态路径，版本过期仍需重新读取。
test('lifecycle skips a same-state write after validating the current version', async () => {
  const remote = mockApi(movies.published);
  const result = await transitionContentLifecycle({ ...movieInput, version: 4, target_status: 'published' }, remote.client);
  assert.deepEqual(result.structuredContent, {
    content_type: 'movie', content_id: movieId, previous_status: 'published', transitioned_through: [],
    status: 'published', version: 4, next_actions: [],
  });
  assert.deepEqual(remote.calls, [['GET', moviePath]]);
  const stale = mockApi(movies.published);
  await assert.rejects(transitionContentLifecycle({ ...movieInput, target_status: 'published' }, stale.client),
    { code: 'version_conflict' });
  assert.deepEqual(stale.calls, [['GET', moviePath]]);
});

// 验证草稿不能直接归档，归档后可重新发布或恢复草稿。
test('lifecycle follows the status matrix before selecting any POST', async () => {
  const denied = mockApi(movies.draft);
  await assert.rejects(transitionContentLifecycle({ ...movieInput, target_status: 'archived' }, denied.client), /草稿.*归档/);
  assert.deepEqual(denied.calls, [['GET', moviePath]]);
  for (const [from, target, action] of [
    ['published', 'archived', 'archive'], ['archived', 'published', 'publish'], ['archived', 'draft', 'draft'],
  ] as const) {
    const remote = mockApi({ ...movies.draft, status: from }, { ...movies.draft, status: target, version: 4 });
    const result = await transitionContentLifecycle({ ...movieInput, target_status: target }, remote.client);
    assert.deepEqual(result.structuredContent?.transitioned_through, [target]);
    assert.deepEqual(remote.calls, [['GET', moviePath], ['POST', moviePath + '/' + action, { version: 3 }]]);
  }
});

// 验证单集可按自身状态重新发布，即使父剧处于归档状态，且不会自动发布父剧。
test('lifecycle lets the backend decide episode publication under an archived parent', async () => {
  const archived = { ...episode, status: 'archived' };
  const remote = mockApi({ ...series, status: 'archived' }, { ...episodeEnvelope, episode: archived },
    { series_version: 9, episode: { ...archived, status: 'published', version: 5 } });
  const result = await transitionContentLifecycle({ ...episodeInput, target_status: 'published' }, remote.client);
  assert.equal(result.structuredContent?.status, 'published');
  assert.deepEqual(result.structuredContent?.next_actions, []);
  assert.deepEqual(remote.calls, [
    ['GET', seriesPath], ['GET', episodePath], ['POST', episodePath + '/publish', { version: 4 }],
  ]);
});

// 验证两步转换使用实际归档响应中的新版本，并按顺序返回经过的状态。
test('lifecycle published to draft uses the archived response version', async () => {
  const remote = mockApi(movies.published, { ...movies.published, status: 'archived', version: 5 },
    { ...movies.published, status: 'draft', version: 6 });
  const result = await transitionContentLifecycle({ ...movieInput, version: 4, target_status: 'draft' }, remote.client);
  assert.deepEqual(result.structuredContent, {
    content_type: 'movie', content_id: movieId, previous_status: 'published', transitioned_through: ['archived', 'draft'],
    status: 'draft', version: 6, next_actions: [],
  });
  assert.deepEqual(remote.calls, [
    ['GET', moviePath], ['POST', moviePath + '/archive', { version: 4 }], ['POST', moviePath + '/draft', { version: 5 }],
  ]);
});

// 验证单集两步转换沿完整层级执行，并逐步验证单集及父剧版本增长。
test('lifecycle episode published to draft returns the final parent version', async () => {
  const published = { ...episode, status: 'published' };
  const remote = mockApi(series, { series_version: 8, episode: published },
    { series_version: 9, episode: { ...episode, status: 'archived', version: 5 } },
    { series_version: 10, episode: { ...episode, status: 'draft', version: 6 } });
  const result = await transitionContentLifecycle({ ...episodeInput, target_status: 'draft' }, remote.client);
  assert.deepEqual(result.structuredContent?.transitioned_through, ['archived', 'draft']);
  assert.equal(result.structuredContent?.series_version, 10);
  assert.deepEqual(remote.calls, [
    ['GET', seriesPath], ['GET', episodePath],
    ['POST', episodePath + '/archive', { version: 4 }], ['POST', episodePath + '/draft', { version: 5 }],
  ]);
});

// 验证第二步失败时保留已确认的归档事实，不发布补偿，也不透传远端错误。
test('partial transition reports archive success and requires a reread without compensation', async () => {
  const archived = { ...movies.published, status: 'archived', version: 5 };
  const remote = mockApi(movies.published, archived, new Error('raw /private/media/secret'));
  await assert.rejects(transitionContentLifecycle({ ...movieInput, version: 4, target_status: 'draft' }, remote.client),
    { code: 'partial_transition', message: '生命周期转换部分完成：已确认归档，转草稿结果未确认，请重新读取内容状态。' });
  assert.deepEqual(remote.calls, [
    ['GET', moviePath], ['POST', moviePath + '/archive', { version: 4 }], ['POST', moviePath + '/draft', { version: 5 }],
  ]);
});

// 验证单集详情及父级响应的任一层级标识或父版本不一致时停止写入。
test('lifecycle rejects an episode detail from a different hierarchy before POST', async () => {
  for (const detail of [
    { ...episodeEnvelope, series_id: otherId },
    { ...episodeEnvelope, episode: { ...episode, series_id: otherId } },
    { ...episodeEnvelope, episode: { ...episode, season_id: otherId } },
    { ...episodeEnvelope, episode: { ...episode, id: otherId } },
    { ...episodeEnvelope, series_version: 7 },
  ]) {
    const remote = mockApi(series, detail);
    await assert.rejects(transitionContentLifecycle({ ...episodeInput, target_status: 'published' }, remote.client),
      { code: 'invalid_response' });
    assert.deepEqual(remote.calls, [['GET', seriesPath], ['GET', episodePath]]);
  }
  const wrongParent = mockApi({ ...series, id: otherId });
  await assert.rejects(transitionContentLifecycle({ ...episodeInput, target_status: 'published' }, wrongParent.client),
    { code: 'invalid_response' });
  assert.deepEqual(wrongParent.calls, [['GET', seriesPath]]);
  const unrelatedParent = mockApi({ ...series, seasons: [] }, episodeEnvelope);
  await assert.rejects(transitionContentLifecycle({ ...episodeInput, target_status: 'published' }, unrelatedParent.client),
    { code: 'invalid_response' });
  assert.deepEqual(unrelatedParent.calls, [['GET', seriesPath], ['GET', episodePath]]);
});

// 验证生命周期写响应不接受错误状态、标识或未按一次递增的单集与父级版本。
test('lifecycle rejects impossible state, ownership or version changes in POST responses', async () => {
  for (const [input, current, path, published] of [
    [movieInput, movies.draft, moviePath, movies.published],
    [seriesInput, series, seriesPath, { ...series, status: 'published', version: 9 }],
  ] as const) {
    for (const response of [{ ...published, id: otherId }, { ...published, status: 'draft' },
      { ...published, version: input.version }, { ...published, version: input.version + 2 }]) {
      const remote = mockApi(current, response);
      await assert.rejects(transitionContentLifecycle({ ...input, target_status: 'published' }, remote.client),
        { code: 'invalid_response' });
      assert.deepEqual(remote.calls, [['GET', path], ['POST', path + '/publish', { version: input.version }]]);
    }
  }
  const publishedEpisode = { ...episode, status: 'published', version: 5 };
  for (const response of [
    { series_version: 9, episode: { ...publishedEpisode, version: 4 } },
    { series_version: 9, episode: { ...publishedEpisode, version: 6 } },
    { series_version: 8, episode: publishedEpisode },
    { series_version: 10, episode: publishedEpisode },
    { series_version: 9, episode: { ...publishedEpisode, id: otherId } },
    { series_version: 9, episode: { ...publishedEpisode, season_id: otherId } },
    { series_version: 9, series_id: otherId, episode: publishedEpisode },
  ]) {
    const remote = mockApi(series, episodeEnvelope, response);
    await assert.rejects(transitionContentLifecycle({ ...episodeInput, target_status: 'published' }, remote.client),
      { code: 'invalid_response' });
    assert.deepEqual(remote.calls, [
      ['GET', seriesPath], ['GET', episodePath], ['POST', episodePath + '/publish', { version: 4 }],
    ]);
  }
});

// 验证确认必须是字面量 true，范围必须显式提交且单集层级参数严格分流。
test('visibility and lifecycle reject unconfirmed or malformed input before an API request', async () => {
  const remote = mockApi();
  for (const confirmed of [false, 'true', undefined]) {
    await assert.rejects(setContentVisibility({ ...movieInput, visibility: 'private', confirmed }, remote.client));
    await assert.rejects(transitionContentLifecycle({ ...movieInput, target_status: 'published', confirmed }, remote.client));
  }
  for (const invalid of [movieInput, { ...episodeInput, visibility: 'private' },
    { ...movieInput, visibility: 'private', extra: true }]) {
    await assert.rejects(setContentVisibility(invalid, remote.client));
  }
  for (const invalid of [{ ...movieInput, series_id: seriesId }, { ...episodeInput, season_id: undefined },
    { ...episodeInput, target_status: 'removed' }]) {
    await assert.rejects(transitionContentLifecycle({ target_status: 'published', ...invalid }, remote.client));
  }
  assert.deepEqual(remote.calls, []);
});


// 准备可完整解码的 1×1 PNG、管理 API 上传响应和既有海报槽位。
const posterPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNg+A8AAQIBAEK+vGgAAAAASUVORK5CYII=', 'base64');
const posterId = '66666666-6666-4666-8666-666666666666';
const posterResponse = { id: posterId, mime_type: 'image/png', byte_size: 68, version: 4, original_name: 'poster.png' };
const oldPoster = { ...media, mime_type: 'image/jpeg', byte_size: 120, local_path: '/private/media/poster.jpg' };

// 测试调用前创建隔离目录和真实海报，并清理每个场景的临时文件。
async function posterFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mh-content-poster-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowedRoot = join(root, 'allowed');
  await mkdir(allowedRoot);
  const path = join(allowedRoot, 'poster.png');
  await writeFile(path, posterPng);
  return { root, allowedRoot, path, input: { ...movieInput, path } };
}

// 通过内存协议发送真实工具请求，仅替代外部管理 API，并记录工具发出的读取和文件上传。
async function callContentPoster(
  allowedRoot: string,
  input: Record<string, unknown>,
  detail?: unknown,
  upload?: unknown,
  readback?: unknown,
) {
  const config = {
    baseUrl: new URL('http://localhost/'), apiKey: 'mhmcp_secret', credentialDirectory: '/tmp/credentials',
    allowedRoots: [allowedRoot], generatedRoot: '/tmp/generated', requestTimeoutMs: 1000,
  };
  const calls: unknown[][] = [];
  const snapshots = [detail, readback];
  const clientApi: MovieHarborClient = {
    // 记录真实工具请求，依次返回上传前快照和回查快照，并检测额外的远程写入。
    async json<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
      calls.push([method, path]);
      assert.equal(body, undefined);
      const snapshot = snapshots.shift();
      if (snapshot instanceof Error) throw snapshot;
      return snapshot as T;
    },
    // 记录上传文件和 MIME，读取真实本地文件后才提供外部写入结果。
    async upload<T>(path: string, file: CheckedFile, mimeType: string): Promise<T> {
      calls.push(['upload', path, file.requestedPath, mimeType, (await readFile(file.realPath)).length]);
      if (upload instanceof Error) throw upload;
      return upload as T;
    },
  };
  const server = buildServer({ config, credentialDirectory: config.credentialDirectory, client: clientApi });
  const client = new Client({ name: 'movie-harbor-poster-test', version: '1.0.0' });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);
  await client.connect(clientEnd);
  try {
    return { result: await client.callTool({ name: 'set_content_poster', arguments: input }), calls };
  } finally {
    await client.close();
    await server.close();
  }
}

// 验证空电影槽位和已有整剧槽位分别补传和替换，上传使用对应版本且输出不泄露路径。
test('content poster adds to an empty movie slot and replaces an occupied series slot', async t => {
  const f = await posterFixture(t);
  for (const scenario of [
    { input: f.input, detail: movies.draft, detailPath: moviePath, typePath: 'movies', action: 'added' },
    { input: { ...seriesInput, path: f.path }, detail: { ...series, poster: oldPoster }, detailPath: seriesPath,
      typePath: 'series', action: 'replaced' },
  ] as const) {
    const newVersion = scenario.input.version + 1;
    const { result, calls } = await callContentPoster(f.allowedRoot, scenario.input, scenario.detail,
      { ...posterResponse, version: newVersion, local_path: '/private/media/new.png' });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.deepEqual(result.structuredContent, {
      content_type: scenario.input.content_type, content_id: scenario.input.content_id, version: newVersion,
      media_id: posterId, format: 'png', byte_size: 68, action: scenario.action, next_actions: ['transition_content_lifecycle'],
    });
    assert.deepEqual(calls, [
      ['GET', scenario.detailPath],
      ['upload', '/api/admin/media/' + scenario.typePath + '/' + scenario.input.content_id
        + '/poster?version=' + scenario.input.version, f.path, 'image/png', 68],
    ]);
    assert.doesNotMatch(JSON.stringify(result), /mh-content-poster-|\/private\/media|local_path/);
    assert.match(JSON.stringify(result.content), /发布.*单独确认/);
  }
});

// 验证严格 schema 拒绝单集、相对路径、空值、删除参数和非字面量确认。
test('content poster schema rejects invalid kinds, deletion, paths and confirmation', async t => {
  const f = await posterFixture(t);
  for (const patch of [
    { content_type: 'episode' }, { content_type: 'season' }, { content_id: 'invalid' }, { version: 0 },
    { path: 'poster.png' }, { path: '' }, { path: null }, { confirmed: false }, { confirmed: 'true' },
    { action: 'remove' }, { confirmed: undefined },
  ]) {
    const { result, calls } = await callContentPoster(f.allowedRoot, { ...f.input, ...patch });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /validation|invalid|必须使用|Unrecognized/i);
    assert.deepEqual(calls, []);
  }
});

// 验证路径策略与海报头尾预检先于远端读取，文件系统错误不会泄露路径。
test('content poster preflights the allowed local image before any API request', async t => {
  const f = await posterFixture(t);
  const outside = join(f.root, 'outside.png');
  const invalid = join(f.allowedRoot, 'invalid.png');
  await writeFile(outside, posterPng);
  await writeFile(invalid, 'wrong signature');
  for (const [path, message] of [
    [outside, /允许目录/], [invalid, /图片内容与扩展名/], [join(f.allowedRoot, 'missing.png'), /不可读取/],
  ] as const) {
    const { result, calls } = await callContentPoster(f.allowedRoot, { ...f.input, path });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), message);
    assert.doesNotMatch(JSON.stringify(result), /mh-content-poster-/);
    assert.deepEqual(calls, []);
  }
});

// 验证过期版本、非草稿和详情 ID 错配均不会触发上传或生命周期写入。
test('content poster checks detail identity, draft state and version before upload', async t => {
  const f = await posterFixture(t);
  for (const [detail, expected] of [
    [{ ...movies.draft, status: 'published' }, /transition_content_lifecycle/],
    [{ ...movies.draft, status: 'archived' }, /transition_content_lifecycle/],
    [{ ...movies.draft, version: 4 }, 'version_conflict'],
    [{ ...movies.draft, id: otherId }, 'invalid_response'],
    [{ ...movies.draft, poster: undefined }, 'invalid_response'],
  ] as const) {
    const { result, calls } = await callContentPoster(f.allowedRoot, f.input, detail);
    assert.equal(result.isError, true);
    if (typeof expected === 'string') assert.equal(result.structuredContent?.code, expected);
    else assert.match(JSON.stringify(result.content), expected);
    assert.deepEqual(calls, [['GET', moviePath]]);
  }
});

// 验证返回格式、大小、资产 ID 和版本必须对应本次替换，异常响应不会发起进一步写入。
test('content poster rejects mismatched upload responses as invalid_response', async t => {
  const f = await posterFixture(t);
  for (const patch of [
    { mime_type: 'image/webp' }, { byte_size: 67 }, { id: 'invalid' }, { id: oldPoster.id },
    { version: 3 }, { version: 5 },
  ]) {
    const { result, calls } = await callContentPoster(f.allowedRoot, f.input, { ...movies.draft, poster: oldPoster },
      { ...posterResponse, ...patch }, { ...movies.draft, poster: oldPoster });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, 'invalid_response');
    assert.equal(result.structuredContent?.commit_status, 'unknown');
    assert.deepEqual(calls, [
      ['GET', moviePath],
      ['upload', '/api/admin/media/movies/' + movieId + '/poster?version=3', f.path, 'image/png', 68],
      ['GET', moviePath],
    ]);
  }
});

// 验证后端报告事务提交后收尾失败时，按 UUID 回查补传与替换的实际槽位及版本。
test('content poster confirms a committed add or replacement after a finalization error', async t => {
  const f = await posterFixture(t);
  for (const scenario of [
    { input: f.input, detail: movies.draft, detailPath: moviePath, collection: 'movies', previousId: null },
    { input: { ...seriesInput, path: f.path }, detail: { ...series, poster: oldPoster }, detailPath: seriesPath,
      collection: 'series', previousId: oldPoster.id },
  ] as const) {
    const latest = { ...scenario.detail, version: scenario.input.version + 1, poster: {
      ...posterResponse, local_path: '/private/media/new.png',
    } };
    const { result, calls } = await callContentPoster(f.allowedRoot, scenario.input, scenario.detail, mapHttpError(500, {
      code: 'media_replace_finalization_failed', error: 'Bearer mhmcp_secret /private/media/raw',
    }, 'mhmcp_secret'), latest);
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      code: 'media_replace_finalization_failed', content_type: scenario.input.content_type,
      content_id: scenario.input.content_id, previous_poster_id: scenario.previousId, current_poster_id: posterId,
      previous_version: scenario.input.version, current_version: latest.version, commit_status: 'committed',
    });
    assert.match(JSON.stringify(result.content), /已提交.*收尾/);
    assert.doesNotMatch(JSON.stringify(result), /请.*重试|mhmcp_|Bearer|\/private\/media|mh-content-poster-/);
    assert.deepEqual(calls, [
      ['GET', scenario.detailPath],
      ['upload', '/api/admin/media/' + scenario.collection + '/' + scenario.input.content_id
        + '/poster?version=' + scenario.input.version, f.path, 'image/png', 68],
      ['GET', scenario.detailPath],
    ]);
  }
});

// 验证断线、超时和未识别的服务端错误均按原 UUID 回查；并发或读回失败时保留不确定状态。
test('content poster rereads ambiguous upload outcomes by UUID without uploading again', async t => {
  const f = await posterFixture(t);
  for (const scenario of [
    { detail: movies.draft, error: new MovieHarborClientError('network_error'),
      readback: { ...movies.draft, version: 4, poster: posterResponse },
      observedId: posterId, observedVersion: 4 },
    { detail: { ...movies.draft, poster: oldPoster }, error: new MovieHarborClientError('timeout'),
      readback: { ...movies.draft, poster: oldPoster },
      observedId: oldPoster.id, observedVersion: 3 },
    { detail: { ...movies.draft, poster: oldPoster }, error: new MovieHarborClientError('server_error'),
      readback: new Error('Bearer mhmcp_secret /private/media/raw'),
      observedId: null, observedVersion: null },
    { detail: movies.draft, error: new MovieHarborClientError('network_error'),
      readback: { ...movies.draft, id: otherId, version: 7, poster: posterResponse },
      observedId: null, observedVersion: null },
    { detail: { ...movies.draft, poster: oldPoster }, error: new UploadFileChangedAfterSendError(),
      readback: { ...movies.draft, version: 4, poster: posterResponse }, observedId: posterId, observedVersion: 4 },
  ] as const) {
    const { result, calls } = await callContentPoster(f.allowedRoot, f.input, scenario.detail,
      scenario.error, scenario.readback);
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      code: 'write_result_unknown', content_type: 'movie', content_id: movieId,
      previous_poster_id: scenario.detail.poster?.id ?? null, current_poster_id: scenario.observedId,
      previous_version: 3, current_version: scenario.observedVersion, commit_status: 'unknown',
    });
    assert.match(JSON.stringify(result.content), /无法确认.*提交/);
    assert.doesNotMatch(JSON.stringify(result), /请.*重试|mhmcp_|Bearer|\/private\/media|mh-content-poster-/);
    assert.deepEqual(calls, [
      ['GET', moviePath],
      ['upload', '/api/admin/media/movies/' + movieId + '/poster?version=3', f.path, 'image/png', 68],
      ['GET', moviePath],
    ]);
  }
});

// 验证收尾错误后的回查失败继续保留原机器码和不确定状态，谨慎呈现当前快照。
test('content poster preserves a finalization error when rereading its target fails', async t => {
  const f = await posterFixture(t);
  const { result, calls } = await callContentPoster(f.allowedRoot, f.input, movies.draft,
    new MovieHarborClientError('media_replace_finalization_failed', 500), new MovieHarborClientError('timeout'));
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    code: 'media_replace_finalization_failed', content_type: 'movie', content_id: movieId,
    previous_poster_id: null, current_poster_id: null, previous_version: 3,
    current_version: null, commit_status: 'unknown',
  });
  assert.match(JSON.stringify(result.content), /回查未取得.*无法确认.*提交/);
  assert.deepEqual(calls, [
    ['GET', moviePath],
    ['upload', '/api/admin/media/movies/' + movieId + '/poster?version=3', f.path, 'image/png', 68],
    ['GET', moviePath],
  ]);
});

// 验证明确发生在发送前的文件变化不启动远端核对。
test('content poster keeps pre-send file changes distinct from ambiguous uploads', async t => {
  const f = await posterFixture(t);
  const { result, calls } = await callContentPoster(f.allowedRoot, f.input, movies.draft,
    new MovieHarborClientError('file_changed'));
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { code: 'file_changed' });
  assert.deepEqual(calls, [
    ['GET', moviePath], ['upload', '/api/admin/media/movies/' + movieId + '/poster?version=3', f.path, 'image/png', 68],
  ]);
});
