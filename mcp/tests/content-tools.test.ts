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
  assert.deepEqual(Object.keys(out.matches[0]).sort(), ['id','name','year','duration_minutes','status','version','is_private','has_poster','has_video','exact'].sort());
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

// Returning creation actions here would make the caller continue mutating a terminal MCP target.
test('archived series structure stops MCP child creation and points to administrator action', async () => {
  const archived = { ...series, status: 'archived' as const };
  const f = clientFixture([archived]); const t = await tools(f.client);
  const result = await t.registrations.get('get_series_structure').handler({ series_id: seriesId });
  assert.deepEqual(result.structuredContent.next_actions, []);
  assert.equal(result.structuredContent.status, 'archived');
  assert.match(result.content[0].text, /已归档/);
  assert.match(result.content[0].text, /管理员/);
  assert.doesNotMatch(result.content[0].text, /可创建|请创建/);
  assert.equal(f.calls.length, 1);
});

// A POST for an existing genre creates accidental duplicates; disabled matches cannot be revived.
test('genre list filters API fields and create reuses enabled exact names but rejects disabled names', async () => {
  const enabled = { id: genreId, name: '奇幻', enabled: true, sort_order: 1, secret: 'SECRET' };
  const f = clientFixture([[enabled], [enabled], [{ ...enabled, enabled: false }]]); const t = await tools(f.client);
  assert.deepEqual(await t.call('list_genres', {}), { genres: [{ id: genreId, name: '奇幻', enabled: true }], next_actions: [] });
  const reused = await t.call('create_genre', { name: ' 奇幻 ', confirmed: true });
  assert.equal(reused.id, genreId); assert.equal(reused.reused, true); assert.deepEqual(reused.next_actions, []);
  await assert.rejects(t.call('create_genre', { name: '奇幻', confirmed: true }), /同名题材已停用/);
  assert.equal(f.calls.every(c => c.method === 'GET'), true);
});

// Missing confirmation must stop even the duplicate lookup; MCP-only fields never reach the API.
test('genre creation requires import confirmation before any request and strips it from the API body', async () => {
  const f = clientFixture([[], { id: genreId, name: '奇幻', enabled: true }]);
  const t = await tools(f.client);
  await assert.rejects(t.call('create_genre', { name: '奇幻' }));
  await assert.rejects(t.call('create_genre', { name: '奇幻', confirmed: false }));
  assert.equal(f.calls.length, 0);

  const created = await t.call('create_genre', { name: '奇幻', confirmed: true });
  assert.equal(created.reused, false);
  assert.deepEqual(f.calls.at(-1)!.body, { name: '奇幻' });
});

// Built-in genres use canonical UUID text whose RFC version/variant bits are zero.
test('genre list accepts the built-in database UUID representation', async () => {
  const seededId = '00000000-0000-0000-0001-000000000001';
  const f = clientFixture([[{ id: seededId, name: '剧情', enabled: true, sort_order: 1 }]]);
  const out = await (await tools(f.client)).call('list_genres', {});
  assert.deepEqual(out, { genres: [{ id: seededId, name: '剧情', enabled: true }], next_actions: [] });
  assert.equal(f.calls.length, 1);
});

test('genre create recovers a concurrent same-name conflict with one reread and never fuzzy-merges', async () => {
  const { MovieHarborClientError } = await import('../src/services/error-mapper.js');
  const enabled = { id: genreId, name: 'FANTASY', enabled: true, sort_order: 1 };
  const f = clientFixture([[{ ...enabled, name: 'Fantasy world' }], new MovieHarborClientError('version_conflict', 409), [enabled]]);
  const out = await (await tools(f.client)).call('create_genre', { name: ' Fantasy ', confirmed: true });
  assert.equal(out.reused, true); assert.equal(out.id, genreId);
  assert.deepEqual(f.calls.map(c => [c.method,c.path,c.body]), [['GET','/api/admin/genres',undefined],['POST','/api/admin/genres',{ name:'Fantasy' }],['GET','/api/admin/genres',undefined]]);
  for (const response of [[{ ...enabled, enabled: false }], [], [{ ...enabled, name: 'Fantasy world' }]]) {
    const g = clientFixture([[], new MovieHarborClientError('version_conflict',409), response]);
    await assert.rejects((await tools(g.client)).call('create_genre', { name:'Fantasy', confirmed:true }), response[0]?.enabled === false ? /同名题材已停用/ : /版本|冲突/);
    assert.equal(g.calls.length,3);
  }
  const created = clientFixture([[], enabled]);
  assert.equal((await (await tools(created.client)).call('create_genre',{name:'Fantasy',confirmed:true})).reused,false);
});

