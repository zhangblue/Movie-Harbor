import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceMcp = fileURLToPath(new URL('../', import.meta.url));
const sourceInstaller = join(sourceMcp, 'install.sh');

type Server = {
  name: string;
  enabled?: boolean;
  disabled_reason?: string | null;
  startup_timeout_sec?: number | null;
  tool_timeout_sec?: number | null;
  enabled_tools?: string[] | null;
  disabled_tools?: string[] | null;
  transport: { type: string; command?: string; args?: string[]; env?: Record<string, string> | null; env_vars?: string[]; cwd?: string | null };
};

async function executable(path: string, source: string) {
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'movie harbor install ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'Movie Harbor repo');
  const mcp = join(repo, 'mcp');
  const home = join(root, 'Home Folder');
  const allowed = join(root, 'Downloads Folder');
  const fakeBin = join(root, 'fake bin');
  const statePath = join(root, 'codex-state.json');
  const callsPath = join(root, 'calls.jsonl');
  await mkdir(join(mcp, 'src'), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(allowed, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await copyFile(sourceInstaller, join(mcp, 'install.sh'));
  await copyFile(join(sourceMcp, 'package.json'), join(mcp, 'package.json'));
  await copyFile(join(sourceMcp, 'package-lock.json'), join(mcp, 'package-lock.json'));
  await copyFile(join(sourceMcp, 'src/server.ts'), join(mcp, 'src/server.ts'));
  await copyFile(join(sourceMcp, '../.env.example'), join(repo, '.env.example'));
  await copyFile(join(sourceMcp, '../docker-compose.yml'), join(repo, 'docker-compose.yml'));
  await writeFile(statePath, '[]');
  await writeFile(callsPath, '');
  await symlink(process.execPath, join(fakeBin, 'node'));
  await executable(join(fakeBin, 'npm'), `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args=process.argv.slice(2); appendFileSync(process.env.FAKE_CALLS,JSON.stringify(['npm',...args])+'\\n');
if(process.env.FAKE_NPM_FAIL_BUILD==='1'&&args[0]==='run'&&args[1]==='build') process.exit(23);
const prefix=args.at(-1); if(args[0]==='run'&&args[1]==='build'&&prefix){mkdirSync(join(prefix,'dist'),{recursive:true});writeFileSync(join(prefix,'dist/server.js'),'// built\\n');}
`);
  await executable(join(fakeBin, 'codex'), `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const args=process.argv.slice(2);
const loggedArgs=args.map((arg,index)=>args[index-1]==='--env'?arg.slice(0,arg.indexOf('=')+1)+'<redacted>':arg);
appendFileSync(process.env.FAKE_CALLS,JSON.stringify(['codex',...loggedArgs])+'\\n');
if(process.env.FAKE_CODEX_MALFORMED==='1'&&args[0]==='mcp'&&args[1]==='list'){process.stdout.write('{bad');process.exit(0);}
if(process.env.FAKE_CODEX_LIST_FAIL==='1'&&args[0]==='mcp'&&args[1]==='list'){process.stdout.write('[]');process.exit(17);}
if(process.env.FAKE_CODEX_GET_FAIL==='1'&&args[0]==='mcp'&&args[1]==='get'){process.stdout.write('{}');process.exit(19);}
let state=JSON.parse(readFileSync(process.env.FAKE_CODEX_STATE,'utf8'));
const rendered=item=>({...item,enabled:item.enabled??true,disabled_reason:item.disabled_reason??null,transport:{...item.transport,env:item.transport.env??{},env_vars:item.transport.env_vars??[],cwd:item.transport.cwd??null},startup_timeout_sec:item.startup_timeout_sec??null,tool_timeout_sec:item.tool_timeout_sec??null,enabled_tools:item.enabled_tools??null,disabled_tools:item.disabled_tools??null,auth_status:'unsupported'});
if(args[0]!=='mcp') process.exit(2);
if(args[1]==='list'){writeFileSync(1,JSON.stringify(state.map(rendered)));process.exit(0);}
if(args[1]==='get'){
 const item=state.find(x=>x.name===args[2]);if(!item)process.exit(1);
 const getCount=readFileSync(process.env.FAKE_CALLS,'utf8').trim().split('\\n').filter(line=>JSON.parse(line)[1]==='mcp'&&JSON.parse(line)[2]==='get').length;
 if(process.env.FAKE_CODEX_VERIFY_FAIL_ONCE==='1'&&getCount===2){process.stdout.write(JSON.stringify(rendered({...item,transport:{...item.transport,args:['/wrong/server.js']}})));process.exit(0);}
 if(process.env.FAKE_CODEX_RESTORE_VERIFY_CWD==='1'&&getCount===4){process.stdout.write(JSON.stringify(rendered({...item,transport:{...item.transport,cwd:'/unexpected/cwd'}})));process.exit(0);}
 writeFileSync(1,JSON.stringify(rendered(item)));process.exit(0);
}
if(args[1]==='remove'){
 const removeCount=readFileSync(process.env.FAKE_CALLS,'utf8').trim().split('\\n').filter(line=>JSON.parse(line)[1]==='mcp'&&JSON.parse(line)[2]==='remove').length;
 if((process.env.FAKE_CODEX_FAIL_REMOVE_AT??'').split(',').includes(String(removeCount)))process.exit(27);
 state=state.filter(x=>x.name!==args[2]);writeFileSync(process.env.FAKE_CODEX_STATE,JSON.stringify(state));
 if((process.env.FAKE_CODEX_FAIL_REMOVE_AFTER_AT??'').split(',').includes(String(removeCount)))process.exit(28);
 process.exit(0);
}
if(args[1]==='add'){
 const separator=args.indexOf('--'); const env={};
 for(let index=0;index<separator;index++)if(args[index]==='--env'){const envValue=args[index+1]??'',equal=envValue.indexOf('=');if(equal>0)env[envValue.slice(0,equal)]=envValue.slice(equal+1);}
 const addCount=readFileSync(process.env.FAKE_CALLS,'utf8').trim().split('\\n').filter(line=>JSON.parse(line)[1]==='mcp'&&JSON.parse(line)[2]==='add').length;
 state.push({name:args[2],enabled:true,transport:{type:'stdio',command:args[separator+1],args:args.slice(separator+2),env}});
 writeFileSync(process.env.FAKE_CODEX_STATE,JSON.stringify(state));
 if((process.env.FAKE_CODEX_FAIL_ADD_AT??'').split(',').includes(String(addCount)))process.exit(29);
 process.exit(0);
}
process.exit(2);
`);
  for (const name of ['ffmpeg', 'ffprobe']) await executable(join(fakeBin, name), '#!/bin/sh\nexit 0\n');
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    XDG_CONFIG_HOME: join(home, 'Config Root'),
    PATH: `${fakeBin}:/usr/bin:/bin`,
    FAKE_CODEX_STATE: statePath,
    FAKE_CALLS: callsPath,
    MOVIE_HARBOR_MCP_BASE_URL: 'http://127.0.0.1:8080/',
    MOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON: JSON.stringify([allowed]),
    MOVIE_HARBOR_MCP_REQUEST_TIMEOUT_MS: '1800000',
  };
  return { root, repo, mcp, home, allowed, fakeBin, statePath, callsPath, env };
}

async function runInstall(f: Awaited<ReturnType<typeof fixture>>, overrides: NodeJS.ProcessEnv = {}) {
  const child = spawn('/bin/sh', [join(f.mcp, 'install.sh')], { cwd: f.repo, env: { ...f.env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  return { code, stdout, stderr };
}

async function calls(f: Awaited<ReturnType<typeof fixture>>) {
  return (await readFile(f.callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
}

async function state(f: Awaited<ReturnType<typeof fixture>>): Promise<Server[]> {
  return JSON.parse(await readFile(f.statePath, 'utf8'));
}

function installedPaths(f: Awaited<ReturnType<typeof fixture>>) {
  const directory = join(f.home, 'Config Root', 'movie-harbor-mcp');
  return { directory, config: join(directory, 'config.env'), credentials: join(directory, 'credentials.env') };
}

async function writeExistingConfig(f: Awaited<ReturnType<typeof fixture>>, configText = 'ORIGINAL_CONFIG=keep\n') {
  const paths = installedPaths(f);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  await writeFile(paths.credentials, 'MOVIE_HARBOR_MCP_API_KEY=mhmcp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n', { mode: 0o600 });
  await chmod(paths.credentials, 0o600);
  await writeFile(paths.config, configText, { mode: 0o600 });
  await chmod(paths.config, 0o600);
  return paths;
}

test('first and repeated install keep one owned global server and private reusable credentials', async t => {
  const f = await fixture(t);
  const first = await runInstall(f);
  assert.equal(first.code, 0, first.stderr);
  const configDir = join(f.home, 'Config Root', 'movie-harbor-mcp');
  const config = join(configDir, 'config.env');
  const credentials = join(configDir, 'credentials.env');
  assert.equal((await lstat(configDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(config)).mode & 0o777, 0o600);
  assert.equal((await lstat(credentials)).mode & 0o777, 0o600);
  const secret = (await readFile(credentials, 'utf8')).trim().split('=')[1]!;
  assert.match(secret, /^mhmcp_[a-f0-9]{64}$/);
  assert.doesNotMatch(first.stdout + first.stderr + JSON.stringify(await calls(f)), new RegExp(secret));
  assert.match(first.stdout, new RegExp(createHash('sha256').update(secret).digest('hex')));
  const configText = await readFile(config, 'utf8');
  assert.match(configText, new RegExp(`MOVIE_HARBOR_MCP_CREDENTIALS=${credentials.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(configText, /MOVIE_HARBOR_BASE_URL=http:\/\/127\.0\.0\.1:8080\//);
  assert.doesNotMatch(configText, /mhmcp_/);
  const installed = await state(f);
  assert.equal(installed.length, 1);
  assert.deepEqual(installed[0]?.transport, { type: 'stdio', command: 'node', args: [join(f.mcp, 'dist/server.js')], env: { MOVIE_HARBOR_MCP_CONFIG: config } });

  await writeFile(f.callsPath, '');
  const second = await runInstall(f);
  assert.equal(second.code, 0, second.stderr);
  assert.equal((await state(f)).filter(server => server.name === 'movie-harbor').length, 1);
  assert.equal((await readFile(credentials, 'utf8')).trim().split('=')[1], secret);
  const repeatedCalls = await calls(f);
  assert.ok(repeatedCalls.some(call => call.slice(0, 4).join(' ') === 'codex mcp get movie-harbor'));
  assert.ok(repeatedCalls.some(call => call.slice(0, 4).join(' ') === 'codex mcp remove movie-harbor'));
});

test('fails before registration when each required command is missing', async t => {
  for (const missing of ['node', 'npm', 'codex', 'ffmpeg', 'ffprobe']) {
    const f = await fixture(t);
    await rm(join(f.fakeBin, missing));
    const result = await runInstall(f);
    assert.notEqual(result.code, 0, `${missing} unexpectedly succeeded`);
    assert.match(result.stderr, new RegExp(missing, 'i'));
    assert.deepEqual(await state(f), []);
  }
});

test('build failure leaves an existing owned registration untouched and precedes codex mutation', async t => {
  const f = await fixture(t);
  const config = join(f.home, 'Config Root', 'movie-harbor-mcp', 'config.env');
  const original: Server = { name: 'movie-harbor', transport: { type: 'stdio', command: 'node', args: [join(f.mcp, 'dist/server.js')], env: { MOVIE_HARBOR_MCP_CONFIG: config } } };
  await writeFile(f.statePath, JSON.stringify([original]));
  const result = await runInstall(f, { FAKE_NPM_FAIL_BUILD: '1' });
  assert.notEqual(result.code, 0);
  assert.deepEqual(await state(f), [original]);
  const recorded = await calls(f);
  assert.ok(recorded.some(call => call[0] === 'npm' && call[1] === 'ci'));
  assert.ok(recorded.some(call => call[0] === 'npm' && call[1] === 'run' && call[2] === 'build'));
  assert.equal(recorded.some(call => call[0] === 'codex'), false);
});

test('refuses a same-name server owned by another project without removing it', async t => {
  const f = await fixture(t);
  const paths = await writeExistingConfig(f);
  const beforeConfig = await readFile(paths.config, 'utf8');
  const beforeCredentials = await readFile(paths.credentials, 'utf8');
  const foreign: Server = { name: 'movie-harbor', transport: { type: 'stdio', command: 'node', args: ['/other/project/server.js'], env: { MOVIE_HARBOR_MCP_CONFIG: '/other/config.env' } } };
  await writeFile(f.statePath, JSON.stringify([foreign]));
  const result = await runInstall(f);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /其他|不属于|拒绝/);
  assert.deepEqual(await state(f), [foreign]);
  assert.equal((await calls(f)).some(call => call[1] === 'mcp' && call[2] === 'remove'), false);
  assert.equal(await readFile(paths.config, 'utf8'), beforeConfig);
  assert.equal(await readFile(paths.credentials, 'utf8'), beforeCredentials);
  assert.equal((await lstat(paths.config)).mode & 0o777, 0o600);
  assert.equal((await lstat(paths.credentials)).mode & 0o777, 0o600);
});

test('fails closed on malformed codex JSON without registration mutation', async t => {
  const f = await fixture(t);
  const result = await runInstall(f, { FAKE_CODEX_MALFORMED: '1' });
  assert.notEqual(result.code, 0);
  assert.deepEqual(await state(f), []);
  assert.equal((await calls(f)).some(call => ['remove', 'add'].includes(call[2] ?? '')), false);
  await assert.rejects(lstat(installedPaths(f).directory), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('fails closed when codex returns valid JSON with a failing exit status', async t => {
  const f = await fixture(t);
  const result = await runInstall(f, { FAKE_CODEX_LIST_FAIL: '1' });
  assert.notEqual(result.code, 0);
  assert.deepEqual(await state(f), []);
  assert.equal((await calls(f)).some(call => ['remove', 'add'].includes(call[2] ?? '')), false);
});

test('get failure leaves existing configuration bytes and modes unchanged', async t => {
  const f = await fixture(t);
  const paths = await writeExistingConfig(f);
  const owned: Server = { name: 'movie-harbor', transport: { type: 'stdio', command: 'node', args: [join(f.mcp, 'dist/server.js')], env: { MOVIE_HARBOR_MCP_CONFIG: paths.config } } };
  await writeFile(f.statePath, JSON.stringify([owned]));
  const beforeConfig = await readFile(paths.config, 'utf8');
  const beforeCredentials = await readFile(paths.credentials, 'utf8');
  const result = await runInstall(f, { FAKE_CODEX_GET_FAIL: '1' });
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(paths.config, 'utf8'), beforeConfig);
  assert.equal(await readFile(paths.credentials, 'utf8'), beforeCredentials);
  assert.equal((await lstat(paths.config)).mode & 0o777, 0o600);
  assert.equal((await lstat(paths.credentials)).mode & 0o777, 0o600);
  assert.deepEqual(await state(f), [owned]);
});

test('atomic config rewrite failure preserves the old file and registration', async t => {
  const f = await fixture(t);
  const first = await runInstall(f);
  assert.equal(first.code, 0, first.stderr);
  const paths = installedPaths(f);
  const oldConfig = 'ORIGINAL_CONFIG=must-survive\n';
  await writeFile(paths.config, oldConfig, { mode: 0o600 });
  await chmod(paths.config, 0o600);
  const hook = join(f.root, 'fail-config-rename.cjs');
  await writeFile(hook, `const fs=require('node:fs'),path=require('node:path');const rename=fs.renameSync;fs.renameSync=(from,to)=>{const name=path.basename(String(from));if(name.startsWith('.config.env.')&&name.endsWith('.tmp'))throw Object.assign(new Error('controlled rename failure'),{code:'EIO'});return rename(from,to);};\n`);
  const beforeState = await state(f);
  const result = await runInstall(f, { NODE_OPTIONS: `--require=${JSON.stringify(hook)}` });
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(paths.config, 'utf8'), oldConfig);
  assert.deepEqual(await state(f), beforeState);
  assert.equal((await calls(f)).filter(call => call[1] === 'mcp' && call[2] === 'remove').length, 0);
  assert.deepEqual((await readdir(paths.directory)).filter(name => name.startsWith('.config.env.') && name.endsWith('.tmp')), []);
});

test('directory fsync failure after config rename restores old bytes mode and registration', async t => {
  const f = await fixture(t);
  const first = await runInstall(f);
  assert.equal(first.code, 0, first.stderr);
  const paths = installedPaths(f);
  const oldConfig = 'OLD_CONFIG=after-rename\n';
  await writeFile(paths.config, oldConfig, { mode: 0o600 });
  await chmod(paths.config, 0o600);
  const marker = join(f.root, 'directory-fsync-failed-once');
  const hook = join(f.root, 'fail-directory-fsync-after-rename.cjs');
  await writeFile(hook, `const fs=require('node:fs'),path=require('node:path');const rename=fs.renameSync,open=fs.openSync,fsync=fs.fsyncSync;let renamed=false,directoryFd;fs.renameSync=(from,to)=>{const result=rename(from,to);if(path.basename(String(to))==='config.env')renamed=true;return result;};fs.openSync=(target,flags,...rest)=>{const fd=open(target,flags,...rest);if(renamed&&String(target)===${JSON.stringify(paths.directory)})directoryFd=fd;return fd;};fs.fsyncSync=fd=>{if(fd===directoryFd&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'failed');throw Object.assign(new Error('controlled directory fsync failure'),{code:'EIO'});}return fsync(fd);};\n`);
  const beforeState = await state(f);
  const result = await runInstall(f, { NODE_OPTIONS: `--require=${JSON.stringify(hook)}`, MOVIE_HARBOR_MCP_BASE_URL: 'http://new-target.example/' });
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(paths.config, 'utf8'), oldConfig);
  assert.equal((await lstat(paths.config)).mode & 0o777, 0o600);
  assert.deepEqual(await state(f), beforeState);
  assert.deepEqual((await readdir(paths.directory)).filter(name => name.endsWith('.restore.tmp')), []);
});

test('custom generated root uses a canonical real parent and rejects missing or symlink parents', async t => {
  const success = await fixture(t);
  const parent = join(success.root, 'Generated Parent');
  await mkdir(parent);
  const result = await runInstall(success, { MOVIE_HARBOR_MCP_GENERATED_ROOT: join(parent, 'videos') });
  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(installedPaths(success).config, 'utf8'), new RegExp(`MOVIE_HARBOR_MCP_GENERATED_ROOT=${join(parent, 'videos').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  const missing = await fixture(t);
  const missingResult = await runInstall(missing, { MOVIE_HARBOR_MCP_GENERATED_ROOT: join(missing.root, 'missing', 'videos') });
  assert.notEqual(missingResult.code, 0);
  assert.deepEqual(await state(missing), []);

  const linked = await fixture(t);
  const realParent = join(linked.root, 'real-generated-parent');
  const linkedParent = join(linked.root, 'linked-generated-parent');
  await mkdir(realParent);
  await symlink(realParent, linkedParent);
  const linkedResult = await runInstall(linked, { MOVIE_HARBOR_MCP_GENERATED_ROOT: join(linkedParent, 'videos') });
  assert.notEqual(linkedResult.code, 0);
  assert.deepEqual(await state(linked), []);
});

test('rejects symlinked credential or config files', async t => {
  for (const name of ['credentials.env', 'config.env']) {
    const f = await fixture(t);
    const directory = join(f.home, 'Config Root', 'movie-harbor-mcp');
    await mkdir(directory, { recursive: true });
    const target = join(f.root, `target-${name}`);
    await writeFile(target, name === 'credentials.env' ? 'MOVIE_HARBOR_MCP_API_KEY=mhmcp_existing\n' : 'SAFE=1\n');
    await symlink(target, join(directory, name));
    const result = await runInstall(f);
    assert.notEqual(result.code, 0, `${name} symlink unexpectedly accepted`);
    assert.deepEqual(await state(f), []);
  }
});

test('remove success followed by add failure removes the partial entry and restores the exact owned registration', async t => {
  const f = await fixture(t);
  const paths = await writeExistingConfig(f);
  const original: Server = {
    name: 'movie-harbor',
    enabled: true,
    transport: { type: 'stdio', command: 'node', args: [join(f.mcp, 'dist/server.js')], env: { MOVIE_HARBOR_MCP_CONFIG: paths.config } },
  };
  await writeFile(f.statePath, JSON.stringify([original]));
  const beforeConfig = await readFile(paths.config);

  const result = await runInstall(f, { FAKE_CODEX_FAIL_ADD_AT: '1', MOVIE_HARBOR_MCP_BASE_URL: 'http://new-target.example/' });

  assert.notEqual(result.code, 0);
  assert.deepEqual(await state(f), [original]);
  assert.match(result.stderr, /恢复|回滚/);
  assert.doesNotMatch(result.stdout, /已全局注册/);
  const recorded = await calls(f);
  assert.equal(recorded.filter(call => call[1] === 'mcp' && call[2] === 'remove').length, 2);
  assert.equal(recorded.filter(call => call[1] === 'mcp' && call[2] === 'add').length, 2);
  assert.deepEqual(await readFile(paths.config), beforeConfig);
  assert.equal((await lstat(paths.config)).mode & 0o777, 0o600);
});

test('successful add with failed verification removes the new entry and restores the exact owned registration', async t => {
  const f = await fixture(t);
  const paths = await writeExistingConfig(f);
  const original: Server = {
    name: 'movie-harbor',
    enabled: true,
    transport: { type: 'stdio', command: 'node', args: [join(f.mcp, 'dist/server.js')], env: { MOVIE_HARBOR_MCP_CONFIG: paths.config } },
  };
  await writeFile(f.statePath, JSON.stringify([original]));
  const beforeConfig = await readFile(paths.config);

  const result = await runInstall(f, { FAKE_CODEX_VERIFY_FAIL_ONCE: '1', MOVIE_HARBOR_MCP_BASE_URL: 'http://new-target.example/' });

  assert.notEqual(result.code, 0);
  assert.deepEqual(await state(f), [original]);
  assert.match(result.stderr, /恢复|回滚/);
  assert.doesNotMatch(result.stdout, /已全局注册/);
  const recorded = await calls(f);
  assert.equal(recorded.filter(call => call[1] === 'mcp' && call[2] === 'remove').length, 2);
  assert.equal(recorded.filter(call => call[1] === 'mcp' && call[2] === 'add').length, 2);
  assert.equal(recorded.filter(call => call[1] === 'mcp' && call[2] === 'get').length, 4);
  assert.deepEqual(await readFile(paths.config), beforeConfig);
  assert.equal((await lstat(paths.config)).mode & 0o777, 0o600);
});

test('rollback failure is reported as a serious error and never claims installation success', async t => {
  const f = await fixture(t);
  const paths = await writeExistingConfig(f);
  const original: Server = {
    name: 'movie-harbor',
    enabled: true,
    transport: { type: 'stdio', command: 'node', args: [join(f.mcp, 'dist/server.js')], env: { MOVIE_HARBOR_MCP_CONFIG: paths.config } },
  };
  await writeFile(f.statePath, JSON.stringify([original]));
  const beforeConfig = await readFile(paths.config);

  const result = await runInstall(f, { FAKE_CODEX_VERIFY_FAIL_ONCE: '1', FAKE_CODEX_FAIL_ADD_AT: '2', MOVIE_HARBOR_MCP_BASE_URL: 'http://new-target.example/' });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /严重.*回滚失败|回滚失败.*严重/);
  assert.doesNotMatch(result.stdout, /已全局注册/);
  assert.deepEqual(await readFile(paths.config), beforeConfig);
  assert.equal((await lstat(paths.config)).mode & 0o777, 0o600);
});

test('remove failure restores the old config before leaving the owned registration untouched', async t => {
  const f = await fixture(t);
  const paths = await writeExistingConfig(f, 'OLD_CONFIG=A\n');
  const original: Server = { name: 'movie-harbor', enabled: true, transport: { type: 'stdio', command: 'node', args: [join(f.mcp, 'dist/server.js')], env: { MOVIE_HARBOR_MCP_CONFIG: paths.config } } };
  await writeFile(f.statePath, JSON.stringify([original]));
  const beforeConfig = await readFile(paths.config);

  const result = await runInstall(f, { FAKE_CODEX_FAIL_REMOVE_AT: '1', MOVIE_HARBOR_MCP_BASE_URL: 'http://new-target.example/' });

  assert.notEqual(result.code, 0);
  assert.deepEqual(await state(f), [original]);
  assert.deepEqual(await readFile(paths.config), beforeConfig);
  assert.equal((await lstat(paths.config)).mode & 0o777, 0o600);
});

test('remove that deletes state before failing restores both old config and registration', async t => {
  const f = await fixture(t);
  const paths = await writeExistingConfig(f, 'OLD_CONFIG=remove-after\n');
  const original: Server = { name: 'movie-harbor', enabled: true, transport: { type: 'stdio', command: 'node', args: [join(f.mcp, 'dist/server.js')], env: { MOVIE_HARBOR_MCP_CONFIG: paths.config } } };
  await writeFile(f.statePath, JSON.stringify([original]));
  const beforeConfig = await readFile(paths.config);
  const result = await runInstall(f, { FAKE_CODEX_FAIL_REMOVE_AFTER_AT: '1', MOVIE_HARBOR_MCP_BASE_URL: 'http://new-target.example/' });
  assert.notEqual(result.code, 0);
  assert.deepEqual(await state(f), [original]);
  assert.deepEqual(await readFile(paths.config), beforeConfig);
  assert.equal((await lstat(paths.config)).mode & 0o777, 0o600);
});

test('failed first install removes a partially-created registration', async t => {
  const f = await fixture(t);
  const paths = await writeExistingConfig(f);
  const credentialsBefore = await readFile(paths.credentials);
  await rm(paths.config);

  const result = await runInstall(f, { FAKE_CODEX_FAIL_ADD_AT: '1', MOVIE_HARBOR_MCP_BASE_URL: 'http://new-target.example/' });

  assert.notEqual(result.code, 0);
  assert.deepEqual(await state(f), []);
  assert.match(result.stderr, /注册失败/);
  assert.doesNotMatch(result.stdout, /已全局注册/);
  assert.equal((await calls(f)).filter(call => call[1] === 'mcp' && call[2] === 'remove').length, 1);
  await assert.rejects(lstat(paths.config), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  assert.deepEqual(await readFile(paths.credentials), credentialsBefore);
});

test('fails closed before removal when an owned registration has fields add cannot restore', async t => {
  for (const extra of [
    { transport: { cwd: '/private/working-directory' } },
    { transport: { env_vars: ['FORWARDED_SECRET'] } },
    { topLevel: { disabled_reason: 'disabled by policy' } },
    { topLevel: { startup_timeout_sec: 12 } },
    { topLevel: { enabled_tools: ['only_this_tool'] } },
  ]) {
    const f = await fixture(t);
    const paths = await writeExistingConfig(f);
    const original: Server = {
      name: 'movie-harbor',
      enabled: true,
      ...extra.topLevel,
      transport: {
        type: 'stdio',
        command: 'node',
        args: [join(f.mcp, 'dist/server.js')],
        env: { MOVIE_HARBOR_MCP_CONFIG: paths.config },
        ...extra.transport,
      },
    };
    await writeFile(f.statePath, JSON.stringify([original]));

    const result = await runInstall(f);

    assert.notEqual(result.code, 0);
    assert.deepEqual(await state(f), [original]);
    assert.equal((await calls(f)).some(call => call[1] === 'mcp' && call[2] === 'remove'), false);
  }
});

test('extra literal env fails closed before files or registration are changed and never leaks its value', async t => {
  const f = await fixture(t);
  const paths = await writeExistingConfig(f);
  const oldSecret = 'old_mcp_secret_must_not_leak';
  const original: Server = {
    name: 'movie-harbor',
    enabled: true,
    transport: {
      type: 'stdio',
      command: 'node',
      args: [join(f.mcp, 'dist/server.js')],
      env: { MOVIE_HARBOR_MCP_CONFIG: paths.config, OTHER_MCP_SECRET: oldSecret },
    },
  };
  await writeFile(f.statePath, JSON.stringify([original]));

  const beforeConfig = await readFile(paths.config);
  const result = await runInstall(f, { MOVIE_HARBOR_MCP_BASE_URL: 'http://new-target.example/' });

  assert.notEqual(result.code, 0);
  assert.deepEqual(await state(f), [original]);
  assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(await calls(f)), new RegExp(oldSecret));
  assert.equal((await calls(f)).some(call => call[1] === 'mcp' && ['remove', 'add'].includes(call[2] ?? '')), false);
  assert.deepEqual(await readFile(paths.config), beforeConfig);
  assert.equal((await lstat(paths.config)).mode & 0o777, 0o600);
});

test('rollback verification rejects non-default fields and reports a serious failure', async t => {
  const f = await fixture(t);
  const paths = await writeExistingConfig(f);
  const original: Server = { name: 'movie-harbor', enabled: true, transport: { type: 'stdio', command: 'node', args: [join(f.mcp, 'dist/server.js')], env: { MOVIE_HARBOR_MCP_CONFIG: paths.config } } };
  await writeFile(f.statePath, JSON.stringify([original]));

  const result = await runInstall(f, { FAKE_CODEX_VERIFY_FAIL_ONCE: '1', FAKE_CODEX_RESTORE_VERIFY_CWD: '1' });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /严重.*回滚后的旧 MCP 注册验证失败/);
  assert.doesNotMatch(result.stdout, /已全局注册/);
});
