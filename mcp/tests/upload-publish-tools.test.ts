import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { inspectAllowedFile } from '../src/services/path-policy.js';
import { prepareGeneratedRoot, recordGeneratedFile } from '../src/services/generated-files.js';

const movieId = '11111111-1111-4111-8111-111111111111';
const seriesId = '22222222-2222-4222-8222-222222222222';
const seasonId = '33333333-3333-4333-8333-333333333333';
const episodeId = '44444444-4444-4444-8444-444444444444';
const mediaId = '55555555-5555-4555-8555-555555555555';
const media = { id: mediaId, local_path: 'SECRET' };
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
function fakeClient(responses: unknown[]) {
  const calls: any[] = [];
  return { calls, client: {
    // 测试请求时记录参数并返回预设的 API 响应。
    async json(method: string, path: string, body?: unknown) {
      calls.push({ kind: 'json', method, path, body });
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
  assert.deepEqual(c.calls.map(call => [call.kind,call.method,call.path]), [['json','GET',`/api/admin/movies/${movieId}`]]);
});

// 验证电影上传检查兼容媒体、仅流式上传一次、过滤输出且不自动发布。
test('movie upload validates compatible media, streams once, filters output and does not publish', async t => {
  const f = await fixture(t); const c = fakeClient([movie, uploadResponse]); const tools = await registeredTools(c.client, f);
  const out = await tools.call('upload_movie_video', { movie_id:movieId,version:3,path:f.path,confirmed:true });
  assert.deepEqual(out, { id:movieId,version:4,media_id:mediaId,mime_type:'video/mp4',byte_size:6,
    generated_file_deleted:false,retained_generated_path:null,next_actions:['transition_content_lifecycle'] });
  assert.deepEqual(c.calls.map(call => [call.kind,call.method,call.path,call.mimeType]), [
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
    `/api/admin/series/${seriesId}/seasons/${seasonId}/episodes/${episodeId}`,
    `/api/admin/media/episodes/${episodeId}/video?version=4`,
  ]);
  const wrong = fakeClient([{series_version:8,episode:{...episode,id:movieId}}]);
  await assert.rejects((await registeredTools(wrong.client,f)).call('upload_episode_video',input), /数据格式无效/);
  assert.equal(wrong.calls.length,1);
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
    assert.equal(ordinary.calls.length,2);

    await prepareGeneratedRoot(f.config);
    const source = await inspectAllowedFile(f.path,f.config.allowedRoots);
    const generated = join(f.config.generatedRoot,`bad-${index}.mp4`);
    await writeFile(generated,'made');
    await recordGeneratedFile(generated,source,f.config,f.credentials);
    const generatedClient = fakeClient([movie,{...response,byte_size:response.byte_size===999?999:4}]);
    await assert.rejects((await registeredTools(generatedClient.client,f)).call('upload_movie_video',{movie_id:movieId,version:3,path:generated,confirmed:true}),/数据格式无效/);
    assert.equal(await stat(generated).then(()=>true),true,'invalid response must retain generated file');
    assert.equal(generatedClient.calls.length,2);
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
    assert.equal(c.calls.length,2);

    await prepareGeneratedRoot(f.config);
    const source=await inspectAllowedFile(f.path,f.config.allowedRoots);
    const generated=join(f.config.generatedRoot,`bad-episode-${index}.mp4`);
    await writeFile(generated,'made');
    await recordGeneratedFile(generated,source,f.config,f.credentials);
    const generatedClient=fakeClient([episodeEnvelope,{...response,byte_size:4}]);
    await assert.rejects((await registeredTools(generatedClient.client,f)).call('upload_episode_video',{...input,path:generated,confirmed:true}),/数据格式无效/);
    assert.equal(await stat(generated).then(()=>true),true,'invalid episode response must retain generated file');
    assert.equal(generatedClient.calls.length,2);
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