// Wrong unit, access scope, or leaked MCP-only fields would change the created record.
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

test('series creation rejects mismatched API visibility as invalid_response without retrying', async () => {
  const { MovieHarborClientError } = await import('../src/services/error-mapper.js');
  for (const [visibility, is_private] of [['public', true], ['private', false]] as const) {
    const f = clientFixture([{ ...series, is_private }]);
    await assert.rejects((await tools(f.client)).call('create_series', {
      name: 'Alien', synopsis: '围绕未知生命展开的系列故事。', year: 1979,
      genre_ids: [genreId], staged_poster_token: 'poster-token', visibility, confirmed: true,
    }), error => error instanceof MovieHarborClientError && error.code === 'invalid_response');
    assert.equal(f.calls.length, 1);
  }
});

test('series creation summaries identify the selected draft visibility', async () => {
  const f = clientFixture([{ ...series, is_private: false }, { ...series, is_private: true }]);
  const t = await tools(f.client);
  for (const [visibility, label] of [['public', '公开'], ['private', '私密']] as const) {
    const result = await t.registrations.get('create_series').handler({
      name: 'Alien', synopsis: '围绕未知生命展开的系列故事。', year: 1979,
      genre_ids: [genreId], staged_poster_token: 'poster-token', visibility, confirmed: true,
    });
    assert.match(result.content[0].text, new RegExp(`${label}.*草稿`));
  }
});

test('movie tools expose integer minutes and convert updates back to API seconds', async () => {
  const f = clientFixture([[{ ...movie, duration_seconds: 10176 }], { ...movie, duration_seconds: 10200 }]);
  const t = await tools(f.client);
  const found = await t.call('search_movies', { name: 'Alien' });
  assert.equal(found.matches[0].duration_minutes, 170);
  assert.equal('duration_seconds' in found.matches[0], false);
  await t.call('update_movie_metadata', { movie_id: movieId, version: 3, duration_minutes: 170 });
  assert.deepEqual(f.calls[1]!.body, { version: 3, duration_seconds: 10200 });
});

for (const duration_seconds of [7000, null]) {
  test(`movie duration update rejects API duration ${duration_seconds} as invalid_response without retrying`, async () => {
    const { MovieHarborClientError } = await import('../src/services/error-mapper.js');
    const f = clientFixture([{ ...movie, duration_seconds }]);
    await assert.rejects((await tools(f.client)).call('update_movie_metadata', {
      movie_id: movieId, version: 3, duration_minutes: 170,
    }), error => error instanceof MovieHarborClientError && error.code === 'invalid_response');
    assert.deepEqual(f.calls, [{
      method: 'PATCH', path: `/api/admin/movies/${movieId}`, body: { version: 3, duration_seconds: 10200 },
    }]);
  });
}

test('movie minute helpers round probe seconds, preserve null and reject overflow before HTTP', async () => {
  const common = await import('../src/schemas/common.js');
  assert.equal(typeof common.durationMinutesFromSeconds, 'function');
  assert.equal(common.durationMinutesFromSeconds(10176.1), 170);
  assert.equal(common.durationMinutesFromSeconds(1), 1);
  assert.equal(common.durationMinutesFromSeconds(89), 1);
  assert.equal(common.durationMinutesFromSeconds(90), 2);
  assert.equal(common.durationMinutesFromSeconds(null), null);
  assert.equal(common.durationSecondsFromMinutes(170), 10200);
  assert.equal(common.durationSecondsFromMinutes(35_791_394), 2_147_483_640);
  for (const minutes of [0, -1, 35_791_395, Number.MAX_SAFE_INTEGER, NaN, Infinity]) {
    assert.throws(() => common.durationSecondsFromMinutes(minutes), /电影时长超出 Movie Harbor 支持范围/);
  }
});

