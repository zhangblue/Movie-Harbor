import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer } from '../src/server.js';
import { healthyOverview, unavailableOverview } from './overview-fixture.js';
import { mapHttpError, MovieHarborClientError } from '../src/services/error-mapper.js';
import { inspectAllowedFile } from '../src/services/path-policy.js';
import { prepareGeneratedRoot, recordGeneratedFile } from '../src/services/generated-files.js';

const movieId = '11111111-1111-4111-8111-111111111111';
const seriesId = '22222222-2222-4222-8222-222222222222';
const seasonId = '33333333-3333-4333-8333-333333333333';
const episodeId = '44444444-4444-4444-8444-444444444444';
const mediaId = '55555555-5555-4555-8555-555555555555';
const media = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', local_path: 'SECRET' };
const movie = { id: movieId, name: 'Alien', year: 1979, duration_seconds: 7000, status: 'draft', version: 3,
  is_private: true, poster: media, video: null, genres: [], synopsis: '', created_at: '', updated_at: '' };
const episode = { id: episodeId, season_id: seasonId, number: 1, name: 'Pilot', duration_seconds: 500,
  status: 'draft', version: 4, video: null };
const series = { id: seriesId, name: 'Alien', year: 1979, status: 'draft', version: 8, is_private: true,
  poster: media, seasons: [{ id: seasonId, number: 1, episodes: [episode] }] };
const episodeEnvelope = { series_version: 8, episode };
const uploadResponse = { id: mediaId, original_name: 'video.mp4', mime_type: 'video/mp4', byte_size: 6, version: 4 };

// 为当前测试准备隔离的文件、配置或服务并安排清理。
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mh-upload-tools-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const allowed = join(directory, 'allowed');
  const credentials = join(directory, 'credentials');
  await Promise.all([mkdir(allowed), mkdir(credentials)]);
  const path = join(allowed, 'video.mp4');
  await writeFile(path, 'video!');
  const config = { baseUrl: new URL('http://localhost/'), apiKey: 'mhmcp_secret', credentialDirectory:credentials, allowedRoots: [allowed],
    generatedRoot: join(credentials, 'generated'), requestTimeoutMs: 1000 };
  // 上传测试中提供固定兼容轨道，避免依赖外部探测进程。
  const probeMedia = async () => ({ durationSeconds: 1, video: { index: 0, codec: 'h264', pixelFormat: 'yuv420p' }, audio: [], subtitles: [] }) as any;
  return { directory, allowed, credentials, credentialDirectory:credentials, path, config, probeMedia };
}

// 为上传及替换测试准备可控 API 响应。
function fakeClient(responses: unknown[], overview: unknown = healthyOverview) {
  const calls: any[] = [];
  return { calls, client: {
    // 测试请求时记录参数并返回预设的 API 响应。
    async json(method: string, path: string, body?: unknown) {
      calls.push({ kind: 'json', method, path, body });
      if (path === '/api/admin/system/overview') {
        if (overview instanceof Error) throw overview;
        return overview;
      }
      assert.ok(responses.length, `unexpected JSON call ${method} ${path}`);
      const value = responses.shift(); if (value instanceof Error) throw value; return value;
    },
    // 上传测试时记录文件参数并返回预设响应。
    async upload(path: string, file: any, mimeType: string) {
      calls.push({ kind: 'upload', path, requestedPath: file.requestedPath, mimeType });
      assert.ok(responses.length, `unexpected upload ${path}`);
      const value = responses.shift(); if (value instanceof Error) throw value; return value;
    },
  } };
}

// 测试工具调用时收集注册信息并提供调用入口。
async function registeredTools(client: any, dependencies: any) {
  const uploads = await import('../src/tools/uploads.js');
  const registrations = new Map<string, any>();
  const server = { /* 测试注册时收集工具 schema 与处理器。 */ registerTool(name: string, schema: any, handler: any) { registrations.set(name, { schema, handler }); } };
  uploads.registerUploadTools(server as any, { ...dependencies, client });
  return { registrations, /* 测试调用时运行处理器并核对输出 schema 与敏感信息。 */ async call(name: string, input: unknown) {
    const tool = registrations.get(name); assert.ok(tool, name);
    const result = await tool.handler(input);
    if (result.isError) throw Object.assign(new Error(result.content[0].text), result.structuredContent);
    assert.equal(tool.schema.outputSchema.safeParse(result.structuredContent).success, true, `${name} output`);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|local_path|mhmcp_/);
    return result.structuredContent;
  } };
}

