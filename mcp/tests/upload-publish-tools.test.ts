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
  const probeMedia = async () => ({ durationSeconds: 1, video: { index: 0, codec: 'h264', pixelFormat: 'yuv420p' }, audio: [], subtitles: [] }) as any;
  return { directory, allowed, credentials, credentialDirectory:credentials, path, config, probeMedia };
}

function fakeClient(responses: unknown[]) {
  const calls: any[] = [];
  return { calls, client: {
    async json(method: string, path: string, body?: unknown) {
      calls.push({ kind: 'json', method, path, body });
      assert.ok(responses.length, `unexpected JSON call ${method} ${path}`);
      const value = responses.shift(); if (value instanceof Error) throw value; return value;
    },
    async upload(path: string, file: any, mimeType: string) {
      calls.push({ kind: 'upload', path, requestedPath: file.requestedPath, mimeType });
      assert.ok(responses.length, `unexpected upload ${path}`);
      const value = responses.shift(); if (value instanceof Error) throw value; return value;
    },
  } };
}

async function registeredTools(client: any, dependencies: any) {
  const uploads = await import('../src/tools/uploads.js');
  const publishing = await import('../src/tools/publishing.js');
  const registrations = new Map<string, any>();
  const server = { registerTool(name: string, schema: any, handler: any) { registrations.set(name, { schema, handler }); } };
  uploads.registerUploadTools(server as any, { ...dependencies, client });
  publishing.registerPublishingTools(server as any, client);
  return { registrations, async call(name: string, input: unknown) {
    const tool = registrations.get(name); assert.ok(tool, name);
    const result = await tool.handler(input);
    assert.equal(tool.schema.outputSchema.safeParse(result.structuredContent).success, true, `${name} output`);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|local_path|mhmcp_/);
    return result.structuredContent;
  } };
}

test('upload, replace and publish tools register independently with strict write annotations', async t => {
  const f = await fixture(t); const c = fakeClient([]); const tools = await registeredTools(c.client, f);
  assert.deepEqual([...tools.registrations.keys()], ['upload_movie_video','replace_movie_video','upload_episode_video','replace_episode_video','publish_movie','publish_episode','publish_series']);
  for (const { schema } of tools.registrations.values()) {
    assert.ok(schema.inputSchema); assert.ok(schema.outputSchema);
    assert.deepEqual(schema.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  }
  await assert.rejects(tools.call('replace_movie_video', { movie_id:movieId,version:3,path:f.path,confirmed:false }), /需要明确确认替换/);
  await assert.rejects(tools.call('publish_movie', { movie_id:movieId,version:3,confirmed:false }), /需要独立发布确认/);
  assert.equal(c.calls.length, 0);
});

test('ordinary movie upload refuses an occupied slot and never uploads or publishes', async t => {
  const f = await fixture(t); const c = fakeClient([{ ...movie, video: media }]);
  const tools = await registeredTools(c.client, f);
  await assert.rejects(tools.call('upload_movie_video', { movie_id:movieId,version:3,path:f.path }), /已有视频.*replace_movie_video/);
  assert.deepEqual(c.calls.map(call => [call.kind,call.method,call.path]), [['json','GET',`/api/admin/movies/${movieId}`]]);
});

test('movie upload validates compatible media, streams once, filters output and does not publish', async t => {
  const f = await fixture(t); const c = fakeClient([movie, uploadResponse]); const tools = await registeredTools(c.client, f);
  const out = await tools.call('upload_movie_video', { movie_id:movieId,version:3,path:f.path });
  assert.deepEqual(out, { id:movieId,version:4,media_id:mediaId,mime_type:'video/mp4',byte_size:6,
    generated_file_deleted:false,retained_generated_path:null,next_actions:['publish_movie'] });
  assert.deepEqual(c.calls.map(call => [call.kind,call.method,call.path,call.mimeType]), [
    ['json','GET',`/api/admin/movies/${movieId}`,undefined],
    ['upload',undefined,`/api/admin/media/movies/${movieId}/video?version=3`,'video/mp4'],
  ]);
  assert.equal(c.calls.some(call => String(call.path).includes('publish')), false);
});

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
  await assert.rejects(blockedTools.call('upload_movie_video',{movie_id:movieId,version:3,path:mkv}), /convert_video|转换/);
  assert.equal(blocked.calls.filter(call => call.kind === 'upload').length, 0);
});