test('movie creation rejects mismatched API visibility or duration as invalid_response without retrying', async () => {
  const { MovieHarborClientError } = await import('../src/services/error-mapper.js');
  for (const response of [
    {...movie,duration_seconds:7020,is_private:true},
    {...movie,duration_seconds:7000,is_private:false},
    {...movie,duration_seconds:null,is_private:false},
  ]) {
    const f = clientFixture([response]);
    await assert.rejects((await tools(f.client)).call('create_movie', {
      name:'Alien',synopsis:'太空货船遭遇未知生命。',year:1979,duration_minutes:117,
      genre_ids:[genreId],staged_poster_token:'poster-token',confirmed:true,
    }), error => error instanceof MovieHarborClientError && error.code === 'invalid_response');
    assert.equal(f.calls.length,1);
  }
});

// Malformed creates and mutations must fail before network calls, even on direct handler use.
test('movie series episode schemas reject missing required fields and invalid mutations before HTTP', async () => {
  const f = clientFixture([]); const t = await tools(f.client);
  const movieInput = { name:'Alien',synopsis:'太空货船遭遇未知生命。',year:1979,duration_minutes:117,genre_ids:[genreId],staged_poster_token:'poster-token',confirmed:true };
  const seriesInput = { name:'Alien',synopsis:'围绕未知生命展开的系列故事。',year:1979,genre_ids:[genreId],staged_poster_token:'poster-token',confirmed:true };
  const seasonInput = { series_id:seriesId,version:3,number:1,confirmed:true };
  const episodeInput = { series_id:seriesId,season_id:seasonId,version:3,number:1,name:'Pilot',duration_seconds:500,confirmed:true };
  for (const [tool,input,keys] of [['create_movie',movieInput,['name','synopsis','year','duration_minutes','genre_ids','staged_poster_token','confirmed']],['create_series',seriesInput,['name','synopsis','year','genre_ids','staged_poster_token','confirmed']],['create_season',seasonInput,['confirmed']],['create_episode',episodeInput,['name','duration_seconds','version','confirmed']]] as const) {
    for (const key of keys) { const invalid: any = {...input}; delete invalid[key]; await assert.rejects(t.call(tool,invalid)); }
  }
  for (const invalid of [{...movieInput,genre_ids:[]},{...movieInput,genre_ids:[genreId,genreId]},{...movieInput,year:10000},{...movieInput,name:' '},{...movieInput,synopsis:' '},{...movieInput,synopsis:''},{...movieInput,duration_minutes:0},{...movieInput,duration_minutes:1.5},{...movieInput,duration_minutes:35_791_395},{...movieInput,duration_seconds:7020},{...movieInput,is_private:false},{...movieInput,visibility:'friends'},{...movieInput,confirmed:false}]) await assert.rejects(t.call('create_movie',invalid));
  for (const invalid of [{...seriesInput,synopsis:' '},{...seriesInput,synopsis:''},{...seriesInput,confirmed:false},{...seriesInput,visibility:'friends'},{...seriesInput,is_private:false}]) await assert.rejects(t.call('create_series',invalid));
  for (const invalid of [{...seasonInput,confirmed:false},{...seasonInput,visibility:'private'},{...seasonInput,is_private:true}]) await assert.rejects(t.call('create_season',invalid));
  for (const invalid of [{...episodeInput,confirmed:false},{...episodeInput,name:' '},{...episodeInput,visibility:'private'},{...episodeInput,is_private:true}]) await assert.rejects(t.call('create_episode',invalid));
  for (const patch of [{duration_seconds:7020},{duration_minutes:35_791_395},{duration_minutes:0},{duration_minutes:1.5}]) {
    await assert.rejects(t.call('update_movie_metadata',{movie_id:movieId,version:3,...patch}));
  }
  await assert.rejects(t.call('create_season',{series_id:'bad',version:1,number:1,confirmed:true}));
  for (const series_id of ['../admin/users','11111111-1111-1111-1111-11111111111/','%2fapi%2fadmin','11111111111141118111111111111111']) {
    await assert.rejects(t.call('create_season',{series_id,version:1,number:1,confirmed:true}));
  }
  await assert.rejects(t.call('create_episode',{...episodeInput,number:0}));
  for (const [name,ids] of [['update_movie_metadata',{movie_id:movieId}],['update_series_metadata',{series_id:seriesId}],['update_episode_metadata',{series_id:seriesId,season_id:seasonId,episode_id:episodeId}]] as const) {
    await assert.rejects(t.call(name,{...ids,version:1}));
    await assert.rejects(t.call(name,{...ids,version:0,name:'New'}));
    await assert.rejects(t.call(name,{...ids,version:1,name:' '}));
  }
  assert.equal(f.calls.length,0);
});