// 验证上传及替换工具分别注册，并具有严格的写操作标注。
test('upload and replace tools register independently with strict write annotations', async t => {
  const f = await fixture(t); const c = fakeClient([]); const tools = await registeredTools(c.client, f);
  assert.deepEqual([...tools.registrations.keys()], ['upload_movie_video','replace_movie_video','upload_episode_video','replace_episode_video']);
  for (const { schema } of tools.registrations.values()) {
    assert.ok(schema.inputSchema); assert.ok(schema.outputSchema);
    assert.deepEqual(schema.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  }
  await assert.rejects(tools.call('replace_movie_video', { movie_id:movieId,version:3,path:f.path,confirmed:false }));
  assert.equal(c.calls.length, 0);
});

// Bypassing the confirmation schema must fail before probing the remote target or uploading.
// 验证普通上传和替换上传均需要入库确认。
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

// 验证普通电影上传遇到已有视频槽时不上传也不发布。
test('ordinary movie upload refuses an occupied slot and never uploads or publishes', async t => {
  const f = await fixture(t); const c = fakeClient([{ ...movie, video: media }]);
  const tools = await registeredTools(c.client, f);
  await assert.rejects(tools.call('upload_movie_video', { movie_id:movieId,version:3,path:f.path,confirmed:true }), /已有视频.*replace_movie_video/);
  assert.deepEqual(c.calls.map(call => [call.kind,call.method,call.path]), [['json','GET','/api/admin/system/overview'], ['json','GET',`/api/admin/movies/${movieId}`]]);
});

// 验证电影上传检查兼容媒体、仅流式上传一次、过滤输出且不自动发布。
test('movie upload validates compatible media, streams once, filters output and does not publish', async t => {
  const f = await fixture(t); const c = fakeClient([movie, uploadResponse]); const tools = await registeredTools(c.client, f);
  const out = await tools.call('upload_movie_video', { movie_id:movieId,version:3,path:f.path,confirmed:true });
  assert.deepEqual(out, { id:movieId,version:4,media_id:mediaId,mime_type:'video/mp4',byte_size:6,
    generated_file_deleted:false,retained_generated_path:null,next_actions:['transition_content_lifecycle'] });
  assert.deepEqual(c.calls.map(call => [call.kind,call.method,call.path,call.mimeType]), [
    ['json','GET','/api/admin/system/overview',undefined],
    ['json','GET',`/api/admin/movies/${movieId}`,undefined],
    ['upload',undefined,`/api/admin/media/movies/${movieId}/video?version=3`,'video/mp4'],
  ]);
  assert.equal(c.calls.some(call => String(call.path).includes('publish')), false);
});

// Catches consulting or uploading to the remote service before incompatible local MP4 tracks are rejected.
// 验证不兼容 MP4 轨道在任何 HTTP 请求前被拒绝，并提示使用视频转换工具。
test('movie upload rejects incompatible MP4 tracks before every HTTP call and points to convert_video', async t => {
  const f = await fixture(t);
  const video = { index: 0, codec: 'h264', pixelFormat: 'yuv420p' };
  const cases = [
    ['HEVC video', { ...video, codec: 'hevc' }, [], []],
    ['non-yuv420p H264 video', { ...video, pixelFormat: 'yuv444p' }, [], []],
    ['non-AAC audio', video, [{ index: 2, codec: 'dts' }], []],
    ['image subtitle', video, [], [{ index: 7, codec: 'hdmv_pgs_subtitle' }]],
  ] as const;

  for (const [name, selectedVideo, audio, subtitles] of cases) {
    const c = fakeClient([]);
    const dependencies = { ...f, /* 按场景返回不兼容轨道，验证上传在 HTTP 请求前被拒绝。 */ probeMedia: async () => ({ durationSeconds: 1, video: selectedVideo, audio, subtitles }) };
    const tools = await registeredTools(c.client, dependencies);
    await assert.rejects(
      tools.call('upload_movie_video', { movie_id: movieId, version: 3, path: f.path,confirmed:true }),
      error => /convert_video/.test(String(error)),
      name,
    );
    assert.deepEqual(c.calls, [], name);
  }
});

// 验证替换需要已有视频和明确确认，普通上传拒绝不兼容文件。
test('replace requires an occupied target and explicit confirmation while upload rejects incompatible files', async t => {
  const f = await fixture(t); const webm = join(f.allowed,'video.webm'); const mkv = join(f.allowed,'video.mkv');
  await Promise.all([writeFile(webm,'webm'),writeFile(mkv,'mkv')]);
  const c = fakeClient([movie, { ...movie, video:media }, { ...uploadResponse, mime_type:'video/webm', byte_size:4 }]);
  const tools = await registeredTools(c.client, f);
  await assert.rejects(tools.call('replace_movie_video',{movie_id:movieId,version:3,path:f.path,confirmed:true}), /没有视频.*upload_movie_video/);
  const replaced = await tools.call('replace_movie_video',{movie_id:movieId,version:3,path:webm,confirmed:true});
  assert.equal(replaced.mime_type,'video/webm');
  assert.equal(c.calls.at(-1).mimeType,'video/webm');
  const blocked = fakeClient([movie]); const blockedTools = await registeredTools(blocked.client, f);
  await assert.rejects(blockedTools.call('upload_movie_video',{movie_id:movieId,version:3,path:mkv,confirmed:true}), /convert_video|转换/);
  assert.equal(blocked.calls.filter(call => call.kind === 'upload').length, 0);
});

// 验证单集上传检查层级归属，并返回单集及父剧集版本。
test('episode upload validates hierarchy and returns episode and parent versions', async t => {
  const f = await fixture(t); const response = { ...uploadResponse, version:5, series_version:9 };
  const c = fakeClient([episodeEnvelope,response]); const tools = await registeredTools(c.client, f);
  const input = {series_id:seriesId,season_id:seasonId,episode_id:episodeId,version:4,path:f.path,confirmed:true};
  assert.deepEqual(await tools.call('upload_episode_video',input), {id:episodeId,version:5,series_version:9,media_id:mediaId,
    mime_type:'video/mp4',byte_size:6,generated_file_deleted:false,retained_generated_path:null,next_actions:['transition_content_lifecycle']});
  assert.deepEqual(c.calls.map(call => call.path), [
    '/api/admin/system/overview',
    `/api/admin/series/${seriesId}/seasons/${seasonId}/episodes/${episodeId}`,
    `/api/admin/media/episodes/${episodeId}/video?version=4`,
  ]);
  const wrong = fakeClient([{series_version:8,episode:{...episode,id:movieId}}]);
  await assert.rejects((await registeredTools(wrong.client,f)).call('upload_episode_video',input), /数据格式无效/);
  assert.equal(wrong.calls.length,2);
});

// 验证电影上传响应语义不可能时，在清理生成文件前拒绝响应。
test('upload rejects semantically impossible movie responses before cleanup', async t => {
  const f = await fixture(t);
  for (const [index,response] of [
    { ...uploadResponse, mime_type:'video/webm' },
    { ...uploadResponse, byte_size:999 },
    { ...uploadResponse, version:5 },
  ].entries()) {
    const ordinary = fakeClient([movie,response]);
    await assert.rejects((await registeredTools(ordinary.client,f)).call('upload_movie_video',{movie_id:movieId,version:3,path:f.path,confirmed:true}),/数据格式无效/);
    assert.equal(await stat(f.path).then(()=>true),true);
    assert.equal(ordinary.calls.length,3);

    await prepareGeneratedRoot(f.config);
    const source = await inspectAllowedFile(f.path,f.config.allowedRoots);
    const generated = join(f.config.generatedRoot,`bad-${index}.mp4`);
    await writeFile(generated,'made');
    await recordGeneratedFile(generated,source,f.config,f.credentials);
    const generatedClient = fakeClient([movie,{...response,byte_size:response.byte_size===999?999:4}]);
    await assert.rejects((await registeredTools(generatedClient.client,f)).call('upload_movie_video',{movie_id:movieId,version:3,path:generated,confirmed:true}),/数据格式无效/);
    assert.equal(await stat(generated).then(()=>true),true,'invalid response must retain generated file');
    assert.equal(generatedClient.calls.length,3);
  }
});

// 验证单集或父剧集版本异常跳跃时，在清理生成文件前拒绝响应。
test('episode upload rejects target or parent version jumps before cleanup', async t => {
  const f = await fixture(t); const input={series_id:seriesId,season_id:seasonId,episode_id:episodeId,version:4,path:f.path,confirmed:true};
  for(const [index,response] of [
    {...uploadResponse,version:6,series_version:9},
    {...uploadResponse,version:5,series_version:10},
  ].entries()){
    const c=fakeClient([episodeEnvelope,response]);
    await assert.rejects((await registeredTools(c.client,f)).call('upload_episode_video',input),/数据格式无效/);
    assert.equal(c.calls.length,3);

    await prepareGeneratedRoot(f.config);
    const source=await inspectAllowedFile(f.path,f.config.allowedRoots);
    const generated=join(f.config.generatedRoot,`bad-episode-${index}.mp4`);
    await writeFile(generated,'made');
    await recordGeneratedFile(generated,source,f.config,f.credentials);
    const generatedClient=fakeClient([episodeEnvelope,{...response,byte_size:4}]);
    await assert.rejects((await registeredTools(generatedClient.client,f)).call('upload_episode_video',{...input,path:generated,confirmed:true}),/数据格式无效/);
    assert.equal(await stat(generated).then(()=>true),true,'invalid episode response must retain generated file');
    assert.equal(generatedClient.calls.length,3);
  }
});

// 验证生成视频上传成功后只删除已登记的转换输出，失败时保留文件。
test('successful generated upload deletes only registered conversion output and failures retain it', async t => {
  const f = await fixture(t); await prepareGeneratedRoot(f.config);
  const source = await inspectAllowedFile(f.path, f.config.allowedRoots);
  const generated = join(f.config.generatedRoot,'converted.mp4'); await writeFile(generated,'made');
  await recordGeneratedFile(generated,source,f.config,f.credentials);
  const success = fakeClient([movie,{...uploadResponse,byte_size:4}]);
  const successTools = await registeredTools(success.client,f);
  const out = await successTools.call('upload_movie_video',{movie_id:movieId,version:3,path:generated,confirmed:true});
  assert.equal(out.generated_file_deleted,true); assert.equal(out.retained_generated_path,null);
  await assert.rejects(stat(generated),{code:'ENOENT'});

  const generated2 = join(f.config.generatedRoot,'retry.mp4'); await writeFile(generated2,'retry');
  await recordGeneratedFile(generated2,source,f.config,f.credentials);
  const failure = fakeClient([movie,new Error('remote failed')]);
  await assert.rejects((await registeredTools(failure.client,f)).call('upload_movie_video',{movie_id:movieId,version:3,path:generated2,confirmed:true}), error => /保留|retry/.test(String(error)));
  assert.equal(await stat(generated2).then(() => true),true);
});

// 逐一调用四个注册入口，检查容量边界、中止阶段和错误输出中的可公开数字。
test('video capacity checks volume zero before the target and allows the exact reserve boundary', async t => {
  const f = await fixture(t);
  const volume = { ...healthyOverview.volumes[0], available_bytes: 46, reserve_bytes: 40, writable_bytes: 6 };
  const boundary = { ...healthyOverview, volumes: [volume] };
  const movieArgs = { movie_id: movieId, version: 3, confirmed: true, path: f.path };
  const episodeArgs = { series_id: seriesId, season_id: seasonId, episode_id: episodeId,
    version: 4, confirmed: true, path: f.path };
  const episodeResponse = { ...uploadResponse, version: 5, series_version: 9 };
  for (const [name, args, target, response] of [
    ['upload_movie_video', movieArgs, movie, uploadResponse],
    ['replace_movie_video', movieArgs, { ...movie, video: media }, uploadResponse],
    ['upload_episode_video', episodeArgs, episodeEnvelope, episodeResponse],
    ['replace_episode_video', episodeArgs, { ...episodeEnvelope, episode: { ...episode, video: media } }, episodeResponse],
  ] as const) {
    await t.test(name, async () => {
      const success = fakeClient([target, response], boundary);
      const registered = await registeredTools(success.client, f);
      const out = await registered.call(name, args);
      assert.equal(out.byte_size, 6);
      assert.deepEqual(success.calls.map(call => [call.kind, call.method]), [
        ['json', 'GET'], ['json', 'GET'], ['upload', undefined],
      ]);
      assert.equal(success.calls[0].path, '/api/admin/system/overview');
      for (const [snapshot, code, available, reserve, shortfall] of [
        [{ ...boundary, volumes: [{ ...volume, available_bytes: 45 }] }, 'storage_space_low', 45, 40, 1],
        [{ ...boundary, volumes: [{ ...volume, accepts_uploads: false }] }, 'storage_space_low', 46, 40, 0],
        [unavailableOverview, 'storage_capacity_unavailable', null, 10737418240, null],
        [new MovieHarborClientError('timeout'), 'storage_capacity_unavailable', null, null, null],
        [{ ...boundary, volumes: [], error: '/srv/media/private' }, 'storage_capacity_unavailable', null, null, null],
        [{ ...boundary, volumes: [{ ...volume, available_bytes: Number.MAX_SAFE_INTEGER,
          reserve_bytes: Number.MAX_SAFE_INTEGER }] }, 'storage_space_low', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 6],
      ] as const) {
        const rejected = fakeClient([], snapshot);
        const tools = await registeredTools(rejected.client, f);
        const result = await tools.registrations.get(name).handler(args);
        assert.equal(result.isError, true);
        assert.deepEqual(result.structuredContent, {
          code, file_bytes: 6, available_bytes: available, reserve_bytes: reserve, shortfall_bytes: shortfall,
        });
        assert.match(result.content[0].text, /容量|空间/);
        assert.doesNotMatch(JSON.stringify(result), /Bearer|Authorization|mhmcp_|mh-upload-tools-|\/srv\/media/);
        assert.deepEqual(rejected.calls.map(call => [call.method, call.path]), [['GET', '/api/admin/system/overview']]);
      }
    });
  }
});

// 服务端可能在快照之后拒绝容量或无法确认写入；两类文件都须保留，工具不得再次发起上传。
test('server capacity rejection or uncertain write retains source and generated files without resending', async t => {
  const f = await fixture(t);
  await prepareGeneratedRoot(f.config);
  const generated = join(f.config.generatedRoot, 'retry.mp4');
  await writeFile(generated, 'retry!');
  await recordGeneratedFile(generated, await inspectAllowedFile(f.path, f.config.allowedRoots), f.config, f.credentials);
  for (const [status, code] of [[507, 'storage_space_low'], [500, 'media_replace_outcome_unknown']] as const) {
    for (const path of [f.path, generated]) {
      const error = mapHttpError(status, { code, error: 'Bearer mhmcp_secret /srv/media/private' }, f.config.apiKey);
      const remote = fakeClient([movie, error]);
      const tools = await registeredTools(remote.client, f);
      const result = await tools.registrations.get('upload_movie_video').handler({
        movie_id: movieId, version: 3, confirmed: true, path,
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.code, code);
      if (code === 'media_replace_outcome_unknown') assert.match(result.content[0].text, /查询|读取/);
      if (path === generated) assert.match(result.content[0].text, /生成文件已保留/);
      assert.doesNotMatch(JSON.stringify(result), /Bearer|Authorization|mhmcp_|mh-upload-tools-|\/srv\/media/);
      assert.equal((await stat(path)).size, 6);
      assert.equal(remote.calls.filter(call => call.kind === 'upload').length, 1);
    }
  }
});

// 详情已核对后的网络错误和无效成功响应都须引导人工核对；已发送的文件不可自动重传。
test('uncertain video upload result requires rereading media and version', async t => {
  const f = await fixture(t);
  for (const [response, code] of [
    [new MovieHarborClientError('timeout'), 'write_result_unknown'],
    [{ ...uploadResponse, version: 99 }, 'invalid_response'],
  ] as const) {
    const remote = fakeClient([movie, response]);
    const tools = await registeredTools(remote.client, f);
    const result = await tools.registrations.get('upload_movie_video').handler({
      movie_id: movieId, version: 3, confirmed: true, path: f.path,
    });
    assert.equal(result.structuredContent.code, code);
    assert.match(result.content[0].text, /重新查询.*版本/);
    assert.equal(remote.calls.filter(call => call.kind === 'upload').length, 1);
  }
});

// 本地路径丢失时不得将文件系统原始错误交给工具调用方，也不应查询容量。
test('local video identity failure avoids disclosing paths or requesting capacity', async t => {
  const f = await fixture(t);
  const remote = fakeClient([]);
  const tools = await registeredTools(remote.client, f);
  await rm(f.path);
  await assert.rejects(tools.call('upload_movie_video', {
    movie_id: movieId, version: 3, confirmed: true, path: f.path,
  }), error => {
    assert.doesNotMatch(String(error), /mh-upload-tools-/);
    return true;
  });
  assert.equal(remote.calls.length, 0);
});

// 替换响应即使推进了版本，同一个媒体 UUID 的大小写差异也不能证明上传成功。
test('video replacement rejects an unchanged media UUID before cleaning the generated file', async t => {
  const f = await fixture(t);
  await prepareGeneratedRoot(f.config);
  const source = await inspectAllowedFile(f.path, f.config.allowedRoots);
  const returnedId = media.id.toUpperCase();
  for (const [name, args, target, response] of [
    ['replace_movie_video', { movie_id: movieId, version: 3 }, { ...movie, video: media },
      { ...uploadResponse, id: returnedId }],
    ['replace_episode_video', { series_id: seriesId, season_id: seasonId, episode_id: episodeId, version: 4 },
      { ...episodeEnvelope, episode: { ...episode, video: media } },
      { ...uploadResponse, id: returnedId, version: 5, series_version: 9 }],
  ] as const) {
    await t.test(name, async () => {
      const path = join(f.config.generatedRoot, name + '.mp4');
      await writeFile(path, 'video!');
      await recordGeneratedFile(path, source, f.config, f.credentials);
      const remote = fakeClient([target, response]);
      const tools = await registeredTools(remote.client, f);
      const result = await tools.registrations.get(name).handler({ ...args, path, confirmed: true });
      assert.equal(remote.calls.filter(call => call.kind === 'upload').length, 1);
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, { code: 'invalid_response' });
      assert.match(result.content[0].text, /重新查询目标视频和版本/);
      assert.equal((await stat(path)).size, 6);
    });
  }
});

// 通过真实 MCP 内存连接核对前置拒绝的机器码、脱敏文本及实际请求顺序。
test('video preflight exposes safe error codes over the MCP protocol', async t => {
  const f = await fixture(t);
  const moviePath = '/api/admin/movies/' + movieId;
  const overviewPath = '/api/admin/system/overview';
  const payload = { error: 'Authorization: Bearer mhmcp_secret /srv/media/private', fields: ['private_field'] };
  for (const [code, overview, responses, path, expectedPaths] of [
    ['auth_required', mapHttpError(401, payload, f.config.apiKey), [], f.path, [overviewPath]],
    ['forbidden', mapHttpError(403, payload, f.config.apiKey), [], f.path, [overviewPath]],
    ['rate_limited', mapHttpError(429, payload, f.config.apiKey), [], f.path, [overviewPath]],
    ['version_conflict', healthyOverview, [{ ...movie, version: 8 }], f.path, [overviewPath, moviePath]],
    ['file_changed', healthyOverview, [], join(f.allowed, 'missing-video.mp4'), []],
  ] as const) {
    await t.test(code, async () => {
      const remote = fakeClient([...responses], overview);
      const server = buildServer({ ...f, client: remote.client as any });
      const client = new Client({ name: 'video-preflight-test', version: '1.0.0' });
      const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
      await server.connect(serverEnd);
      await client.connect(clientEnd);
      try {
        const result = await client.callTool({ name: 'upload_movie_video',
          arguments: { movie_id: movieId, version: 3, confirmed: true, path } });
        assert.equal(result.isError, true);
        assert.deepEqual(result.structuredContent, { code });
        assert.doesNotMatch(JSON.stringify(result), /Bearer|Authorization|mhmcp_|private_field|mh-upload-tools-|\/srv\/media/);
        assert.deepEqual(remote.calls.map(call => call.path), expectedPaths);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }
});
