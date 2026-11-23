import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer } from '../src/server.js';
import { mapHttpError } from '../src/services/error-mapper.js';
import { MovieHarborClientError, type HttpMethod, type MovieHarborClient } from '../src/services/movie-harbor-client.js';

// 在内存连接中验证服务器身份、工作流说明、工具输入输出结构和完整注册。
test('server registers the complete atomic tool schemas and exposes its workflow instructions in memory', async () => {
  const config = { baseUrl:new URL('http://localhost/'),apiKey:'mhmcp_secret',credentialDirectory:'/tmp/credentials',allowedRoots:[],generatedRoot:'/tmp/generated',requestTimeoutMs:1000 };
  const clientApi = { /* 内存服务器测试时返回固定的电影列表并拒绝其他请求。 */ async json(method:string,path:string) {
    if(method === 'GET' && path === '/api/admin/movies') return [];
    throw new Error(`unexpected ${method} ${path}`);
  }, /* 只读测试中出现上传请求即报错。 */ async upload(){ throw new Error('unexpected upload'); } };
  const server = buildServer({ config, credentialDirectory:'/tmp/credentials', client:clientApi } as any);
  const client = new Client({name:'movie-harbor-test',version:'1.0.0'});
  const [clientEnd,serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd); await client.connect(clientEnd);
  try {
    assert.deepEqual(client.getServerVersion(),{name:'movie-harbor',version:'0.1.0'});
    const instructions = client.getInstructions() ?? '';
    for (const phrase of [
      '联网', '来源', '年份', '简介', '题材', '单集名称', '海报',
      '四舍五入', '最少 1 分钟', '默认公开', '完整入库计划', '确认失效', '转换', '上传', '发布', '禁止自动发布', '单独确认发布', '下线',
    ]) assert.match(instructions, new RegExp(phrase));
    assert.doesNotMatch(instructions, /固定.*私密草稿/);
    const listed = await client.listTools();
    const names = listed.tools.map(tool=>tool.name).sort();
    assert.deepEqual(names,[
      'inspect_video','validate_poster','convert_video','delete_generated_video',
      'search_movies','search_series','get_series_structure','list_genres','create_genre','stage_poster',
      'create_movie','create_series','create_season','create_episode','update_movie_metadata','update_series_metadata','update_episode_metadata',
      'update_content_synopsis',
      'upload_movie_video','replace_movie_video','upload_episode_video','replace_episode_video','set_content_visibility','transition_content_lifecycle','set_content_poster','list_missing_videos',
      'get_system_overview',
    ].sort());
    assert.ok(listed.tools.every(tool=>tool.inputSchema&&Object.keys(tool.inputSchema).length>0));
    assert.ok(listed.tools.every(tool=>tool.outputSchema));
    for (const [name, fields] of [
      ['create_movie', ['synopsis', 'duration_minutes', 'visibility', 'confirmed']],
      ['create_series', ['synopsis', 'visibility', 'confirmed']],
      ['create_episode', ['name', 'duration_seconds', 'confirmed']],
      ['update_content_synopsis', ['content_type', 'content_id', 'version', 'synopsis']],
      ['upload_movie_video', ['confirmed']],
      ['set_content_visibility', ['content_type', 'content_id', 'version', 'visibility', 'confirmed']],
    ] as const) {
      const tool = listed.tools.find(tool => tool.name === name);
      assert.ok(tool, `${name} must be listed`);
      for (const field of fields) assert.ok(Object.hasOwn(tool.inputSchema.properties ?? {}, field), `${name} must expose ${field}`);
      if (name === 'create_movie') assert.equal(Object.hasOwn(tool.inputSchema.properties ?? {}, 'duration_seconds'), false);
    }
    // 公开范围、下线和替换现有文件会影响已发布内容或媒体，协议属性必须提示其影响。
    for (const name of ['set_content_visibility', 'transition_content_lifecycle', 'replace_movie_video', 'replace_episode_video']) {
      assert.equal(listed.tools.find(tool => tool.name === name)?.annotations?.destructiveHint, true, name);
    }
    const poster = listed.tools.find(tool => tool.name === 'set_content_poster');
    assert.ok(poster);
    assert.deepEqual(Object.keys(poster.inputSchema.properties ?? {}).sort(),
      ['confirmed', 'content_id', 'content_type', 'path', 'version']);
    assert.deepEqual(poster.inputSchema.required?.slice().sort(),
      ['confirmed', 'content_id', 'content_type', 'path', 'version']);
    assert.equal(poster.inputSchema.additionalProperties, false);
    assert.deepEqual(poster.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    assert.match(poster.description ?? '', /补传.*替换.*永久移除旧海报.*删除.*transition_content_lifecycle/);
    assert.match(instructions, /补传.*替换.*海报.*transition_content_lifecycle/);
    assert.doesNotMatch(JSON.stringify(poster.outputSchema), /"remove"|"deleted"/);
    const missingVideos = listed.tools.find(tool => tool.name === 'list_missing_videos');
    assert.ok(missingVideos);
    assert.deepEqual(Object.keys(missingVideos.inputSchema.properties ?? {}).sort(), ['content_type', 'page']);
    assert.deepEqual(missingVideos.inputSchema.required, ['content_type']);
    assert.equal(missingVideos.inputSchema.additionalProperties, false);
    assert.deepEqual(missingVideos.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    assert.match(missingVideos.description ?? '', /电影.*单集/);
    const overview = listed.tools.find(tool => tool.name === 'get_system_overview');
    assert.ok(overview);
    assert.equal(overview.inputSchema.type, 'object');
    assert.deepEqual(Object.keys(overview.inputSchema.properties ?? {}), []);
    assert.deepEqual(overview.inputSchema.required ?? [], []);
    assert.equal(overview.inputSchema.additionalProperties, false);
    assert.deepEqual(overview.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    assert.match(overview.description ?? '', /系统概览/);
    assert.deepEqual(Object.keys(overview.outputSchema?.properties ?? {}).sort(),
      ['application_version', 'backup', 'counts', 'sampled_at', 'status', 'volumes', 'warnings']);
    const lifecycle = listed.tools.find(tool => tool.name === 'transition_content_lifecycle');
    assert.ok(lifecycle);
    assert.equal(lifecycle.inputSchema.type, 'object');
    assert.equal(lifecycle.outputSchema?.type, 'object');
    const inputSchema = JSON.stringify(lifecycle.inputSchema);
    for (const phrase of ['content_type', 'content_id', 'series_id', 'season_id', 'target_status', 'confirmed']) {
      assert.match(inputSchema, new RegExp(phrase));
    }
    const result = await client.callTool({name:'search_movies',arguments:{name:'Unknown'}});
    assert.equal(result.isError,undefined);
    assert.deepEqual(result.structuredContent,{query:'Unknown',normalized_name:'unknown',matches:[],exact_match_count:0,requires_selection:false,next_actions:['create_movie']});
  } finally { await client.close(); await server.close(); }
});

// 验证 MCP 协议调用向客户端交付部分完成的机器码和中文说明。
test('server exposes the partial transition error code to MCP clients', async () => {
  const config = { baseUrl: new URL('http://localhost/'), apiKey: 'mhmcp_secret', credentialDirectory: '/tmp/credentials',
    allowedRoots: [], generatedRoot: '/tmp/generated', requestTimeoutMs: 1000 };
  const id = '11111111-1111-4111-8111-111111111111';
  const movie = { id, name: '电影', year: 2000, status: 'published', version: 3, is_private: false,
    duration_seconds: 120, poster: null, video: null };
  const path = '/api/admin/movies/' + id;
  const clientApi = {
    // 使用本地替身模拟归档成功后的第二步中断。
    async json(method: string, url: string) {
      if (method === 'GET' && url === path) return movie;
      if (method === 'POST' && url === path + '/archive') return { ...movie, status: 'archived', version: 4 };
      throw new Error('远端详细错误不得泄露');
    },
    // 生命周期工具不应请求文件上传。
    async upload() { throw new Error('非预期请求'); },
  };
  const server = buildServer({ config, credentialDirectory: '/tmp/credentials', client: clientApi } as any);
  const client = new Client({ name: 'movie-harbor-test', version: '1.0.0' });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);
  await client.connect(clientEnd);
  try {
    const result = await client.callTool({ name: 'transition_content_lifecycle', arguments: {
      content_type: 'movie', content_id: id, version: 3, target_status: 'draft', confirmed: true,
    } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.code, 'partial_transition');
    assert.equal(result.structuredContent?.last_confirmed_status, 'archived');
    assert.equal(result.structuredContent?.last_confirmed_version, 4);
    assert.equal(result.structuredContent?.commit_status, 'unknown');
    assert.match(JSON.stringify(result.content), /已确认归档/);
    assert.doesNotMatch(JSON.stringify(result), /远端详细错误/);
  } finally {
    await client.close();
    await server.close();
  }
});

// 在内存 MCP 协议调用中注入管理 API 响应，观察协议错误及真实工具发出的请求。
async function callMaintenanceTool(name: string, args: Record<string, unknown>, responses: unknown[]) {
  const config = { baseUrl: new URL('http://localhost/'), apiKey: 'mhmcp_secret', credentialDirectory: '/tmp/credentials',
    allowedRoots: [], generatedRoot: '/tmp/generated', requestTimeoutMs: 1000 };
  const calls: Array<[HttpMethod, string, unknown]> = [];
  const clientApi: MovieHarborClient = {
    // 记录工具实际尝试的每次读写，并依次提供成功或失败的 API 响应。
    async json<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
      calls.push([method, path, body]);
      assert.ok(responses.length, '发生了额外管理 API 请求');
      const found = responses.shift();
      if (found instanceof Error) throw found;
      return found as T;
    },
    // 维护场景不使用文件上传。
    async upload(): Promise<never> { throw new Error('发生了非预期上传'); },
  };
  const server = buildServer({ config, credentialDirectory: config.credentialDirectory, client: clientApi });
  const client = new Client({ name: 'movie-harbor-test', version: '1.0.0' });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);
  await client.connect(clientEnd);
  try {
    return { result: await client.callTool({ name, arguments: args }), calls };
  } finally {
    await client.close();
    await server.close();
  }
}

const maintenanceId = '11111111-1111-4111-8111-111111111111';

// 验证发布条件错误只展示可识别字段的中文说明，兼容后台的电影和剧集校验结果。
test('server localizes publishing requirements from HTTP 422 fields', async t => {
  for (const [type, path, fields, expected] of [
    ['movie', '/api/admin/movies/' + maintenanceId, ['video', 'internal_path'], /可访问且受支持的视频/],
    ['series', '/api/admin/series/' + maintenanceId, ['name', 'episodes'], /名称.*至少.*已发布.*单集.*可访问.*受支持/],
  ] as const) {
    await t.test(type, async () => {
      const { result, calls } = await callMaintenanceTool('transition_content_lifecycle', {
        content_type: type, content_id: maintenanceId, version: 3, target_status: 'published', confirmed: true,
      }, [
        { id: maintenanceId, version: 3, status: 'draft' },
        mapHttpError(422, { fields, error: 'raw /private/media/secret' }, 'mhmcp_secret'),
      ]);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), expected);
      assert.doesNotMatch(JSON.stringify(result), /internal_path|\/private\/media/);
      assert.deepEqual(calls, [['GET', path, undefined], ['POST', path + '/publish', { version: 3 }]]);
    });
  }
});

