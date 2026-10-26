import assert from 'node:assert/strict';
import { test } from 'node:test';

// A missing atomic tool prevents callers from choosing each domain action explicitly.
test('catalog genre movie series episode tools advertise independent schemas and side effects', async () => {
  const modules = await Promise.all(['catalog', 'genres', 'movies', 'series'].map(name => import(`../src/tools/${name}.js`).catch(() => null)));
  assert.ok(modules.every(Boolean), 'content tool modules must exist');
  const registrations = new Map<string, any>();
  const server = { registerTool(name: string, schema: any, handler: any) { registrations.set(name, { schema, handler }); } };
  const client = { json: async () => { throw new Error('unexpected request'); }, upload: async () => { throw new Error('unexpected upload'); } };
  modules[0]!.registerCatalogTools(server, client);
  modules[1]!.registerGenreTools(server, client);
  modules[2]!.registerMovieTools(server, { client, allowedRoots: [] });
  modules[3]!.registerSeriesTools(server, client);
  assert.deepEqual([...registrations.keys()].sort(), ['search_movies', 'search_series', 'get_series_structure', 'list_genres', 'create_genre', 'stage_poster', 'create_movie', 'create_series', 'create_season', 'create_episode', 'update_movie_metadata', 'update_series_metadata', 'update_episode_metadata'].sort());
  assert.equal(new Set([...registrations.values()].map(tool => tool.schema.inputSchema)).size, 13);
  for (const [name, { schema }] of registrations) {
    assert.ok(schema.inputSchema); assert.ok(schema.outputSchema);
    assert.equal(schema.annotations.readOnlyHint, /^(search_|get_|list_)/.test(name));
    assert.equal(schema.annotations.destructiveHint, false);
  }
});

const movieId = '11111111-1111-4111-8111-111111111111';
const seriesId = '22222222-2222-4222-8222-222222222222';
const seasonId = '33333333-3333-4333-8333-333333333333';
const episodeId = '44444444-4444-4444-8444-444444444444';
const genreId = '55555555-5555-4555-8555-555555555555';
const movie = { id: movieId, name: 'Alien', year: 1979, duration_seconds: 7000, status: 'draft', version: 3, is_private: true, poster: { id: genreId, local_path: 'SECRET' }, video: null, genres: [], synopsis: '', created_at: '', updated_at: '', published_at: null, archived_at: null };
const episode = { id: episodeId, season_id: seasonId, number: 1, name: 'Pilot', duration_seconds: 500, status: 'draft', version: 1, video: null };
const series = { ...movie, id: seriesId, seasons: [{ id: seasonId, number: 1, episodes: [episode] }] };
async function tools(client: any, allowedRoots: string[] = []) {
  const registrations = new Map<string, any>();
  const server = { registerTool(name: string, schema: any, handler: any) { registrations.set(name, { schema, handler }); } };
  const catalog = await import('../src/tools/catalog.js');
  const genres = await import('../src/tools/genres.js');
  const movies = await import('../src/tools/movies.js');
  const seriesTools = await import('../src/tools/series.js');
  catalog.registerCatalogTools(server as any, client);
  genres.registerGenreTools(server as any, client);
  movies.registerMovieTools(server as any, { client, allowedRoots });
  seriesTools.registerSeriesTools(server as any, client);
  return { registrations, async call(name: string, input: unknown) {
    const tool = registrations.get(name);
    const result = await tool.handler(input);
    assert.equal(tool.schema.outputSchema.safeParse(result.structuredContent).success, true, `${name} output schema`);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    assert.doesNotMatch(JSON.stringify(result), /SECRET|mhmcp_|local_path|file_bytes/);
    return result.structuredContent;
  } };
}
function clientFixture(responses: unknown[]) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  return { calls, client: { async json(method: string, path: string, body: unknown) {
    calls.push({ method, path, body });
    assert.ok(responses.length, 'unexpected extra domain API call');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  }, async upload() { throw new Error('unexpected upload'); } } };
}

