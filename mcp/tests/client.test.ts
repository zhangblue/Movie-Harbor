import assert from 'node:assert/strict';
import { createReadStream, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { McpConfig } from '../src/config.js';
import { inspectAllowedFile } from '../src/services/path-policy.js';

const key = 'mhmcp_client-secret';
async function fixture(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mh-mcp-client-')));
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('listen failed');
  const config: McpConfig = { baseUrl: new URL(`http://127.0.0.1:${address.port}`), apiKey: key,
    allowedRoots: [directory], generatedRoot: directory, requestTimeoutMs: 300 };
  return { directory, config };
}

// Catches falling back to browser authentication or sending JSON with the wrong byte length.
test('client sends Bearer only and exact JSON bytes to the configured API', async t => {
  const { createMovieHarborClient } = await import('../src/services/movie-harbor-client.js');
  const requests: Array<{ url: string | undefined; method: string | undefined; headers: IncomingMessage['headers']; body: Buffer }> = [];
  const { config } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
  const client = createMovieHarborClient(config);
  assert.deepEqual(await client.json('GET', '/api/admin/genres'), { ok: true });
  assert.deepEqual(await client.json('PATCH', '/api/admin/movies/id?version=3', { name: '影片' }), { ok: true });
  for (const request of requests) {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    for (const header of ['cookie', 'origin', 'x-csrf-token']) assert.equal(request.headers[header], undefined);
  }
  assert.equal(requests[1]!.url, '/api/admin/movies/id?version=3');
  assert.equal(requests[1]!.headers['content-length'], String(Buffer.byteLength('{"name":"影片"}')));
  assert.equal(requests[1]!.body.toString(), '{"name":"影片"}');
});

// Catches absolute/cross-origin paths and URL normalization escaping the administrative API.
test('client rejects uncontrolled paths before any network request', async t => {
  const { createMovieHarborClient } = await import('../src/services/movie-harbor-client.js');
  let requests = 0;
  const { config } = await fixture(t, (_req, res) => { requests++; res.end('{}'); });
  const client = createMovieHarborClient(config);
  for (const path of ['https://example.com/api/admin/genres', '//example.com/api/admin/genres', '/api/public/genres',
    '/api/admin/../../public', '/api/admin/%2e%2e/genres', '/api/admin/a#secret', '/api/admin/a\\b', '/api/admin/a\0b', '/api/admin/%00']) {
    await assert.rejects(client.json('GET', path), { code: 'invalid_path' });
  }
  assert.equal(requests, 0);
});

// Catches reflecting arbitrary backend text or credentials, and losing stable status classifications.
test('client maps HTTP errors to safe Chinese messages and bounded string fields', async t => {
  const { createMovieHarborClient, MovieHarborClientError } = await import('../src/services/movie-harbor-client.js');
  let status = 401;
  let fields: unknown = ['name'];
  const { config } = await fixture(t, (req, res) => {
    req.resume(); res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Authorization: Bearer ${key}`, fields }));
  });
  const client = createMovieHarborClient(config);
  for (const [http, code] of [[401, 'auth_required'], [403, 'forbidden'], [404, 'not_found'], [409, 'version_conflict'],
    [413, 'payload_too_large'], [415, 'unsupported_media'], [422, 'validation_error'], [429, 'rate_limited'], [500, 'server_error'], [302, 'http_error']] as const) {
    status = http;
    await assert.rejects(client.json('GET', '/api/admin/movies'), error => {
      assert.ok(error instanceof MovieHarborClientError);
      assert.equal(error.status, http); assert.equal(error.code, code);
      assert.deepEqual(error.fields, ['name']);
      assert.match(error.message, /[\u4e00-\u9fff]/);
      assert.doesNotMatch(JSON.stringify(error) + error.stack, /mhmcp_client-secret|Authorization|Bearer/);
      return true;
    });
  }
  for (fields of [null, ['name', 1], Array(33).fill('x'), ['x'.repeat(65)], [key]]) {
    await assert.rejects(client.json('GET', '/api/admin/movies'), error => {
      assert.deepEqual((error as {fields: string[]}).fields, []); return true;
    });
  }
});

// Catches unbounded buffering, accepting non-JSON responses, or following redirects.
test('client bounds success and error response bodies and validates JSON', async t => {
  const { createMovieHarborClient } = await import('../src/services/movie-harbor-client.js');
  let status = 200; let payload = 'not json';
  const { config } = await fixture(t, (req, res) => { req.resume(); res.writeHead(status); res.end(payload); });
  const client = createMovieHarborClient(config);
  await assert.rejects(client.json('GET', '/api/admin/genres'), { code: 'invalid_response' });
  for (const [http, bytes] of [[200, 16 * 1024 * 1024 + 1], [422, 64 * 1024 + 1]]) {
    status = http!; payload = 'x'.repeat(bytes!);
    await assert.rejects(client.json('GET', '/api/admin/genres'), { code: 'response_too_large' });
  }
  status = 200; payload = JSON.stringify({ value: 'x'.repeat(70 * 1024) });
  assert.equal((await client.json<{value: string}>('GET', '/api/admin/series/id')).value.length, 70 * 1024);
});

// Catches a missing deadline, resolving truncated responses, and ignoring caller cancellation.
test('client handles timeout, remote interruption, and abort without exposing transport errors', async t => {
  const { createMovieHarborClient } = await import('../src/services/movie-harbor-client.js');
  let mode = 'hang';
  const { config } = await fixture(t, (req, res) => {
    req.resume();
    if (mode === 'cut') { res.writeHead(200, { 'content-length': '100' }); res.write('{'); res.destroy(); }
  });
  config.requestTimeoutMs = 40;
  await assert.rejects(createMovieHarborClient(config).json('GET', '/api/admin/genres'), { code: 'timeout' });
  mode = 'cut';
  await assert.rejects(createMovieHarborClient(config).json('GET', '/api/admin/genres'), { code: 'network_error' });
  mode = 'hang';
  const controller = new AbortController();
  const request = createMovieHarborClient(config, { signal: controller.signal }).json('GET', '/api/admin/genres');
  controller.abort(new Error(key));
  await assert.rejects(request, error => {
    assert.equal((error as {code: string}).code, 'network_error'); assert.doesNotMatch(String(error), /mhmcp_/); return true;
  });
});

// Catches using the requested path without revalidation or reporting bytes before write callbacks.
test('client multipart uploads a checked file with exact length and file-only progress', async t => {
  const { createMovieHarborClient } = await import('../src/services/movie-harbor-client.js');
  let body: Buffer | undefined; let headers: IncomingMessage['headers'] | undefined;
  const { config, directory } = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks); headers = req.headers; res.end('{"id":"video-1"}');
  });
  const path = join(directory, '影片.mp4');
  const payload = Buffer.alloc(1024 * 1024, 0x62); await writeFile(path, payload);
  const file = await inspectAllowedFile(path, config.allowedRoots);
  const progress: number[] = [];
  assert.deepEqual(await createMovieHarborClient(config).upload('/api/admin/media/movies/id/video?version=2', file, 'video/mp4', (sent, total) => {
    assert.equal(total, payload.length); progress.push(sent);
  }), { id: 'video-1' });
  assert.equal(headers!['content-length'], String(body!.length));
  assert.equal(headers!.authorization, `Bearer ${key}`);
  assert.ok(body!.includes(payload));
  assert.match(body!.toString('utf8', 0, 200), /name="file"; filename="影片.mp4"/);
  assert.ok(progress.length > 1); assert.equal(progress.at(-1), payload.length);
  assert.ok(progress.every((sent, i) => sent > (progress[i - 1] ?? 0)));
});

// Catches missing pre/post identity checks, including same-size mutation during delivery.
test('client multipart rejects files changed before or during upload', async t => {
  const { createMovieHarborClient } = await import('../src/services/movie-harbor-client.js');
  const { config, directory } = await fixture(t, async (req, res) => { for await (const _ of req) {} res.end('{}'); });
  const path = join(directory, 'video.mp4'); await writeFile(path, Buffer.alloc(256 * 1024, 0x61));
  const stale = await inspectAllowedFile(path, config.allowedRoots);
  await writeFile(path, 'changed');
  const client = createMovieHarborClient(config);
  await assert.rejects(client.upload('/api/admin/media/movies/id/video', stale, 'video/mp4'), { code: 'file_changed' });
  await writeFile(path, Buffer.alloc(256 * 1024, 0x61));
  const current = await inspectAllowedFile(path, config.allowedRoots);
  let changed = false;
  await assert.rejects(client.upload('/api/admin/media/movies/id/video', current, 'video/mp4', () => {
    if (!changed) { changed = true; writeFileSync(path, Buffer.alloc(256 * 1024, 0x62)); }
  }), { code: 'file_changed' });
});

// Catches treating uploads as a total deadline instead of measuring inactivity.
test('client multipart refreshes inactivity on response progress while JSON keeps total deadline', async t => {
  const { createMovieHarborClient } = await import('../src/services/movie-harbor-client.js');
  const { config, directory } = await fixture(t, async (req, res) => {
    for await (const _ of req) {}
    res.write('{');
    let ticks = 0;
    const timer = setInterval(() => {
      if (res.destroyed) { clearInterval(timer); return; }
      if (++ticks === 10) { clearInterval(timer); res.end('}'); } else res.write(' ');
    }, 15);
  });
  config.requestTimeoutMs = 70;
  const path = join(directory, 'video.mp4'); await writeFile(path, 'video');
  const file = await inspectAllowedFile(path, config.allowedRoots);
  const client = createMovieHarborClient(config);
  assert.deepEqual(await client.upload('/api/admin/media/movies/id/video', file, 'video/mp4'), {});
  await assert.rejects(client.json('GET', '/api/admin/genres'), { code: 'timeout' });
});

// Catches a request or file source surviving a remote close or timeout during upload.
test('client multipart fails on remote close and timeout', async t => {
  const { createMovieHarborClient } = await import('../src/services/movie-harbor-client.js');
  let cut = true;
  const { config, directory } = await fixture(t, (req, res) => { if (cut) req.socket.destroy(); else req.resume(); });
  config.requestTimeoutMs = 70;
  const path = join(directory, 'video.mp4'); await writeFile(path, Buffer.alloc(1024 * 1024));
  const file = await inspectAllowedFile(path, config.allowedRoots);
  const client = createMovieHarborClient(config);
  await assert.rejects(client.upload('/api/admin/media/movies/id/video', file, 'video/mp4'), { code: 'network_error' });
  cut = false;
  await assert.rejects(client.upload('/api/admin/media/movies/id/video', file, 'video/mp4'), { code: 'timeout' });
});

// Catches reopening a replaced pathname after preflight, rather than using the validated descriptor.
test('multipart keeps the opened file identity when the path is replaced before reading', async t => {
  const { createUploadStream } = await import('../src/services/upload-stream.js');
  const { renameSync } = await import('node:fs');
  const { Writable } = await import('node:stream');
  const { directory, config } = await fixture(t, (_req, res) => res.end('{}'));
  const path = join(directory, 'video.mp4');
  await writeFile(path, 'original-file');
  const file = await inspectAllowedFile(path, config.allowedRoots);
  const chunks: Buffer[] = [];
  const sink = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } });
  let stream: ReturnType<typeof createReadStream> | undefined;
  await assert.rejects(createUploadStream(file, config.allowedRoots, 'video/mp4').writeTo(sink, {
    onStream(source) {
      stream = source as ReturnType<typeof createReadStream>;
      renameSync(path, join(directory, 'original.mp4'));
      writeFileSync(path, 'replaced-file');
    },
  }), { code: 'file_changed' });
  const body = Buffer.concat(chunks).toString();
  assert.match(body, /original-file/); assert.doesNotMatch(body, /replaced-file/);
  assert.equal(stream!.destroyed, true);
});

// Catches rejecting authorized converted output or accidentally trusting its parent/sibling directory.
test('client multipart accepts an independent generated root but refuses its parent and siblings', async t => {
  const { createMovieHarborClient } = await import('../src/services/movie-harbor-client.js');
  const { mkdir } = await import('node:fs/promises');
  const { directory, config } = await fixture(t, async (req, res) => { for await (const _ of req) {} res.end('{"ok":true}'); });
  const input = join(directory, 'input'); const output = join(directory, 'generated'); const sibling = join(directory, 'generated-extra');
  await Promise.all([mkdir(input), mkdir(output), mkdir(sibling)]);
  config.allowedRoots = [input]; config.generatedRoot = output;
  const generated = join(output, '00000000-0000-4000-8000-000000000001.mp4');
  await writeFile(generated, 'converted');
  const client = createMovieHarborClient(config);
  assert.deepEqual(await client.upload('/api/admin/media/movies/id/video', await inspectAllowedFile(generated, [output]), 'video/mp4'), { ok: true });
  for (const path of [join(directory, 'parent.mp4'), join(sibling, 'sibling.mp4')]) {
    await writeFile(path, 'outside');
    const checked = await inspectAllowedFile(path, [directory]);
    await assert.rejects(client.upload('/api/admin/media/movies/id/video', checked, 'video/mp4'), { code: 'file_changed' });
  }
});