// 写入回执不可信时只按原 UUID 读取一次，快照即使符合目标也不能证明本次写入已提交。
test('maintenance uncertain writes reconcile by UUID once without repeating a write', async t => {
  const id = maintenanceId;
  const path = '/api/admin/movies/' + id;
  const current = { id, version: 3, status: 'published', is_private: false };
  for (const tool of ['set_content_visibility', 'transition_content_lifecycle']) {
    const visibility = tool === 'set_content_visibility';
    const args = { content_type: 'movie', content_id: id, version: 3, confirmed: true,
      ...(visibility ? { visibility: 'private' } : { target_status: 'draft' }) };
    const body = visibility ? { version: 3, is_private: true } : { version: 3 };
    const latest = { ...current, version: 4, status: 'archived', is_private: true };
    const write = visibility ? ['PUT', path + '/privacy', body] : ['POST', path + '/archive', body];
    for (const [label, failure, expectedCode] of [
      ['timeout', new MovieHarborClientError('timeout'), 'write_result_unknown'],
      ['network', new MovieHarborClientError('network_error'), 'write_result_unknown'],
      ['server', mapHttpError(500, { error: '/private/details' }, 'mhmcp_secret'), 'write_result_unknown'],
      ['oversize', new MovieHarborClientError('response_too_large', 200), 'write_result_unknown'],
      ['invalid JSON', new MovieHarborClientError('invalid_response', 200), 'invalid_response'],
      ['wrong UUID', { ...latest, id: '99999999-1111-4111-8111-111111111111' }, 'invalid_response'],
      ['wrong version', { ...latest, version: 12 }, 'invalid_response'],
    ] as const) {
      await t.test(tool + ' ' + label, async () => {
        const { result, calls } = await callMaintenanceTool(tool, args, [current, failure, latest]);
        assert.deepEqual(calls, [['GET', path, undefined], write, ['GET', path, undefined]]);
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent?.code, expectedCode);
        assert.equal(result.structuredContent?.current_version, 4);
        assert.equal(result.structuredContent?.[visibility ? 'current_visibility' : 'current_status'], visibility ? 'private' : 'archived');
        assert.equal(result.structuredContent?.commit_status, 'unknown');
        assert.doesNotMatch(JSON.stringify(result), /search_movies|search_series|private\/details/);
      });
    }
    const failed = await callMaintenanceTool(tool, args, [current, new MovieHarborClientError('timeout'), { ...latest, id: 'bad' }]);
    assert.equal(failed.result.structuredContent?.commit_status, 'unknown');
    assert.equal(failed.result.structuredContent?.current_version, null);
    assert.equal(failed.result.structuredContent?.last_confirmed_version, 3);
    for (const [status, code] of [[401, 'auth_required'], [403, 'forbidden'], [404,'not_found'], [409,'version_conflict'], [422,'validation_error'], [429,'rate_limited']] as const) {
      const known = await callMaintenanceTool(tool, args, [current, mapHttpError(status, { error: '/private/details' }, 'mhmcp_secret')]);
      assert.deepEqual(known.calls, [['GET', path, undefined], write]);
      assert.equal(known.result.structuredContent?.code, code);
      assert.doesNotMatch(JSON.stringify(known.result), /private\/details/);
    }
  }
});