// Returning only one name or merging substrings hides distinct candidates from the caller.
test('catalog preserves movie candidates, marks trim and case exact names and never chooses among duplicates', async () => {
  const f = clientFixture([[movie, { ...movie, id: seriesId, name: ' alien ' }, { ...movie, id: episodeId, name: 'Aliens' }, { ...movie, name: 'Arrival' }]]);
  const out = await (await tools(f.client)).call('search_movies', { name: '  ALIEN ' });
  assert.deepEqual(f.calls, [{ method: 'GET', path: '/api/admin/movies', body: undefined }]);
  assert.equal(out.query, 'ALIEN'); assert.equal(out.normalized_name, 'alien');
  assert.equal(out.matches.length, 3); assert.deepEqual(out.matches.map((m: any) => m.exact), [true, true, false]);
  assert.equal(out.exact_match_count, 2); assert.equal(out.requires_selection, true);
  assert.deepEqual(out.next_actions, ['update_movie_metadata']);
  assert.deepEqual(Object.keys(out.matches[0]).sort(), ['id','name','year','duration_seconds','status','version','is_private','has_poster','has_video','exact'].sort());
});

test('catalog series counts structure and zero candidates suggest explicit creation', async () => {
  const f = clientFixture([[series], [], []]); const t = await tools(f.client);
  const found = await t.call('search_series', { name: ' Alien ' });
  assert.equal(f.calls[0]!.path, '/api/admin/series');
  assert.equal(found.matches[0].season_count, 1); assert.equal(found.matches[0].episode_count, 1);
  assert.equal(found.exact_match_count, 1); assert.equal(found.requires_selection, false);
  assert.deepEqual(found.next_actions, ['get_series_structure','update_series_metadata']);
  assert.deepEqual((await t.call('search_movies', { name: 'Unknown' })).next_actions, ['create_movie']);
  assert.deepEqual((await t.call('search_series', { name: 'Unknown' })).next_actions, ['create_series']);
});

test('series structure returns safe child metadata and next explicit action', async () => {
  const f = clientFixture([series, { ...series, seasons: [] }]); const t = await tools(f.client);
  const out = await t.call('get_series_structure', { series_id: seriesId });
  assert.deepEqual(out, { series_id: seriesId, version: 3, status: 'draft', seasons: [{ id: seasonId, number: 1, episodes: [{ id: episodeId, number: 1, name: 'Pilot', duration_seconds: 500, status: 'draft', version: 1, has_video: false }] }], next_actions: ['create_episode'] });
  assert.deepEqual((await t.call('get_series_structure', { series_id: seriesId })).next_actions, ['create_season']);
  assert.equal(f.calls[0]!.path, `/api/admin/series/${seriesId}`);
});

// A POST for an existing genre creates accidental duplicates; disabled matches cannot be revived.
test('genre list filters API fields and create reuses enabled exact names but rejects disabled names', async () => {
  const enabled = { id: genreId, name: '奇幻', enabled: true, sort_order: 1, secret: 'SECRET' };
  const f = clientFixture([[enabled], [enabled], [{ ...enabled, enabled: false }]]); const t = await tools(f.client);
  assert.deepEqual(await t.call('list_genres', {}), { genres: [{ id: genreId, name: '奇幻', enabled: true }], next_actions: [] });
  const reused = await t.call('create_genre', { name: ' 奇幻 ' });
  assert.equal(reused.id, genreId); assert.equal(reused.reused, true); assert.deepEqual(reused.next_actions, []);
  await assert.rejects(t.call('create_genre', { name: '奇幻' }), /同名题材已停用/);
  assert.equal(f.calls.every(c => c.method === 'GET'), true);
});

