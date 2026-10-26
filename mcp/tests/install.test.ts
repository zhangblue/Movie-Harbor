import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceMcp = fileURLToPath(new URL('../', import.meta.url));
const sourceInstaller = join(sourceMcp, 'install.sh');

type Server = { name: string; transport: { type: string; command?: string; args?: string[]; env?: Record<string, string> | null } };

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
const args=process.argv.slice(2); appendFileSync(process.env.FAKE_CALLS,JSON.stringify(['codex',...args])+'\\n');
if(process.env.FAKE_CODEX_MALFORMED==='1'&&args[0]==='mcp'&&args[1]==='list'){process.stdout.write('{bad');process.exit(0);}
if(process.env.FAKE_CODEX_LIST_FAIL==='1'&&args[0]==='mcp'&&args[1]==='list'){process.stdout.write('[]');process.exit(17);}
let state=JSON.parse(readFileSync(process.env.FAKE_CODEX_STATE,'utf8'));
if(args[0]!=='mcp') process.exit(2);
if(args[1]==='list'){process.stdout.write(JSON.stringify(state));process.exit(0);}
if(args[1]==='get'){const item=state.find(x=>x.name===args[2]);if(!item)process.exit(1);process.stdout.write(JSON.stringify(item));process.exit(0);}
if(args[1]==='remove'){state=state.filter(x=>x.name!==args[2]);writeFileSync(process.env.FAKE_CODEX_STATE,JSON.stringify(state));process.exit(0);}
if(args[1]==='add'){
 const separator=args.indexOf('--'); const envIndex=args.indexOf('--env');
 const envValue=envIndex>=0?args[envIndex+1]:''; const equal=envValue.indexOf('=');
 state.push({name:args[2],enabled:true,transport:{type:'stdio',command:args[separator+1],args:args.slice(separator+2),env:equal>0?{[envValue.slice(0,equal)]:envValue.slice(equal+1)}:null}});
 writeFileSync(process.env.FAKE_CODEX_STATE,JSON.stringify(state));process.exit(0);
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
  const foreign: Server = { name: 'movie-harbor', transport: { type: 'stdio', command: 'node', args: ['/other/project/server.js'], env: { MOVIE_HARBOR_MCP_CONFIG: '/other/config.env' } } };
  await writeFile(f.statePath, JSON.stringify([foreign]));
  const result = await runInstall(f);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /其他|不属于|拒绝/);
  assert.deepEqual(await state(f), [foreign]);
  assert.equal((await calls(f)).some(call => call[1] === 'mcp' && call[2] === 'remove'), false);
});

test('fails closed on malformed codex JSON without registration mutation', async t => {
  const f = await fixture(t);
  const result = await runInstall(f, { FAKE_CODEX_MALFORMED: '1' });
  assert.notEqual(result.code, 0);
  assert.deepEqual(await state(f), []);
  assert.equal((await calls(f)).some(call => ['remove', 'add'].includes(call[2] ?? '')), false);
});

test('fails closed when codex returns valid JSON with a failing exit status', async t => {
  const f = await fixture(t);
  const result = await runInstall(f, { FAKE_CODEX_LIST_FAIL: '1' });
  assert.notEqual(result.code, 0);
  assert.deepEqual(await state(f), []);
  assert.equal((await calls(f)).some(call => ['remove', 'add'].includes(call[2] ?? '')), false);
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