// 明确拒绝保留机器码和已确认阶段，客户端可区分未开始写入与第二步未提交。
test('maintenance returns structured lifecycle refusals without further requests', async () => {
  const id = maintenanceId;
  const path = '/api/admin/movies/' + id;
  const args = { content_type: 'movie', content_id: id, version: 3, confirmed: true };
  const invalid = await callMaintenanceTool('transition_content_lifecycle', { ...args, target_status: 'archived' },
    [{ id, version: 3, status: 'draft' }]);
  assert.equal(invalid.result.structuredContent?.code, 'invalid_transition');
  assert.deepEqual(invalid.calls, [['GET', path, undefined]]);
  const partial = await callMaintenanceTool('transition_content_lifecycle', { ...args, target_status: 'draft' },
    [{ id, version: 3, status: 'published' }, { id, version: 4, status: 'archived' }, new MovieHarborClientError('version_conflict', 409)]);
  assert.equal(partial.result.structuredContent?.code, 'partial_transition');
  assert.equal(partial.result.structuredContent?.cause_code, 'version_conflict');
  assert.equal(partial.result.structuredContent?.commit_status, 'not_committed');
  assert.equal(partial.result.structuredContent?.last_confirmed_status, 'archived');
  assert.deepEqual(partial.calls, [['GET', path, undefined], ['POST', path + '/archive', { version: 3 }], ['POST', path + '/draft', { version: 4 }]]);
});

