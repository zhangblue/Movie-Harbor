import assert from "node:assert/strict";
import { createReadStream, writeFileSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Transform } from "node:stream";
import { createAdminClient, ImportRequestError } from "../tools/content-import/client.mjs";

async function fakeMovieHarbor(handler = async (_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end("{}");
}, { readDelayMs = 0 } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    try {
      for await (const chunk of request) {
        chunks.push(chunk);
        if (readDelayMs) await new Promise((resolve) => setTimeout(resolve, readDelayMs));
      }
    } catch { return; }
    const received = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks) };
    requests.push(received);
    if (request.url === "/api/admin/login") {
      response.writeHead(200, { "set-cookie": "mh_session=session-value; HttpOnly; SameSite=Lax", "content-type": "application/json" });
      response.end('{"name":"admin"}');
    } else if (request.url === "/api/admin/session") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"name":"admin","csrf_token":"csrf-value"}');
    } else {
      await handler(received, response);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function withServer(handler, run, options) {
  const server = await fakeMovieHarbor(handler, options);
  try { return await run(server); } finally { await server.close(); }
}

async function withEarlySuccessServer(run) {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"version":3}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function pacedFile(path, delayMs) {
  const source = createReadStream(path, { highWaterMark: 4096 });
  let timer;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      timer = setTimeout(() => { timer = undefined; callback(null, chunk); }, delayMs);
    },
    destroy(error, callback) {
      clearTimeout(timer);
      source.destroy();
      callback(error);
    },
  });
  source.on("error", (error) => stream.destroy(error));
  source.pipe(stream);
  return { source, stream };
}

test("multipart keeps progressing beyond its timeout and releases file streams and timers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-paced-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const localPath = join(directory, "long.mp4");
  const payload = Buffer.alloc(4096 * 16, 0x61);
  writeFileSync(localPath, payload);
  const timers = new Set();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const timer = realSetTimeout(() => { timers.delete(timer); callback(...args); }, delay);
    timers.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => { timers.delete(timer); realClearTimeout(timer); });
  let paced;
  await withServer(undefined, async ({ origin, requests }) => {
    const client = createAdminClient(origin, { timeoutMs: 200, createReadStream(path) {
      paced = pacedFile(path, 40);
      return paced.stream;
    } });
    const started = performance.now();
    await client.upload("/upload", { localPath, byteSize: payload.length });
    assert.ok(performance.now() - started > 200);
    assert.ok(requests[0].body.includes(payload));
    assert.equal(paced.stream.destroyed, true);
    assert.equal(paced.source.destroyed, true);
    assert.equal(timers.size, 0, "completed requests must clear their timeout");
  });
});

test("multipart stalls during file delivery or after delivery time out and close streams", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-stalled-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const localPath = join(directory, "stalled.mp4");
  writeFileSync(localPath, Buffer.alloc(4096 * 4, 0x61));
  for (const delayMs of [1000, 1]) {
    let paced;
    await withServer(() => {}, async ({ origin, requests }) => {
      const client = createAdminClient(origin, { timeoutMs: 100, createReadStream(path) {
        paced = pacedFile(path, delayMs);
        return paced.stream;
      } });
      await assert.rejects(client.upload("/upload", { localPath, byteSize: 4096 * 4 }),
        (error) => error.fatal && error.category === "network" && /timed out/.test(error.message));
      assert.equal(paced.stream.destroyed, true);
      assert.equal(paced.source.destroyed, true);
      assert.equal(requests.length, delayMs === 1 ? 1 : 0);
    });
  }
});

