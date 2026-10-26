import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadConfig } from '../src/config.js';

async function fixture(t: TestContext, mode = 0o600, overrides: Record<string, string> = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'mh-config-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentials = join(dir, 'credentials.env');
  await writeFile(credentials, '# private\nMOVIE_HARBOR_MCP_API_KEY=mhmcp_test$literal\n');
  await chmod(credentials, mode);
  const values = {
    MOVIE_HARBOR_BASE_URL: 'http://127.0.0.1:8080',
    MOVIE_HARBOR_MCP_CREDENTIALS: credentials,
    MOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON: JSON.stringify([dir]),
    ...overrides,
  };
  const configPath = join(dir, 'config.env');
  await writeFile(configPath, '# local config\n\n' + Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n'));
  return { dir, credentials, configPath, env: { MOVIE_HARBOR_MCP_CONFIG: configPath } };
}

// Catches missing parsing, secret shell expansion, and absent defaults.
test('loads private credentials and canonical paths with defaults', async (t) => {
  const f = await fixture(t);
  const config = await loadConfig(f.env);
  assert.equal(config.baseUrl.origin, 'http://127.0.0.1:8080');
  assert.equal(config.baseUrl.href, 'http://127.0.0.1:8080/');
  assert.equal(config.apiKey, 'mhmcp_test$literal');
  assert.deepEqual(config.allowedRoots, [f.dir]);
  assert.equal(config.generatedRoot, join(f.dir, 'generated'));
  assert.equal(config.requestTimeoutMs, 1800000);
});

test('rejects credential files with permissions other than 0600', async (t) => {
  await assert.rejects(loadConfig((await fixture(t, 0o644)).env), /0600/);
});

test('rejects symlink config and credentials', async (t) => {
  for (const target of ['configPath', 'credentials'] as const) {
    const f = await fixture(t);
    const link = join(f.dir, 'link');
    await symlink(f[target], link);
    if (target === 'credentials') {
      await writeFile(f.configPath, `MOVIE_HARBOR_BASE_URL=http://localhost\nMOVIE_HARBOR_MCP_CREDENTIALS=${link}\nMOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON=${JSON.stringify([f.dir])}`);
    }
    await assert.rejects(loadConfig(target === 'configPath' ? { MOVIE_HARBOR_MCP_CONFIG: link } : f.env), /普通文件|符号链接/);
  }
});

test('rejects unsafe base URLs without exposing credentials', async (t) => {
  for (const url of ['file:///tmp', 'https://user:secret@example.com', 'https://example.com/api', 'https://example.com/?x=1', 'https://example.com/#frag', 'https://example.com/?', 'https://example.com/#']) {
    const f = await fixture(t, 0o600, { MOVIE_HARBOR_BASE_URL: url });
    await assert.rejects(loadConfig(f.env), (err: Error) => /BASE_URL/.test(err.message) && !err.message.includes('secret'));
  }
});

test('validates absolute paths, roots, positive safe timeout and API key', async (t) => {
  await assert.rejects(loadConfig({}), /MOVIE_HARBOR_MCP_CONFIG/);
  await assert.rejects(loadConfig({ MOVIE_HARBOR_MCP_CONFIG: 'config.env' }), /绝对路径/);
  for (const overrides of [
    { MOVIE_HARBOR_MCP_CREDENTIALS: 'credentials.env' },
    { MOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON: '["relative"]' },
    { MOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON: 'invalid' },
    { MOVIE_HARBOR_MCP_GENERATED_ROOT: 'relative' },
    ...['0', '-1', '1.5', '9007199254740992', 'NaN'].map(value => ({ MOVIE_HARBOR_MCP_REQUEST_TIMEOUT_MS: value })),
  ]) {
    const f = await fixture(t, 0o600, overrides);
    await assert.rejects(loadConfig(f.env));
  }
  const f = await fixture(t);
  await writeFile(f.credentials, 'MOVIE_HARBOR_MCP_API_KEY=mhmcp_');
  await assert.rejects(loadConfig(f.env), /API_KEY/);
});

test('canonicalizes symlink roots and generated parent and accepts explicit timeout', async (t) => {
  const f = await fixture(t);
  const alias = join(f.dir, 'alias');
  await symlink(f.dir, alias);
  await writeFile(f.configPath, `MOVIE_HARBOR_BASE_URL=https://example.com/\nMOVIE_HARBOR_MCP_CREDENTIALS=${f.credentials}\nMOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON=${JSON.stringify([alias])}\nMOVIE_HARBOR_MCP_GENERATED_ROOT=${join(alias, 'output')}\nMOVIE_HARBOR_MCP_REQUEST_TIMEOUT_MS=1000`);
  const config = await loadConfig(f.env);
  assert.deepEqual(config.allowedRoots, [f.dir]);
  assert.equal(config.generatedRoot, join(f.dir, 'output'));
  assert.equal(config.requestTimeoutMs, 1000);
  await mkdir(join(f.dir, 'output'));
  assert.equal((await loadConfig(f.env)).generatedRoot, join(f.dir, 'output'));
});

// Running the loader in a child bounds the regression even if FIFO open blocks forever.
for (const target of ['configPath', 'credentials'] as const) {
  test(`rejects FIFO ${target} without waiting for a writer`, async (t) => {
    const f = await fixture(t);
    await rm(f[target]);
    await promisify(execFile)('mkfifo', ['-m', '600', f[target]]);
    const source = new URL('../src/config.ts', import.meta.url).href;
    await promisify(execFile)(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval',
      `import assert from 'node:assert/strict';
       import { loadConfig } from ${JSON.stringify(source)};
       await assert.rejects(loadConfig(JSON.parse(process.argv[1])), /普通文件/);`,
      JSON.stringify(f.env),
    ], { timeout: 5000, killSignal: 'SIGKILL' });
  });
}