// 单集第二步中断时只按完整 UUID 层级回查，并分别报告已确认的归档和实际读到的状态。
test('episode partial transition records the last verified step and the readback parent version', async () => {
  const seriesId = '22222222-2222-4222-8222-222222222222';
  const seasonId = '33333333-3333-4333-8333-333333333333';
  const path = '/api/admin/series/' + seriesId;
  const target = path + '/seasons/' + seasonId + '/episodes/' + maintenanceId;
  const episode = { id: maintenanceId, season_id: seasonId, name: '单集', number: 1, status: 'published', version: 3, video: null, duration_seconds: null };
  const parent = { id: seriesId, version: 6, status: 'published', seasons: [{ id: seasonId, number: 1, episodes:[episode] }] };
  const archived = { series_version: 7, episode:{ ...episode, status:'archived', version:4 } };
  const latest = { series_version: 9, episode:{ ...episode, status:'draft', version:5 } };
  const { result, calls } = await callMaintenanceTool('transition_content_lifecycle', { content_type: 'episode', content_id: maintenanceId,
    series_id: seriesId, season_id: seasonId, target_status: 'draft', version:3, confirmed:true }, [
    parent, {series_version:6, episode}, archived, new MovieHarborClientError('network_error'), latest,
  ]);
  assert.deepEqual(calls,[['GET',path,undefined],['GET',target,undefined],['POST',target+'/archive',{version:3,series_version:6}],
    ['POST',target+'/draft',{version:4,series_version:7}],['GET',target,undefined]]);
  assert.equal(result.structuredContent?.code,'partial_transition');
  assert.equal(result.structuredContent?.commit_status,'unknown');
  assert.equal(result.structuredContent?.last_confirmed_status,'archived');
  assert.equal(result.structuredContent?.last_confirmed_version,4);
  assert.equal(result.structuredContent?.current_status,'draft');
  assert.equal(result.structuredContent?.current_series_version,9);
});