test("multipart times out when the peer stops reading and closes the backpressured file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-backpressure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const localPath = join(directory, "large.mp4");
  const byteSize = 64 * 1024 * 1024;
  const handle = await open(localPath, "w");
  await handle.truncate(byteSize);
  await handle.close();
  let file;
  let requestSeen = false;
  const server = createServer((request) => { requestSeen = true; request.pause(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = createAdminClient(`http://127.0.0.1:${server.address().port}`, {
      timeoutMs: 100,
      createReadStream(path) { file = createReadStream(path); return file; },
    });
    await assert.rejects(client.upload("/upload", { localPath, byteSize }),
      (error) => error.fatal && /timed out/.test(error.message));
    assert.equal(requestSeen, true);
    assert.ok(file.bytesRead < byteSize, "backpressure must stop reading the entire file");
    assert.equal(file.destroyed, true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("JSON requests retain a total deadline even while the response makes progress", async () => {
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"value":"');
    const interval = setInterval(() => response.write("x"), 20);
    response.once("close", () => clearInterval(interval));
  }, async ({ origin }) => {
    await assert.rejects(createAdminClient(origin, { timeoutMs: 100 }).json("GET", "/slow-json"),
      (error) => error.fatal && /timed out/.test(error.message));
  });
});

test("rejects non-origin targets and normalizes a trailing slash", async () => {
  for (const target of ["ftp://localhost", "http://user:secret@localhost", "http://localhost/admin", "http://localhost/?token=x", "http://localhost/?", "http://localhost/#fragment", "http://localhost/#", "not-a-url"]) {
    assert.throws(() => createAdminClient(target), /origin|target|URL/i, target);
  }
  await withServer(undefined, async ({ origin }) => {
    const client = createAdminClient(`${origin}/`);
    await client.login("admin", "secret");
  });
});

test("retains login cookie, gets session CSRF, and sends exact JSON length", async () => {
  await withServer(undefined, async ({ origin, requests }) => {
    const client = createAdminClient(origin);
    await client.login("admin", "secret");
    await client.json("POST", "/api/admin/genres", { name: "自定义" });
    assert.deepEqual(requests.map((request) => request.url), ["/api/admin/login", "/api/admin/session", "/api/admin/genres"]);
    assert.deepEqual(JSON.parse(requests[0].body), { name: "admin", password: "secret" });
    assert.equal(requests[1].headers.cookie, "mh_session=session-value");
    assert.equal(requests[2].headers.cookie, "mh_session=session-value");
    assert.equal(requests[2].headers["x-csrf-token"], "csrf-value");
    assert.equal(requests[2].headers.origin, origin);
    assert.equal(requests[2].headers["content-length"], String(requests[2].body.length));
    assert.equal(requests[2].headers["content-type"], "application/json");
  });
});

test("classifies content and fatal HTTP failures without exposing response secrets", async () => {
  for (const [status, fatal] of [[422, false], [401, true], [403, true]]) {
    await withServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "INVALID", detail: `private-${"x".repeat(20_000)}` }));
    }, async ({ origin }) => {
      const client = createAdminClient(origin);
      await client.login("admin", "secret");
      await assert.rejects(client.json("POST", "/api/admin/genres", { name: "test" }), (error) => {
        assert.ok(error instanceof ImportRequestError);
        assert.equal(error.status, status);
        assert.equal(error.fatal, fatal);
        assert.equal(error.category, fatal ? "auth" : "content");
        assert.ok(error.message.length < 1000);
        assert.doesNotMatch(error.message, /secret|session-value|csrf-value|private-/);
        return true;
      });
    });
  }
});

test("redirect and rate limit responses are fatal", async (t) => {
  for (const status of [302, 429, 500]) {
    await t.test(`HTTP ${status}`, async () => {
      await withServer((_request, response) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end("{}");
      }, async ({ origin }) => {
        const client = createAdminClient(origin);
        await client.login("admin", "secret");
        await assert.rejects(client.json("GET", "/api/admin/status"), (error) => {
          assert.ok(error instanceof ImportRequestError);
          assert.equal(error.status, status);
          assert.equal(error.fatal, true);
          assert.notEqual(error.category, "content");
          return true;
        });
      });
    });
  }
});

test("connection refusal, timeout and interrupted response are fatal", async () => {
  const unavailable = await fakeMovieHarbor();
  const origin = unavailable.origin;
  await unavailable.close();
  await assert.rejects(createAdminClient(origin, { timeoutMs: 100 }).login("admin", "secret"), (error) => error instanceof ImportRequestError && error.fatal);

  await withServer((_request, _response) => {}, async ({ origin: slow }) => {
    const client = createAdminClient(slow, { timeoutMs: 30 });
    await client.login("admin", "secret");
    await assert.rejects(client.json("GET", "/api/admin/hang"), (error) => error instanceof ImportRequestError && error.fatal && error.category === "network");
  });

  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
    response.write("{\"partial\":");
    response.destroy();
  }, async ({ origin: cut }) => {
    const client = createAdminClient(cut);
    await client.login("admin", "secret");
    await assert.rejects(client.json("GET", "/api/admin/cut"), (error) => error instanceof ImportRequestError && error.fatal);
  });
});

