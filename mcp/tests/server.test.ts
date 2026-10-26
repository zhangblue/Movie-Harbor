import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { buildServer } from '../src/server.js';

test('server exposes identity, workflow instructions, complete atomic tool schemas and structured output in memory', async () => {
  const config = { baseUrl:new URL('http://localhost/'),apiKey:'mhmcp_secret',credentialDirectory:'/tmp/credentials',allowedRoots:[],generatedRoot:'/tmp/generated',requestTimeoutMs:1000 };
  const clientApi = { async json(method:string,path:string) {
    if(method === 'GET' && path === '/api/admin/movies') return [];
    throw new Error(`unexpected ${method} ${path}`);
  }, async upload(){ throw new Error('unexpected upload'); } };
  const server = buildServer({ config, credentialDirectory:'/tmp/credentials', client:clientApi } as any);
  const client = new Client({name:'movie-harbor-test',version:'1.0.0'});
  const [clientEnd,serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd); await client.connect(clientEnd);
  try {
    assert.deepEqual(client.getServerVersion(),{name:'movie-harbor',version:'0.1.0'});
    const instructions = client.getInstructions() ?? '';
    for(const phrase of ['海报','私密草稿','转换','入库','替换','发布','禁止自动发布','父剧集']) assert.match(instructions,new RegExp(phrase));
    const listed = await client.listTools();
    const names = listed.tools.map(tool=>tool.name).sort();
    assert.deepEqual(names,[
      'inspect_video','validate_poster','convert_video','delete_generated_video',
      'search_movies','search_series','get_series_structure','list_genres','create_genre','stage_poster',
      'create_movie','create_series','create_season','create_episode','update_movie_metadata','update_series_metadata','update_episode_metadata',
      'upload_movie_video','replace_movie_video','upload_episode_video','replace_episode_video','publish_movie','publish_episode','publish_series',
    ].sort());
    assert.ok(listed.tools.every(tool=>tool.inputSchema&&Object.keys(tool.inputSchema).length>0));
    assert.ok(listed.tools.every(tool=>tool.outputSchema));
    const result = await client.callTool({name:'search_movies',arguments:{name:'Unknown'}});
    assert.equal(result.isError,undefined);
    assert.deepEqual(result.structuredContent,{query:'Unknown',normalized_name:'unknown',matches:[],exact_match_count:0,requires_selection:false,next_actions:['create_movie']});
  } finally { await client.close(); await server.close(); }
});

test('stdio entry emits only protocol JSON on stdout and keeps startup diagnostics off stdout', async t => {
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
  const child=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:new URL('../',import.meta.url),env:{...process.env,MOVIE_HARBOR_MCP_CONFIG:config},stdio:['pipe','pipe','pipe']});
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
  const failed=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:new URL('../',import.meta.url),env:withoutConfig,stdio:['ignore','pipe','pipe']});
  let failedOut=''; let failedErr=''; failed.stdout.setEncoding('utf8'); failed.stderr.setEncoding('utf8');
  failed.stdout.on('data',chunk=>failedOut+=chunk); failed.stderr.on('data',chunk=>failedErr+=chunk);
  const failedExit=await new Promise<number|null>((resolve,reject)=>{failed.once('exit',resolve);failed.once('error',reject);});
  assert.notEqual(failedExit,0); assert.equal(failedOut,''); assert.match(failedErr,/Movie Harbor MCP 启动失败/);
  assert.doesNotMatch(failedErr,/mhmcp_|Authorization|\/Users\//);
});