test('genre create recovers a concurrent same-name conflict with one reread and never fuzzy-merges', async () => {
  const { MovieHarborClientError } = await import('../src/services/error-mapper.js');
  const enabled = { id: genreId, name: 'FANTASY', enabled: true, sort_order: 1 };
  const f = clientFixture([[{ ...enabled, name: 'Fantasy world' }], new MovieHarborClientError('version_conflict', 409), [enabled]]);
  const out = await (await tools(f.client)).call('create_genre', { name: ' Fantasy ' });
  assert.equal(out.reused, true); assert.equal(out.id, genreId);
  assert.deepEqual(f.calls.map(c => [c.method,c.path,c.body]), [['GET','/api/admin/genres',undefined],['POST','/api/admin/genres',{ name:'Fantasy' }],['GET','/api/admin/genres',undefined]]);
  for (const response of [[{ ...enabled, enabled: false }], [], [{ ...enabled, name: 'Fantasy world' }]]) {
    const g = clientFixture([[], new MovieHarborClientError('version_conflict',409), response]);
    await assert.rejects((await tools(g.client)).call('create_genre', { name:'Fantasy' }), response[0]?.enabled === false ? /同名题材已停用/ : /版本|冲突/);
    assert.equal(g.calls.length,3);
  }
  const created = clientFixture([[], enabled]);
  assert.equal((await (await tools(created.client)).call('create_genre',{name:'Fantasy'})).reused,false);
});

// Malformed creates and mutations must fail before network calls, even on direct handler use.
test('movie series episode schemas reject missing required fields and invalid mutations before HTTP', async () => {
  const f = clientFixture([]); const t = await tools(f.client);
  const movieInput = { name:'Alien',year:1979,duration_seconds:7000,genre_ids:[genreId],staged_poster_token:'poster-token' };
  const seriesInput = { name:'Alien',year:1979,genre_ids:[genreId],staged_poster_token:'poster-token' };
  const episodeInput = { series_id:seriesId,season_id:seasonId,version:3,number:1,name:'Pilot',duration_seconds:500 };
  for (const [tool,input,keys] of [['create_movie',movieInput,['name','year','duration_seconds','genre_ids','staged_poster_token']],['create_series',seriesInput,['year','genre_ids','staged_poster_token']],['create_episode',episodeInput,['name','duration_seconds','version']]] as const) {
    for (const key of keys) { const invalid: any = {...input}; delete invalid[key]; await assert.rejects(t.call(tool,invalid)); }
  }
  for (const invalid of [{...movieInput,genre_ids:[]},{...movieInput,genre_ids:[genreId,genreId]},{...movieInput,year:10000},{...movieInput,name:' '},{...movieInput,duration_seconds:0},{...movieInput,is_private:false},{...movieInput,confirmed:true}]) await assert.rejects(t.call('create_movie',invalid));
  await assert.rejects(t.call('create_season',{series_id:'bad',version:1,number:1}));
  await assert.rejects(t.call('create_episode',{...episodeInput,number:0}));
  for (const [name,ids] of [['update_movie_metadata',{movie_id:movieId}],['update_series_metadata',{series_id:seriesId}],['update_episode_metadata',{series_id:seriesId,season_id:seasonId,episode_id:episodeId}]] as const) {
    await assert.rejects(t.call(name,{...ids,version:1}));
    await assert.rejects(t.call(name,{...ids,version:0,name:'New'}));
    await assert.rejects(t.call(name,{...ids,version:1,name:' '}));
  }
  assert.equal(f.calls.length,0);
});

test('movie and series creation use one API and force a complete private draft', async () => {
  const f = clientFixture([movie,series]); const t = await tools(f.client);
  const common = {name:' Alien ',year:1979,genre_ids:[genreId],staged_poster_token:'poster-token'};
  assert.deepEqual(await t.call('create_movie',{...common,duration_seconds:7000}),{id:movieId,version:3,status:'draft',next_actions:['upload_movie_video']});
  assert.deepEqual(await t.call('create_series',common),{id:seriesId,version:3,status:'draft',next_actions:['create_season']});
  assert.deepEqual(f.calls,[{method:'POST',path:'/api/admin/movies',body:{...common,name:'Alien',duration_seconds:7000,is_private:true}},{method:'POST',path:'/api/admin/series',body:{...common,name:'Alien',is_private:true}}]);
});