// 使用真实 SDK 调用验证未知参数名仅产生固定中文错误，路径和凭据不会出现在响应里。
test('strict maintenance schemas redact unknown input keys from real protocol errors', async () => {
  const basic = {content_id:maintenanceId,version:3,confirmed:true};
  for (const [tool,args] of [
    ['set_content_visibility',{...basic,content_type:'movie',visibility:'private'}],
    ['set_content_poster',{...basic,content_type:'series',path:'/tmp/poster.png'}],
    ...['movie','series','episode'].map(content_type => ['transition_content_lifecycle',{...basic,content_type,target_status:'draft',
      ...(content_type==='episode'?{series_id:maintenanceId,season_id:maintenanceId}:{})}] as const),
    ['list_missing_videos',{content_type:'movie'}],
  ] as const) {
    const { result, calls } = await callMaintenanceTool(tool, {...args, '/private/test-credential': true, mhmcp_test_credential:true}, []);
    assert.equal(result.isError,true);
    assert.doesNotMatch(JSON.stringify(result), /private\/test-credential|mhmcp_test_credential/);
    assert.match(JSON.stringify(result.content),/参数无效/);
    assert.deepEqual(calls,[]);
  }
});

// 无论错误出现在对象、单个字段还是分页边界，都只显示固定中文参数说明。
test('maintenance field validation uses a fixed Chinese input error', async t => {
  const movie = { content_type: 'movie', content_id: maintenanceId, version: 3, confirmed: true };
  for (const [tool, args] of [
    ['set_content_visibility', { ...movie, visibility: 'mhmcp_test_value' }],
    ['set_content_visibility', { ...movie, visibility: 'public', content_id: '/private/test_value' }],
    ['set_content_poster', { ...movie, version: 0, path: 'mhmcp_test_value' }],
    ['transition_content_lifecycle', { ...movie, target_status: 'mhmcp_test_value', confirmed: false }],
    ['list_missing_videos', { content_type: 'movie', page: 1_000_001 }],
  ] as const) {
    await t.test(tool + ' ' + Object.keys(args).join(','), async () => {
      const { result, calls } = await callMaintenanceTool(tool, args, []);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.content), /参数无效/);
      assert.doesNotMatch(JSON.stringify(result), /mhmcp_test_value|private\/test_value|Invalid option|Invalid string|Too big|Too small|Invalid input:/);
      assert.deepEqual(calls, []);
    });
  }
});