test("streams a file with exact multipart length and preserves query", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-"));
  try {
    const localPath = join(directory, "movie.mp4");
    const payload = Buffer.alloc(256 * 1024, 0x61);
    writeFileSync(localPath, payload);
    let readChunks = 0;
    await withServer(async (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"version":3}');
    }, async ({ origin, requests }) => {
      const client = createAdminClient(origin, { createReadStream: (path) => {
        const stream = createReadStream(path, { highWaterMark: 4096 });
        stream.on("data", () => { readChunks += 1; });
        return stream;
      } });
      await client.login("admin", "secret");
      const result = await client.upload("/api/admin/media/movies/id/video?version=2", { localPath, byteSize: payload.length });
      assert.equal(result.version, 3);
      const received = requests[2];
      assert.equal(received.url, "/api/admin/media/movies/id/video?version=2");
      assert.equal(received.headers["content-length"], String(received.body.length));
      assert.equal(received.headers.cookie, "mh_session=session-value");
      assert.equal(received.headers["x-csrf-token"], "csrf-value");
      assert.match(received.headers["content-type"], /^multipart\/form-data; boundary=/);
      assert.match(received.body.toString("latin1"), /name="file"; filename="movie.mp4"/);
      assert.match(received.body.toString("latin1"), /Content-Type: video\/mp4/);
      assert.ok(received.body.includes(payload));
      assert.ok(readChunks > 1);
    }, { readDelayMs: 1 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects unsupported or unsafe filenames before uploading", async () => {
  await withServer(undefined, async ({ origin, requests }) => {
    const client = createAdminClient(origin);
    await client.login("admin", "secret");
    for (const localPath of ["/tmp/evil.txt", "/tmp/bad\rname.mp4", "/tmp/bad\nname.mp4", "/tmp/bad\"name.mp4"]) {
      await assert.rejects(client.upload("/api/admin/media/movies/id/video", { localPath, byteSize: 1 }), ImportRequestError);
    }
    await assert.rejects(client.upload("/api/admin/media/movies/id/video", { localPath: "/tmp/evil.ogv", byteSize: 1 }), (error) => error instanceof ImportRequestError && error.category === "content" && !error.fatal);
    assert.equal(requests.length, 2);
  });
});

test("file read errors and early remote close fail fatally", async () => {
  await withServer(undefined, async ({ origin }) => {
    const client = createAdminClient(origin);
    await client.login("admin", "secret");
    await assert.rejects(client.upload("/api/admin/media/movies/id/video", { localPath: "/tmp/missing-mh.mp4", byteSize: 1 }), (error) => error instanceof ImportRequestError && error.fatal);
  });

  const directory = await mkdtemp(join(tmpdir(), "mh-client-"));
  try {
    const localPath = join(directory, "movie.mp4");
    writeFileSync(localPath, Buffer.alloc(1024 * 1024, 0x62));
    await withServer((_request, response) => response.destroy(), async ({ origin }) => {
      const client = createAdminClient(origin, { timeoutMs: 1000 });
      await client.login("admin", "secret");
      await assert.rejects(client.upload("/api/admin/media/movies/id/video", { localPath, byteSize: 1024 * 1024 }), (error) => error instanceof ImportRequestError && error.fatal);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("upload timeout destroys the request and fails fatally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-"));
  try {
    const localPath = join(directory, "movie.webm");
    writeFileSync(localPath, Buffer.alloc(64 * 1024, 0x61));
    await withServer((_request, _response) => {}, async ({ origin }) => {
      const client = createAdminClient(origin, { timeoutMs: 30 });
      await client.login("admin", "secret");
      await assert.rejects(client.upload("/api/admin/media/movies/id/video", { localPath, byteSize: 64 * 1024 }), (error) => error instanceof ImportRequestError && error.fatal && error.category === "network");
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("remote close during multipart upload fails fatally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-"));
  const server = createServer((request) => request.socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const localPath = join(directory, "movie.mp4");
    writeFileSync(localPath, Buffer.alloc(1024 * 1024, 0x61));
    const client = createAdminClient(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 500 });
    await assert.rejects(client.upload("/api/admin/media/movies/id/video", { localPath, byteSize: 1024 * 1024 }), (error) => error instanceof ImportRequestError && error.fatal);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("early success response cannot hide an incomplete file body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-"));
  try {
    const localPath = join(directory, "short.mp4");
    writeFileSync(localPath, "x");
    await withEarlySuccessServer(async (origin) => {
      const client = createAdminClient(origin, { createReadStream(path) {
        const stream = createReadStream(path, { highWaterMark: 1 });
        stream.once("data", () => {
          stream.pause();
          setTimeout(() => stream.resume(), 40);
        });
        return stream;
      } });
      await assert.rejects(client.upload("/api/admin/media/movies/id/video", { localPath, byteSize: 2 }), (error) => error instanceof ImportRequestError && error.fatal && error.message === "file upload failed");
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("early success response cannot hide a later file stream error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-"));
  try {
    const localPath = join(directory, "broken.mp4");
    writeFileSync(localPath, Buffer.alloc(128 * 1024, 0x61));
    await withEarlySuccessServer(async (origin) => {
      const client = createAdminClient(origin, { createReadStream(path) {
        const stream = createReadStream(path, { highWaterMark: 1 });
        stream.once("data", () => {
          stream.pause();
          setTimeout(() => stream.destroy(new Error("source failed")), 40);
        });
        return stream;
      } });
      await assert.rejects(client.upload("/api/admin/media/movies/id/video", { localPath, byteSize: 128 * 1024 }), (error) => error instanceof ImportRequestError && error.fatal && error.message === "file upload failed");
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("uses supported image and video MIME types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-"));
  try {
    await withServer(undefined, async ({ origin, requests }) => {
      const client = createAdminClient(origin);
      await client.login("admin", "secret");
      const formats = [["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["png", "image/png"], ["webp", "image/webp"], ["mp4", "video/mp4"], ["webm", "video/webm"]];
      for (const [extension] of formats) {
        const localPath = join(directory, `media.${extension}`);
        writeFileSync(localPath, "x");
        await client.upload("/api/admin/media/movies/id/video", { localPath, byteSize: 1 });
      }
      for (const [index, [, mimeType]] of formats.entries()) {
        assert.match(requests[index + 2].body.toString("latin1"), new RegExp(`Content-Type: ${mimeType.replace("/", "\\/")}`));
      }
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("bounds response memory when server sends an oversized body", async () => {
  await withServer((_request, response) => {
    response.writeHead(422, { "content-type": "application/json" });
    response.end("x".repeat(128 * 1024));
  }, async ({ origin }) => {
    const client = createAdminClient(origin);
    await client.login("admin", "secret");
    await assert.rejects(client.json("GET", "/api/admin/oversized"), (error) => error instanceof ImportRequestError && error.fatal && error.message.length < 1000);
  });
});

test("parses a complete series response larger than 64 KiB", async () => {
  const episodes = Array.from({ length: 600 }, (_, index) => ({
    id: `episode-${index + 1}`, season_id: "season-1", number: index + 1,
    name: `Episode ${index + 1}`, duration_seconds: null, status: "draft", version: 1,
    published_at: null, archived_at: null, created_at: "2026-09-24T00:00:00Z",
    updated_at: "2026-09-24T00:00:00Z", video: null,
  }));
  const series = { id: "series-1", name: "Large show", synopsis: "", year: 2024,
    status: "draft", version: 602, published_at: null, archived_at: null,
    created_at: "2026-09-24T00:00:00Z", updated_at: "2026-09-24T00:00:00Z",
    genres: [], poster: null, seasons: [{ id: "season-1", number: 1, episodes }] };
  const payload = JSON.stringify(series);
  assert.ok(Buffer.byteLength(payload) > 64 * 1024);
  assert.ok(Buffer.byteLength(payload) < 16 * 1024 * 1024);
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(payload);
  }, async ({ origin }) => {
    const client = createAdminClient(origin);
    await client.login("admin", "secret");
    const response = await client.json("GET", "/api/admin/series/series-1");
    assert.equal(response.version, 602);
    assert.equal(response.seasons[0].episodes.length, 600);
    assert.equal(response.seasons[0].episodes[599].id, "episode-600");
  });
});

test("rejects a successful JSON response larger than 16 MiB", async () => {
  const payload = JSON.stringify({ value: "x".repeat(16 * 1024 * 1024) });
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(payload);
  }, async ({ origin }) => {
    const client = createAdminClient(origin);
    await client.login("admin", "secret");
    await assert.rejects(client.json("GET", "/api/admin/series/large"), (error) => {
      assert.ok(error instanceof ImportRequestError);
      assert.equal(error.fatal, true);
      assert.equal(error.category, "network");
      assert.match(error.message, /size limit/);
      return true;
    });
  });
});