test('series season create extracts its unique child and returns parent version without follow-up HTTP', async () => {
  const f = clientFixture([series,{...series,seasons:[]},{...series,seasons:[...series.seasons,...series.seasons]}]); const t = await tools(f.client);
  assert.deepEqual(await t.call('create_season',{series_id:seriesId,version:2,number:1}),{series_id:seriesId,series_version:3,season_id:seasonId,next_actions:['create_episode']});
  for(let i=0;i<2;i++) await assert.rejects(t.call('create_season',{series_id:seriesId,version:2,number:1}), /数据格式无效/);
  assert.deepEqual(f.calls[0],{method:'POST',path:`/api/admin/series/${seriesId}/seasons`,body:{version:2,number:1}});
});

test('movie series episode updates route only explicit patches, preserve versions and suggest safe next actions', async () => {
  const f = clientFixture([movie,{...movie,video:{id:genreId}},series,{series_version:4,episode},{series_version:5,episode:{...episode,video:{id:genreId},version:2}}]); const t = await tools(f.client);
  const a = await t.call('update_movie_metadata',{movie_id:movieId,version:2,name:' New '});
  assert.deepEqual(a.next_actions,['upload_movie_video']);
  const b = await t.call('update_movie_metadata',{movie_id:movieId,version:3,synopsis:''});
  assert.deepEqual(b.next_actions,['replace_movie_video','publish_movie']);
  assert.deepEqual((await t.call('update_series_metadata',{series_id:seriesId,version:2,year:1979})).next_actions,['get_series_structure']);
  const ids = {series_id:seriesId,season_id:seasonId,episode_id:episodeId};
  assert.deepEqual(await t.call('update_episode_metadata',{...ids,version:1,name:'Pilot'}),{id:episodeId,version:1,status:'draft',series_version:4,next_actions:['upload_episode_video']});
  assert.deepEqual((await t.call('update_episode_metadata',{...ids,version:1,number:2})).next_actions,['replace_episode_video','publish_episode']);
  assert.deepEqual(f.calls[0],{method:'PATCH',path:`/api/admin/movies/${movieId}`,body:{version:2,name:'New'}});
  assert.deepEqual(f.calls[3],{method:'PATCH',path:`/api/admin/series/${seriesId}/seasons/${seasonId}/episodes/${episodeId}`,body:{version:1,name:'Pilot'}});
});

test('movie and series version conflicts propagate stable errors without implicit retries', async () => {
  const { MovieHarborClientError } = await import('../src/services/error-mapper.js');
  const f = clientFixture([new MovieHarborClientError('version_conflict',409)]);
  await assert.rejects((await tools(f.client)).call('update_movie_metadata',{movie_id:movieId,version:1,name:'New'}), error => error instanceof MovieHarborClientError && error.code === 'version_conflict');
  assert.equal(f.calls.length,1);
});

// Creating an episode must locate the exact child in the API's whole-series response.
test('episode create extracts its own version and parent version and rejects missing or ambiguous children', async () => {
  const variants = [series, { ...series, seasons: [] }, { ...series, seasons: [...series.seasons, ...series.seasons] },
    { ...series, seasons: [{ ...series.seasons[0], episodes: [] }] },
    { ...series, seasons: [{ ...series.seasons[0], episodes: [episode, episode] }] }];
  const f = clientFixture(variants); const t = await tools(f.client);
  const input = { series_id: seriesId, season_id: seasonId, version: 2, number: 1, name: ' Pilot ', duration_seconds: 500 };
  assert.deepEqual(await t.call('create_episode', input), { id: episodeId, version: 1, status: 'draft', series_version: 3, next_actions: ['upload_episode_video'] });
  for (let i = 0; i < 4; i++) await assert.rejects(t.call('create_episode',input), /数据格式无效/);
  assert.deepEqual(f.calls[0], { method:'POST', path:`/api/admin/series/${seriesId}/seasons/${seasonId}/episodes`, body:{ version:2, number:1, name:'Pilot', duration_seconds:500 } });
  assert.equal(f.calls.length, 5);
});