test('episode upload validates hierarchy and returns episode and parent versions', async t => {
  const f = await fixture(t); const response = { ...uploadResponse, version:5, series_version:9 };
  const c = fakeClient([episodeEnvelope,response]); const tools = await registeredTools(c.client, f);
  const input = {series_id:seriesId,season_id:seasonId,episode_id:episodeId,version:4,path:f.path};
  assert.deepEqual(await tools.call('upload_episode_video',input), {id:episodeId,version:5,series_version:9,media_id:mediaId,
    mime_type:'video/mp4',byte_size:6,generated_file_deleted:false,retained_generated_path:null,next_actions:['publish_episode']});
  assert.deepEqual(c.calls.map(call => call.path), [
    `/api/admin/series/${seriesId}/seasons/${seasonId}/episodes/${episodeId}`,
    `/api/admin/media/episodes/${episodeId}/video?version=4`,
  ]);
  const wrong = fakeClient([{series_version:8,episode:{...episode,id:movieId}}]);
  await assert.rejects((await registeredTools(wrong.client,f)).call('upload_episode_video',input), /数据格式无效/);
  assert.equal(wrong.calls.length,1);
});

test('upload rejects semantically impossible movie responses before cleanup', async t => {
  const f = await fixture(t);
  for (const [index,response] of [
    { ...uploadResponse, mime_type:'video/webm' },
    { ...uploadResponse, byte_size:999 },
    { ...uploadResponse, version:5 },
  ].entries()) {
    const ordinary = fakeClient([movie,response]);
    await assert.rejects((await registeredTools(ordinary.client,f)).call('upload_movie_video',{movie_id:movieId,version:3,path:f.path}),/数据格式无效/);
    assert.equal(await stat(f.path).then(()=>true),true);
    assert.equal(ordinary.calls.length,2);

    await prepareGeneratedRoot(f.config);
    const source = await inspectAllowedFile(f.path,f.config.allowedRoots);
    const generated = join(f.config.generatedRoot,`bad-${index}.mp4`);
    await writeFile(generated,'made');
    await recordGeneratedFile(generated,source,f.config,f.credentials);
    const generatedClient = fakeClient([movie,{...response,byte_size:response.byte_size===999?999:4}]);
    await assert.rejects((await registeredTools(generatedClient.client,f)).call('upload_movie_video',{movie_id:movieId,version:3,path:generated}),/数据格式无效/);
    assert.equal(await stat(generated).then(()=>true),true,'invalid response must retain generated file');
    assert.equal(generatedClient.calls.length,2);
  }
});

test('episode upload rejects target or parent version jumps before cleanup', async t => {
  const f = await fixture(t); const input={series_id:seriesId,season_id:seasonId,episode_id:episodeId,version:4,path:f.path};
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
    await assert.rejects((await registeredTools(generatedClient.client,f)).call('upload_episode_video',{...input,path:generated}),/数据格式无效/);
    assert.equal(await stat(generated).then(()=>true),true,'invalid episode response must retain generated file');
    assert.equal(generatedClient.calls.length,2);
  }
});

test('successful generated upload deletes only registered conversion output and failures retain it', async t => {
  const f = await fixture(t); await prepareGeneratedRoot(f.config);
  const source = await inspectAllowedFile(f.path, f.config.allowedRoots);
  const generated = join(f.config.generatedRoot,'converted.mp4'); await writeFile(generated,'made');
  await recordGeneratedFile(generated,source,f.config,f.credentials);
  const success = fakeClient([movie,{...uploadResponse,byte_size:4}]);
  const successTools = await registeredTools(success.client,f);
  const out = await successTools.call('upload_movie_video',{movie_id:movieId,version:3,path:generated});
  assert.equal(out.generated_file_deleted,true); assert.equal(out.retained_generated_path,null);
  await assert.rejects(stat(generated),{code:'ENOENT'});

  const generated2 = join(f.config.generatedRoot,'retry.mp4'); await writeFile(generated2,'retry');
  await recordGeneratedFile(generated2,source,f.config,f.credentials);
  const failure = fakeClient([movie,new Error('remote failed')]);
  await assert.rejects((await registeredTools(failure.client,f)).call('upload_movie_video',{movie_id:movieId,version:3,path:generated2}), error => /保留|retry/.test(String(error)));
  assert.equal(await stat(generated2).then(() => true),true);
});