test('movie and series creation use one API and respect each creation contract', async () => {
  const f = clientFixture([{...movie,duration_seconds:7020},series]); const t = await tools(f.client);
  const common = {name:' Alien ',year:1979,genre_ids:[genreId],staged_poster_token:'poster-token'};
  assert.deepEqual(await t.call('create_movie',{...common,synopsis:'太空货船遭遇未知生命。',duration_minutes:117,visibility:'private',confirmed:true}),{id:movieId,version:3,status:'draft',next_actions:['upload_movie_video']});
  assert.deepEqual(await t.call('create_series',{...common,synopsis:'围绕未知生命展开的系列故事。',visibility:'private',confirmed:true}),{id:seriesId,version:3,status:'draft',next_actions:['create_season']});
  assert.deepEqual(f.calls,[{method:'POST',path:'/api/admin/movies',body:{...common,name:'Alien',synopsis:'太空货船遭遇未知生命。',duration_seconds:7020,is_private:true}},{method:'POST',path:'/api/admin/series',body:{...common,name:'Alien',synopsis:'围绕未知生命展开的系列故事。',is_private:true}}]);
});

test('series season create extracts its unique child and returns parent version without follow-up HTTP', async () => {
  const f = clientFixture([series,{...series,seasons:[]},{...series,seasons:[...series.seasons,...series.seasons]}]); const t = await tools(f.client);
  assert.deepEqual(await t.call('create_season',{series_id:seriesId,version:2,number:1,confirmed:true}),{series_id:seriesId,series_version:3,season_id:seasonId,next_actions:['create_episode']});
  for(let i=0;i<2;i++) await assert.rejects(t.call('create_season',{series_id:seriesId,version:2,number:1,confirmed:true}), /数据格式无效/);
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
  const input = { series_id: seriesId, season_id: seasonId, version: 2, number: 1, name: ' Pilot ', duration_seconds: 500, confirmed: true };
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
    ['create_movie',{name:'Alien',synopsis:'太空货船遭遇未知生命。',year:1979,duration_minutes:117,genre_ids:[genreId],staged_poster_token:'poster-token',confirmed:true},null],
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
  const client = createMovieHarborClient({ baseUrl:new URL(`http://127.0.0.1:${address.port}/`),apiKey:'mhmcp_test',credentialDirectory:directory,allowedRoots:[allowed],generatedRoot:join(directory,'generated'),requestTimeoutMs:1000 });
  const toolsForFile = await tools(client,[allowed]);
  await assert.rejects(toolsForFile.call('stage_poster',{path}));
  await assert.rejects(toolsForFile.call('stage_poster',{path,confirmed:false}));
  assert.equal(requests.length,0);
  const out = await toolsForFile.call('stage_poster',{path,confirmed:true});
  assert.deepEqual(out,{staged_poster_token:'mhposter_test',format:'png',byte_size:bytes.length,expires_at:'2026-10-26T10:30:00+00:00',next_actions:['create_movie','create_series']});
  assert.equal(requests.length,1); assert.equal(requests[0]!.method,'POST'); assert.equal(requests[0]!.url,'/api/admin/media/posters/stage');
  assert.match(requests[0]!.contentType!, /^multipart\/form-data; boundary=/);
  assert.ok(requests[0]!.body.includes(Buffer.from('Content-Type: image/png'))); assert.ok(requests[0]!.body.includes(bytes));
  assert.equal(requests[0]!.body.includes(Buffer.from('confirmed')), false);
  assert.equal(JSON.stringify(out).includes(bytes.toString('base64')), false);
  const mislabeled = join(allowed,'fake.jpg'); await writeFile(mislabeled,bytes);
  const outside = join(directory,'outside.png'); await writeFile(outside,bytes);
  for (const input of [{path:mislabeled,confirmed:true},{path:outside,confirmed:true},{path:'relative.png',confirmed:true},{path,confirmed:true,unexpected:true}]) await assert.rejects(toolsForFile.call('stage_poster',input));
  assert.equal(requests.length,1);
});