// 验证标准输入输出入口只在标准输出写协议 JSON，启动诊断不会混入协议。
test('stdio entry emits only protocol JSON on stdout and keeps startup diagnostics off stdout', async t => {
  const mcpRoot=fileURLToPath(new URL('../',import.meta.url));
  const build=await mkdtemp(join(mcpRoot,'.server-build-'));
  t.after(()=>rm(build,{recursive:true,force:true}));
  const compiler=spawn(process.execPath,[join(mcpRoot,'node_modules/typescript/bin/tsc'),'--project',join(mcpRoot,'tsconfig.json'),'--outDir',build],{cwd:mcpRoot,stdio:['ignore','pipe','pipe']});
  let compilerError=''; compiler.stderr.setEncoding('utf8'); compiler.stderr.on('data',chunk=>compilerError+=chunk);
  const compilerExit=await new Promise<number|null>((resolve,reject)=>{compiler.once('exit',resolve);compiler.once('error',reject);});
  assert.equal(compilerExit,0,compilerError);
  const entry=join(build,'server.js');
  const directory = await realpath(await mkdtemp(join(tmpdir(),'mh-server-')));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const allowed=join(directory,'allowed'); await mkdir(allowed);
  const credentials=join(directory,'credentials.env'); await writeFile(credentials,'MOVIE_HARBOR_MCP_API_KEY=mhmcp_test-key\n'); await chmod(credentials,0o600);
  const config=join(directory,'config.env');
  await writeFile(config,[
    'MOVIE_HARBOR_BASE_URL=http://127.0.0.1:65535',
    `MOVIE_HARBOR_MCP_CREDENTIALS=${credentials}`,
    `MOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON=${JSON.stringify([allowed])}`,
    `MOVIE_HARBOR_MCP_GENERATED_ROOT=${join(directory,'generated')}`,
    'MOVIE_HARBOR_MCP_REQUEST_TIMEOUT_MS=1000','',
  ].join('\n'));
  const child=spawn(process.execPath,[entry],{cwd:mcpRoot,env:{...process.env,MOVIE_HARBOR_MCP_CONFIG:config},stdio:['pipe','pipe','pipe']});
  const stdout:string[]=[]; const stderr:string[]=[];
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>stdout.push(chunk)); child.stderr.on('data',chunk=>stderr.push(chunk));
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}})+'\n');
  await new Promise<void>((resolve,reject)=>{ const timer=setTimeout(()=>reject(new Error('stdio initialize timeout')),5000); child.stdout.once('data',()=>{clearTimeout(timer);resolve();}); });
  child.stdin.end();
  const exit=await new Promise<number|null>((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  assert.equal(exit,0); assert.equal(stderr.join(''),'');
  const lines=stdout.join('').trim().split('\n').filter(Boolean);
  assert.ok(lines.length>=1); const messages=lines.map(line=>JSON.parse(line));
  assert.equal(messages[0].id,1); assert.equal(messages[0].result.serverInfo.name,'movie-harbor');

  const {MOVIE_HARBOR_MCP_CONFIG: _removed,...withoutConfig}=process.env;
  const failed=spawn(process.execPath,[entry],{cwd:mcpRoot,env:withoutConfig,stdio:['ignore','pipe','pipe']});
  let failedOut=''; let failedErr=''; failed.stdout.setEncoding('utf8'); failed.stderr.setEncoding('utf8');
  failed.stdout.on('data',chunk=>failedOut+=chunk); failed.stderr.on('data',chunk=>failedErr+=chunk);
  const failedExit=await new Promise<number|null>((resolve,reject)=>{failed.once('exit',resolve);failed.once('error',reject);});
  assert.notEqual(failedExit,0); assert.equal(failedOut,''); assert.match(failedErr,/Movie Harbor MCP 启动失败/);
  assert.doesNotMatch(failedErr,/mhmcp_|Authorization|\/Users\//);
});