test('publishing rejects archived targets, is idempotent when published and validates ownership', async t => {
  const f = await fixture(t);
  for (const target of [{...movie,status:'archived'},{...movie,status:'published'}]) {
    const c = fakeClient([target]); const tools = await registeredTools(c.client,f);
    if (target.status === 'archived') await assert.rejects(tools.call('publish_movie',{movie_id:movieId,version:3,confirmed:true}),/归档/);
    else assert.deepEqual(await tools.call('publish_movie',{movie_id:movieId,version:3,confirmed:true}),{id:movieId,version:3,status:'published',next_actions:[]});
    assert.equal(c.calls.length,1); assert.equal(c.calls[0].method,'GET');
  }
  const wrong = fakeClient([{...movie,id:seriesId}]);
  await assert.rejects((await registeredTools(wrong.client,f)).call('publish_movie',{movie_id:movieId,version:3,confirmed:true}),/数据格式无效/);
  assert.equal(wrong.calls.length,1);
});

test('movie, episode and parent series publish only through separate confirmed calls', async t => {
  const f = await fixture(t);
  const publishedMovie = {...movie,status:'published',version:4};
  const publishedEpisode = {...episode,status:'published',version:5};
  const publishedSeries = {...series,status:'published',version:10};
  const c = fakeClient([movie,publishedMovie,series,episodeEnvelope,{series_version:9,episode:publishedEpisode},{...series,version:9},publishedSeries]);
  const tools = await registeredTools(c.client,f);
  assert.deepEqual(await tools.call('publish_movie',{movie_id:movieId,version:3,confirmed:true}),{id:movieId,version:4,status:'published',next_actions:[]});
  assert.deepEqual(await tools.call('publish_episode',{series_id:seriesId,season_id:seasonId,episode_id:episodeId,version:4,confirmed:true}),
    {id:episodeId,version:5,status:'published',series_version:9,next_actions:['publish_series']});
  assert.deepEqual(await tools.call('publish_series',{series_id:seriesId,version:9,confirmed:true}),{id:seriesId,version:10,status:'published',next_actions:[]});
  assert.deepEqual(c.calls.filter(call => call.method === 'POST').map(call => [call.path,call.body]),[
    [`/api/admin/movies/${movieId}/publish`,{version:3}],
    [`/api/admin/series/${seriesId}/seasons/${seasonId}/episodes/${episodeId}/publish`,{version:4}],
    [`/api/admin/series/${seriesId}/publish`,{version:9}],
  ]);
});

test('publishing rejects impossible version transitions without later calls', async t => {
  const f=await fixture(t);
  for(const response of [{...movie,status:'published',version:3},{...movie,status:'published',version:5}]){
    const c=fakeClient([movie,response]);
    await assert.rejects((await registeredTools(c.client,f)).call('publish_movie',{movie_id:movieId,version:3,confirmed:true}),/数据格式无效/);
    assert.equal(c.calls.length,2);
  }
  for(const response of [{...series,status:'published',version:8},{...series,status:'published',version:10}]){
    const c=fakeClient([series,response]);
    await assert.rejects((await registeredTools(c.client,f)).call('publish_series',{series_id:seriesId,version:8,confirmed:true}),/数据格式无效/);
    assert.equal(c.calls.length,2);
  }
  const mismatchedDetail=fakeClient([series,{...episodeEnvelope,series_version:7}]);
  await assert.rejects((await registeredTools(mismatchedDetail.client,f)).call('publish_episode',{series_id:seriesId,season_id:seasonId,episode_id:episodeId,version:4,confirmed:true}),/数据格式无效/);
  assert.equal(mismatchedDetail.calls.length,2,'detail mismatch must stop before publish POST');
  for(const response of [
    {series_version:9,episode:{...episode,status:'published',version:4}},
    {series_version:9,episode:{...episode,status:'published',version:6}},
    {series_version:8,episode:{...episode,status:'published',version:5}},
    {series_version:10,episode:{...episode,status:'published',version:5}},
  ]){
    const c=fakeClient([series,episodeEnvelope,response]);
    await assert.rejects((await registeredTools(c.client,f)).call('publish_episode',{series_id:seriesId,season_id:seasonId,episode_id:episodeId,version:4,confirmed:true}),/数据格式无效/);
    assert.equal(c.calls.length,3);
  }
});

test('episode publishing stops before transition when its parent is archived', async t => {
  const f = await fixture(t); const c = fakeClient([{...series,status:'archived'}]); const tools = await registeredTools(c.client,f);
  await assert.rejects(tools.call('publish_episode',{series_id:seriesId,season_id:seasonId,episode_id:episodeId,version:4,confirmed:true}),/父剧集.*归档/);
  assert.equal(c.calls.length,1); assert.equal(c.calls[0].method,'GET');
});