test('catalog and movie invalid API payloads produce safe stable errors', async () => {
  const { MovieHarborClientError } = await import('../src/services/error-mapper.js');
  for (const [name,input,response] of [
    ['search_movies',{name:'Alien'},[{...movie,version:'SECRET'}]],
    ['search_series',{name:'Alien'},[{...series,seasons:'SECRET'}]],
    ['create_movie',{name:'Alien',year:1979,duration_seconds:7000,genre_ids:[genreId],staged_poster_token:'poster-token'},null],
    ['update_episode_metadata',{series_id:seriesId,season_id:seasonId,episode_id:episodeId,version:1,name:'New'},{series_version:3,episode:'SECRET'}],
  ] as const) {
    const f = clientFixture([response]);
    await assert.rejects((await tools(f.client)).call(name,input), error => error instanceof MovieHarborClientError && error.code === 'invalid_response' && !String(error).includes('SECRET'));
    assert.equal(f.calls.length,1);
  }
});

// Runs the real file policy, poster inspector and streaming HTTP client together.
test('movie stage poster validates MIME and file identity before one bounded upload and returns only staging metadata', async t => {
  const { mkdtemp,realpath,writeFile,rm,mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { createServer } = await import('node:http');
  const { createMovieHarborClient } = await import('../src/services/movie-harbor-client.js');
  const directory = await realpath(await mkdtemp(join(tmpdir(),'mh-content-')));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const allowed = join(directory,'allowed'); await mkdir(allowed);
  const path = join(allowed,'海报.png');
  const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000049454e44ae426082','hex');
  await writeFile(path,bytes);
  const requests: { method: string | undefined; url: string | undefined; contentType: string | undefined; body: Buffer }[] = [];
  const server = createServer(async (req,res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({method:req.method,url:req.url,contentType:req.headers['content-type'],body:Buffer.concat(chunks)});
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({token:'mhposter_test',format:'png',byte_size:bytes.length,expires_at:'2026-10-26T10:30:00+00:00',local_path:'SECRET',file_bytes:'SECRET'}));
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const client = createMovieHarborClient({ baseUrl:new URL(`http://127.0.0.1:${address.port}/`),apiKey:'mhmcp_test',allowedRoots:[allowed],generatedRoot:join(directory,'generated'),requestTimeoutMs:1000 });
  const toolsForFile = await tools(client,[allowed]);
  const out = await toolsForFile.call('stage_poster',{path});
  assert.deepEqual(out,{staged_poster_token:'mhposter_test',format:'png',byte_size:bytes.length,expires_at:'2026-10-26T10:30:00+00:00',next_actions:['create_movie','create_series']});
  assert.equal(requests.length,1); assert.equal(requests[0]!.method,'POST'); assert.equal(requests[0]!.url,'/api/admin/media/posters/stage');
  assert.match(requests[0]!.contentType!, /^multipart\/form-data; boundary=/);
  assert.ok(requests[0]!.body.includes(Buffer.from('Content-Type: image/png'))); assert.ok(requests[0]!.body.includes(bytes));
  assert.equal(JSON.stringify(out).includes(bytes.toString('base64')), false);
  const mislabeled = join(allowed,'fake.jpg'); await writeFile(mislabeled,bytes);
  const outside = join(directory,'outside.png'); await writeFile(outside,bytes);
  for (const input of [{path:mislabeled},{path:outside},{path:'relative.png'},{path,confirmed:true}]) await assert.rejects(toolsForFile.call('stage_poster',input));
  assert.equal(requests.length,1);
});
