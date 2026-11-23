import assert from 'node:assert/strict';
import { test } from 'node:test';

const movieId = '11111111-1111-4111-8111-111111111111';
const seriesId = '22222222-2222-4222-8222-222222222222';
const mediaId = '55555555-5555-4555-8555-555555555555';

// 构造完整电影响应，供统一简介工具验证身份、版本和生命周期状态。
function movie(status: 'draft' | 'published' | 'archived', version: number, synopsis = '原电影简介') {
  return {
    id: movieId, name: 'Alien', year: 1979, duration_seconds: 7020,
    synopsis, status, version, is_private: false, poster: null, video: { id: mediaId },
  };
}

// 构造完整剧集响应，确保电影与剧集共用同一个工具而非拆分实现。
function series(status: 'draft' | 'published' | 'archived', version: number, synopsis = '原剧集简介') {
  return {
    id: seriesId, name: 'The Expanse', year: 2015,
    synopsis, status, version, is_private: false, poster: null, seasons: [],
  };
}

// 记录真实工具边界上的 HTTP 方法、路径和请求体，并按顺序返回服务端响应。
function fixture(responses: unknown[]) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  return {
    calls,
    client: {
      // 每次领域请求消费一个预设响应，多余调用会直接令测试失败。
      async json(method: string, path: string, body?: unknown) {
        calls.push({ method, path, body });
        assert.ok(responses.length, 'unexpected extra API call');
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
      },
    },
  };
}

// 注册真实处理器并调用统一工具，验证对 MCP 消费者可见的 schema 与结果。
async function synopsisTool(client: any) {
  const registrations = new Map<string, any>();
  const server = {
    // 收集实际注册信息，避免只验证内部辅助函数。
    registerTool(name: string, schema: any, handler: any) {
      registrations.set(name, { schema, handler });
    },
  };
  const module = await import('../src/tools/synopsis.js');
  module.registerSynopsisTools(server as any, client);
  assert.deepEqual([...registrations.keys()], ['update_content_synopsis']);
  const tool = registrations.get('update_content_synopsis');
  return {
    schema: tool.schema,
    // 通过注册后的真实处理器调用，确保入口没有绕开输入和输出 schema。
    async call(input: unknown) {
      const result = await tool.handler(input);
      assert.equal(tool.schema.outputSchema.safeParse(result.structuredContent).success, true);
      return result.structuredContent;
    },
  };
}

// 若生产代码漏掉 content_type 分支或把统一工具拆成两个名称，此测试应失败。
test('one synopsis tool supports draft movies and archived series', async () => {
  const draftMovie = fixture([movie('draft', 3), movie('draft', 4, '新的电影简介')]);
  const movieTool = await synopsisTool(draftMovie.client);
  assert.equal(movieTool.schema.annotations.readOnlyHint, false);
  assert.equal(movieTool.schema.annotations.destructiveHint, true);
  assert.deepEqual(await movieTool.call({
    content_type: 'movie', content_id: movieId, version: 3, synopsis: '新的电影简介',
  }), { id: movieId, version: 4, status: 'draft', next_actions: ['transition_content_lifecycle'] });
  assert.deepEqual(draftMovie.calls, [
    { method: 'GET', path: `/api/admin/movies/${movieId}`, body: undefined },
    { method: 'PATCH', path: `/api/admin/movies/${movieId}`, body: { version: 3, synopsis: '新的电影简介' } },
  ]);

  const archivedSeries = fixture([series('archived', 7), series('draft', 8), series('draft', 9, '新的剧集简介')]);
  const seriesTool = await synopsisTool(archivedSeries.client);
  assert.deepEqual(await seriesTool.call({
    content_type: 'series', content_id: seriesId, version: 7, synopsis: '新的剧集简介',
  }), { id: seriesId, version: 9, status: 'draft', next_actions: ['get_series_structure'] });
  assert.deepEqual(archivedSeries.calls, [
    { method: 'GET', path: `/api/admin/series/${seriesId}`, body: undefined },
    { method: 'POST', path: `/api/admin/series/${seriesId}/draft`, body: { version: 7 } },
    { method: 'PATCH', path: `/api/admin/series/${seriesId}`, body: { version: 8, synopsis: '新的剧集简介' } },
  ]);
});

// 若已发布内容没有严格经过归档、转草稿、修改三步，调用顺序或版本断言会失败。
test('published content is archived, reverted to draft, then updated and left as draft', async () => {
  const f = fixture([
    movie('published', 4), movie('archived', 5), movie('draft', 6), movie('draft', 7, ''),
  ]);
  const tool = await synopsisTool(f.client);
  assert.deepEqual(await tool.call({
    content_type: 'movie', content_id: movieId, version: 4, synopsis: '',
  }), { id: movieId, version: 7, status: 'draft', next_actions: ['transition_content_lifecycle'] });
  assert.deepEqual(f.calls, [
    { method: 'GET', path: `/api/admin/movies/${movieId}`, body: undefined },
    { method: 'POST', path: `/api/admin/movies/${movieId}/archive`, body: { version: 4 } },
    { method: 'POST', path: `/api/admin/movies/${movieId}/draft`, body: { version: 5 } },
    { method: 'PATCH', path: `/api/admin/movies/${movieId}`, body: { version: 6, synopsis: '' } },
  ]);
});