// A schema-valid response can still belong to another resource; never return or reread it.
for (const [label, tool, input, response] of [
  ['series structure ID', 'get_series_structure', { series_id:seriesId }, { ...series,id:movieId }],
  ['movie update ID', 'update_movie_metadata', { movie_id:movieId,version:2,name:'New' }, { ...movie,id:seriesId }],
  ['series update ID', 'update_series_metadata', { series_id:seriesId,version:2,name:'New' }, { ...series,id:movieId }],
  ['episode update ID', 'update_episode_metadata', { series_id:seriesId,season_id:seasonId,episode_id:episodeId,version:1,name:'New' }, { series_version:4,episode:{ ...episode,id:movieId } }],
  ['episode update season', 'update_episode_metadata', { series_id:seriesId,season_id:seasonId,episode_id:episodeId,version:1,name:'New' }, { series_version:4,episode:{ ...episode,season_id:movieId } }],
  ['episode envelope series', 'update_episode_metadata', { series_id:seriesId,season_id:seasonId,episode_id:episodeId,version:1,name:'New' }, { series_version:4,series_id:movieId,episode }],
  ['episode embedded series', 'update_episode_metadata', { series_id:seriesId,season_id:seasonId,episode_id:episodeId,version:1,name:'New' }, { series_version:4,episode:{ ...episode,series_id:movieId } }],
] as const) {
  test(`catalog movie series episode rejects mismatched ${label} without another HTTP call`, async () => {
    const { MovieHarborClientError } = await import('../src/services/error-mapper.js');
    const f = clientFixture([response]);
    await assert.rejects((await tools(f.client)).call(tool,input), error => error instanceof MovieHarborClientError && error.code === 'invalid_response');
    assert.equal(f.calls.length,1);
  });
}

test('episode update accepts matching optional series ownership and filters relation fields from output', async () => {
  const f = clientFixture([{series_version:4,series_id:seriesId,episode:{...episode,series_id:seriesId}}]);
  const result = await (await tools(f.client)).call('update_episode_metadata',{series_id:seriesId,season_id:seasonId,episode_id:episodeId,version:1,name:'New'});
  assert.deepEqual(result,{id:episodeId,version:1,status:'draft',series_version:4,next_actions:['upload_episode_video']});
  assert.equal(f.calls.length,1);
});

for (const [tool, createAction, label] of [['search_movies','create_movie','电影'],['search_series','create_series','剧集']] as const) {
  test(`catalog ${tool} zero candidates text suggests explicit creation consistently with next_actions`, async () => {
    const f = clientFixture([[]]); const t = await tools(f.client);
    const result = await t.registrations.get(tool).handler({name:'Unknown'});
    assert.deepEqual(result.structuredContent.next_actions,[createAction]);
    assert.deepEqual(result.structuredContent.matches,[]);
    assert.match(result.content[0].text,/可.*创建/);
    assert.ok(result.content[0].text.includes(label));
    assert.doesNotMatch(result.content[0].text,/选择/);
    assert.equal(f.calls.length,1);
  });
}