// 若工具忽略调用者确认的版本并使用最新版本写入，此测试会观察到不应发生的写请求。
test('version conflict stops before lifecycle or synopsis writes', async () => {
  const { MovieHarborClientError } = await import('../src/services/error-mapper.js');
  const f = fixture([series('published', 6)]);
  const tool = await synopsisTool(f.client);
  await assert.rejects(tool.call({
    content_type: 'series', content_id: seriesId, version: 5, synopsis: '不会写入',
  }), error => error instanceof MovieHarborClientError && error.code === 'version_conflict');
  assert.deepEqual(f.calls, [
    { method: 'GET', path: `/api/admin/series/${seriesId}`, body: undefined },
  ]);
});

// 若归档已提交但响应丢失后不读回状态，工具会错误停止并留下已归档内容。
test('lost archive response is reconciled before continuing to draft and synopsis update', async () => {
  const { MovieHarborClientError } = await import('../src/services/error-mapper.js');
  const f = fixture([
    movie('published', 4),
    new MovieHarborClientError('network_error'),
    movie('archived', 5),
    movie('draft', 6),
    movie('draft', 7, '恢复后的简介'),
  ]);
  const tool = await synopsisTool(f.client);
  assert.deepEqual(await tool.call({
    content_type: 'movie', content_id: movieId, version: 4, synopsis: '恢复后的简介',
  }), { id: movieId, version: 7, status: 'draft', next_actions: ['transition_content_lifecycle'] });
  assert.deepEqual(f.calls, [
    { method: 'GET', path: `/api/admin/movies/${movieId}`, body: undefined },
    { method: 'POST', path: `/api/admin/movies/${movieId}/archive`, body: { version: 4 } },
    { method: 'GET', path: `/api/admin/movies/${movieId}`, body: undefined },
    { method: 'POST', path: `/api/admin/movies/${movieId}/draft`, body: { version: 5 } },
    { method: 'PATCH', path: `/api/admin/movies/${movieId}`, body: { version: 6, synopsis: '恢复后的简介' } },
  ]);
});

// 若中间步骤失败后只抛原始网络错误，调用者将不知道内容已经下线及应使用的新版本。
test('partial lifecycle failure reports the latest status and version and stops', async () => {
  const { MovieHarborClientError } = await import('../src/services/error-mapper.js');
  const f = fixture([
    series('published', 7),
    series('archived', 8),
    new MovieHarborClientError('timeout'),
    series('archived', 8),
  ]);
  const tool = await synopsisTool(f.client);
  await assert.rejects(tool.call({
    content_type: 'series', content_id: seriesId, version: 7, synopsis: '未写入',
  }), error => error instanceof Error && /archived/.test(error.message) && /8/.test(error.message));
  assert.deepEqual(f.calls, [
    { method: 'GET', path: `/api/admin/series/${seriesId}`, body: undefined },
    { method: 'POST', path: `/api/admin/series/${seriesId}/archive`, body: { version: 7 } },
    { method: 'POST', path: `/api/admin/series/${seriesId}/draft`, body: { version: 8 } },
    { method: 'GET', path: `/api/admin/series/${seriesId}`, body: undefined },
  ]);
});

// 若明确的 409 被当作响应丢失读回恢复，可能把其他调用者的同版本写入误认成本次成功。
test('version conflicts from every write step stop without reconciliation reads', async () => {
  const { MovieHarborClientError } = await import('../src/services/error-mapper.js');
  const cases = [
    {
      current: movie('published', 4),
      input: { content_type: 'movie', content_id: movieId, version: 4, synopsis: '新简介' },
      write: { method: 'POST', path: `/api/admin/movies/${movieId}/archive`, body: { version: 4 } },
    },
    {
      current: series('archived', 7),
      input: { content_type: 'series', content_id: seriesId, version: 7, synopsis: '新简介' },
      write: { method: 'POST', path: `/api/admin/series/${seriesId}/draft`, body: { version: 7 } },
    },
    {
      current: movie('draft', 3),
      input: { content_type: 'movie', content_id: movieId, version: 3, synopsis: '新简介' },
      write: { method: 'PATCH', path: `/api/admin/movies/${movieId}`, body: { version: 3, synopsis: '新简介' } },
    },
  ] as const;
  for (const scenario of cases) {
    const f = fixture([scenario.current, new MovieHarborClientError('version_conflict', 409)]);
    const tool = await synopsisTool(f.client);
    await assert.rejects(tool.call(scenario.input), error =>
      error instanceof MovieHarborClientError && error.code === 'version_conflict');
    const base = scenario.input.content_type === 'movie'
      ? `/api/admin/movies/${scenario.input.content_id}`
      : `/api/admin/series/${scenario.input.content_id}`;
    assert.deepEqual(f.calls, [
      { method: 'GET', path: base, body: undefined },
      scenario.write,
    ]);
  }
});

// 若 MCP 未按后端规则去除首尾空白，成功保存后会因响应简介不同而误报失败。
test('synopsis is trimmed before sending and whitespace-only input clears it', async () => {
  for (const [input, stored] of [[' 新简介 ', '新简介'], ['   ', '']] as const) {
    const f = fixture([series('draft', 2), series('draft', 3, stored)]);
    const tool = await synopsisTool(f.client);
    assert.deepEqual(await tool.call({
      content_type: 'series', content_id: seriesId, version: 2, synopsis: input,
    }), { id: seriesId, version: 3, status: 'draft', next_actions: ['get_series_structure'] });
    assert.deepEqual(f.calls[1], {
      method: 'PATCH', path: `/api/admin/series/${seriesId}`, body: { version: 2, synopsis: stored },
    });
  }
});
