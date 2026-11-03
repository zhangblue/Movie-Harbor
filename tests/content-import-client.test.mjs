import assert from "node:assert/strict";
import { createReadStream, writeFileSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Readable, Transform, Writable } from "node:stream";
import { createAdminClient, ImportRequestError } from "../tools/content-import/client.mjs";

// 启动模拟管理服务并记录请求，供登录、上传和响应测试使用。
async function fakeMovieHarbor(handler = async (_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end("{}");
}, { readDelayMs = 0 } = {}) {
  const requests = [];
  // 收到请求时缓存请求体并模拟登录或交给测试处理器，供检查认证和上传。
  const server = createServer(async (request, response) => {
    const chunks = [];
    try {
      for await (const chunk of request) {
        chunks.push(chunk);
        // 按配置延迟读取每块请求，模拟慢速服务端及上传进度。
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
  // 在回环地址使用临时端口启动测试服务，避免影响其他服务。
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // 返回服务地址、请求记录和关闭函数；测试结束时等待服务释放端口。
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

// 围绕测试启动并关闭模拟服务，确保失败时也释放端口。
async function withServer(handler, run, options) {
  const server = await fakeMovieHarbor(handler, options);
  try { return await run(server); } finally { await server.close(); }
}

// 启动提前返回成功的服务，供检验未完成上传及流错误使用。
async function withEarlySuccessServer(run) {
  // 收到请求后立即返回成功，模拟服务端早于文件传输结束响应。
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"version":3}');
  });
  // 在回环地址使用临时端口启动测试服务，避免影响其他服务。
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally {
    server.closeAllConnections();
    // 测试结束后等待服务关闭，避免留下监听端口。
    await new Promise((resolve) => server.close(resolve));
  }
}

// 创建延迟传输的文件流，供超时、进度及流关闭测试使用。
function pacedFile(path, delayMs) {
  const source = createReadStream(path, { highWaterMark: 4096 });
  let timer;
  const stream = new Transform({
    // 延迟交付每一块，供测试区分持续上传与空闲超时。
    transform(chunk, _encoding, callback) {
      // 定时释放一个文件块并清除标记，供慢速上传测试观察进度。
      timer = setTimeout(() => { timer = undefined; callback(null, chunk); }, delayMs);
    },
    // 测试流关闭时清除定时器并销毁源文件，便于验证资源释放。
    destroy(error, callback) {
      clearTimeout(timer);
      source.destroy();
      callback(error);
    },
  });
  // 源文件出错时销毁包装流，让上传请求收到错误而非悬挂。
  source.on("error", (error) => stream.destroy(error));
  source.pipe(stream);
  return { source, stream };
}

// 验证multipart 上传持续有进度时可超过超时值，完成后释放文件流和定时器。
test("multipart keeps progressing beyond its timeout and releases file streams and timers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-paced-"));
  // 测试结束时删除专属临时目录，断言失败也不会遗留测试媒体。
  t.after(() => rm(directory, { recursive: true, force: true }));
  const localPath = join(directory, "long.mp4");
  const payload = Buffer.alloc(4096 * 16, 0x61);
  writeFileSync(localPath, payload);
  const timers = new Set();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  // 包装定时器以追踪未释放的计时任务，供上传完成后断言。
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    // 定时器触发时移除追踪记录并执行原回调，避免计入已完成任务。
    const timer = realSetTimeout(() => { timers.delete(timer); callback(...args); }, delay);
    timers.add(timer);
    return timer;
  });
  // 清除定时器时同步更新集合，供验证请求正确释放资源。
  t.mock.method(globalThis, "clearTimeout", (timer) => { timers.delete(timer); realClearTimeout(timer); });
  let paced;
  // 服务就绪后运行请求与断言；辅助函数会在失败时关闭服务。
  await withServer(undefined, async ({ origin, requests }) => {
    // 注入延迟源流并保存引用，供持续上传完成后检查资源释放。
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

// 验证文件发送中或发送后停滞会超时并关闭流。
test("multipart stalls during file delivery or after delivery time out and close streams", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-stalled-"));
  // 测试结束时删除专属临时目录，断言失败也不会遗留测试媒体。
  t.after(() => rm(directory, { recursive: true, force: true }));
  const localPath = join(directory, "stalled.mp4");
  writeFileSync(localPath, Buffer.alloc(4096 * 4, 0x61));
  for (const delayMs of [1000, 1]) {
    let paced;
    // 模拟无响应的处理器，验证请求超时后关闭上传资源。
    await withServer(() => {}, async ({ origin, requests }) => {
      // 注入可调延迟源流，供验证不同停滞阶段的超时清理。
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

// 验证对端停止读取时上传超时并关闭因背压等待的文件流。
test("multipart times out when the peer stops reading and closes the backpressured file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-backpressure-"));
  // 测试结束时删除专属临时目录，断言失败也不会遗留测试媒体。
  t.after(() => rm(directory, { recursive: true, force: true }));
  const localPath = join(directory, "large.mp4");
  const byteSize = 64 * 1024 * 1024;
  const handle = await open(localPath, "w");
  await handle.truncate(byteSize);
  await handle.close();
  let file;
  let requestSeen = false;
  // 暂停读取请求体以制造背压，供验证超时后源文件关闭。
  const server = createServer((request) => { requestSeen = true; request.pause(); });
  // 在回环地址使用临时端口启动测试服务，避免影响其他服务。
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = createAdminClient(`http://127.0.0.1:${server.address().port}`, {
      timeoutMs: 100,
      // 保存上传源流，供对端停止读取后断言其已关闭。
      createReadStream(path) { file = createReadStream(path); return file; },
    });
    await assert.rejects(client.upload("/upload", { localPath, byteSize }),
      (error) => error.fatal && /timed out/.test(error.message));
    assert.equal(requestSeen, true);
    assert.ok(file.bytesRead < byteSize, "backpressure must stop reading the entire file");
    assert.equal(file.destroyed, true);
  } finally {
    server.closeAllConnections();
    // 测试结束后等待服务关闭，避免留下监听端口。
    await new Promise((resolve) => server.close(resolve));
  }
});

// 验证JSON 请求即使收到进度也遵守总时限。
test("JSON requests retain a total deadline even while the response makes progress", async () => {
  // 模拟服务器构造当前测试需要的响应，供客户端验证超时或错误处理。
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"value":"');
    // 定期发送响应字节但不结束，供检验 JSON 总时限。
    const interval = setInterval(() => response.write("x"), 20);
    // 响应关闭时停止模拟发送，避免测试结束后保留定时器。
    response.once("close", () => clearInterval(interval));
  // 服务就绪后发送请求并断言本场景结果，结束时关闭服务。
  }, async ({ origin }) => {
    await assert.rejects(createAdminClient(origin, { timeoutMs: 100 }).json("GET", "/slow-json"),
      (error) => error.fatal && /timed out/.test(error.message));
  });
});

// 验证拒绝非来源目标并规范化末尾斜杠。
test("rejects non-origin targets and normalizes a trailing slash", async () => {
  for (const target of ["ftp://localhost", "http://user:secret@localhost", "http://localhost/admin", "http://localhost/?token=x", "http://localhost/?", "http://localhost/#fragment", "http://localhost/#", "not-a-url"]) {
    assert.throws(() => createAdminClient(target), /origin|target|URL/i, target);
  }
  // 服务就绪后执行登录或错误断言，结束时统一关闭服务。
  await withServer(undefined, async ({ origin }) => {
    const client = createAdminClient(`${origin}/`);
    await client.login("admin", "secret");
  });
});

// 验证保留登录 Cookie、取得会话 CSRF 并发送准确 JSON 长度。
test("retains login cookie, gets session CSRF, and sends exact JSON length", async () => {
  // 服务就绪后运行请求与断言；辅助函数会在失败时关闭服务。
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

// 验证区分内容与致命 HTTP 错误且不泄漏响应中的秘密。
test("classifies content and fatal HTTP failures without exposing response secrets", async () => {
  for (const [status, fatal] of [[422, false], [401, true], [403, true]]) {
    // 模拟服务器构造当前测试需要的响应，供客户端验证超时或错误处理。
    await withServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "INVALID", detail: `private-${"x".repeat(20_000)}` }));
    // 服务就绪后发送请求并断言本场景结果，结束时关闭服务。
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

// 验证重定向和限流响应归类为致命错误。
test("redirect and rate limit responses are fatal", async (t) => {
  for (const status of [302, 429, 500]) {
    // 对每个响应状态单独运行失败分类断言，便于定位特定状态问题。
    await t.test(`HTTP ${status}`, async () => {
      // 模拟服务器构造当前测试需要的响应，供客户端验证超时或错误处理。
      await withServer((_request, response) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end("{}");
      // 服务就绪后发送请求并断言本场景结果，结束时关闭服务。
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

// 验证连接拒绝、超时和响应中断均为致命错误。
test("connection refusal, timeout and interrupted response are fatal", async () => {
  const unavailable = await fakeMovieHarbor();
  const origin = unavailable.origin;
  await unavailable.close();
  await assert.rejects(createAdminClient(origin, { timeoutMs: 100 }).login("admin", "secret"), (error) => error instanceof ImportRequestError && error.fatal);

  // 模拟服务端不响应，供客户端网络超时断言使用。
  await withServer((_request, _response) => {}, async ({ origin: slow }) => {
    const client = createAdminClient(slow, { timeoutMs: 30 });
    await client.login("admin", "secret");
    await assert.rejects(client.json("GET", "/api/admin/hang"), (error) => error instanceof ImportRequestError && error.fatal && error.category === "network");
  });

  // 模拟服务器构造当前测试需要的响应，供客户端验证超时或错误处理。
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": "100" });
    response.write("{\"partial\":");
    response.destroy();
  // 响应中途断开后运行客户端，验证传输失败被报告。
  }, async ({ origin: cut }) => {
    const client = createAdminClient(cut);
    await client.login("admin", "secret");
    await assert.rejects(client.json("GET", "/api/admin/cut"), (error) => error instanceof ImportRequestError && error.fatal);
  });
});

// 验证流式上传文件的 multipart 长度准确并保留查询参数。
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
    // 服务就绪后运行本场景并检查记录的请求，结束时关闭服务。
    }, async ({ origin, requests }) => {
      // 注入小块文件流并统计读取次数，验证上传不会一次加载整个文件。
      const client = createAdminClient(origin, { createReadStream: (path) => {
        const stream = createReadStream(path, { highWaterMark: 4096 });
        // 读取流每次产生数据时计数，供断言上传使用流式分块。
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

// 验证上传前拒绝不支持或不安全的文件名。
test("rejects unsupported or unsafe filenames before uploading", async () => {
  // 服务就绪后运行请求与断言；辅助函数会在失败时关闭服务。
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

// 验证文件读取错误及远端提前关闭产生致命失败。
test("file read errors and early remote close fail fatally", async () => {
  // 服务就绪后执行登录或错误断言，结束时统一关闭服务。
  await withServer(undefined, async ({ origin }) => {
    const client = createAdminClient(origin);
    await client.login("admin", "secret");
    await assert.rejects(client.upload("/api/admin/media/movies/id/video", { localPath: "/tmp/missing-mh.mp4", byteSize: 1 }), (error) => error instanceof ImportRequestError && error.fatal);
  });

  const directory = await mkdtemp(join(tmpdir(), "mh-client-"));
  try {
    const localPath = join(directory, "movie.mp4");
    writeFileSync(localPath, Buffer.alloc(1024 * 1024, 0x62));
    // 模拟服务端提前断开，验证上传报告致命错误。
    await withServer((_request, response) => response.destroy(), async ({ origin }) => {
      const client = createAdminClient(origin, { timeoutMs: 1000 });
      await client.login("admin", "secret");
      await assert.rejects(client.upload("/api/admin/media/movies/id/video", { localPath, byteSize: 1024 * 1024 }), (error) => error instanceof ImportRequestError && error.fatal);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// 验证上传超时销毁请求并产生致命失败。
test("upload timeout destroys the request and fails fatally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-"));
  try {
    const localPath = join(directory, "movie.webm");
    writeFileSync(localPath, Buffer.alloc(64 * 1024, 0x61));
    // 模拟上传后服务端不响应，供超时与清理断言使用。
    await withServer((_request, _response) => {}, async ({ origin }) => {
      const client = createAdminClient(origin, { timeoutMs: 30 });
      await client.login("admin", "secret");
      await assert.rejects(client.upload("/api/admin/media/movies/id/video", { localPath, byteSize: 64 * 1024 }), (error) => error instanceof ImportRequestError && error.fatal && error.category === "network");
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// 验证multipart 上传时远端关闭产生致命失败。
test("remote close during multipart upload fails fatally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-"));
  // 连接建立后立即关闭套接字，模拟上传期间远端中断。
  const server = createServer((request) => request.socket.destroy());
  // 在回环地址使用临时端口启动测试服务，避免影响其他服务。
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const localPath = join(directory, "movie.mp4");
    writeFileSync(localPath, Buffer.alloc(1024 * 1024, 0x61));
    const client = createAdminClient(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 500 });
    await assert.rejects(client.upload("/api/admin/media/movies/id/video", { localPath, byteSize: 1024 * 1024 }), (error) => error instanceof ImportRequestError && error.fatal);
  } finally {
    // 测试结束后等待服务关闭，避免留下监听端口。
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

// 验证服务端提前成功响应不能掩盖不完整的文件正文。
test("early success response cannot hide an incomplete file body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-"));
  try {
    const localPath = join(directory, "short.mp4");
    writeFileSync(localPath, "x");
    // 在提前响应服务下运行上传，验证未完成写入仍会失败。
    await withEarlySuccessServer(async (origin) => {
      // 注入可控文件流，供延迟、提前响应和错误传播测试使用。
      const client = createAdminClient(origin, { createReadStream(path) {
        const stream = createReadStream(path, { highWaterMark: 1 });
        // 首块到达时改变流状态，模拟服务端提前响应期间的文件行为。
        stream.once("data", () => {
          stream.pause();
          // 稍后恢复文件流，验证提前响应不能绕过剩余正文。
          setTimeout(() => stream.resume(), 40);
        });
        return stream;
      } });
      await assert.rejects(client.upload("/api/admin/media/movies/id/video", { localPath, byteSize: 2 }), (error) => error instanceof ImportRequestError && error.fatal && error.message === "file upload failed");
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// 验证服务端提前成功响应不能掩盖随后的文件流错误。
test("early success response cannot hide a later file stream error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-"));
  try {
    const localPath = join(directory, "broken.mp4");
    writeFileSync(localPath, Buffer.alloc(128 * 1024, 0x61));
    // 在提前响应服务下运行上传，验证未完成写入仍会失败。
    await withEarlySuccessServer(async (origin) => {
      // 注入可控文件流，供延迟、提前响应和错误传播测试使用。
      const client = createAdminClient(origin, { createReadStream(path) {
        const stream = createReadStream(path, { highWaterMark: 1 });
        // 首块到达时改变流状态，模拟服务端提前响应期间的文件行为。
        stream.once("data", () => {
          stream.pause();
          // 延迟注入源文件错误，验证提前成功响应不能掩盖上传失败。
          setTimeout(() => stream.destroy(new Error("source failed")), 40);
        });
        return stream;
      } });
      await assert.rejects(client.upload("/api/admin/media/movies/id/video", { localPath, byteSize: 128 * 1024 }), (error) => error instanceof ImportRequestError && error.fatal && error.message === "file upload failed");
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// 验证上传使用受支持的图片和视频 MIME 类型。
test("uses supported image and video MIME types", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mh-client-"));
  try {
    // 服务就绪后运行请求与断言；辅助函数会在失败时关闭服务。
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

// 验证服务器发送超大响应时限制内存使用。
test("bounds response memory when server sends an oversized body", async () => {
  // 模拟服务器构造当前测试需要的响应，供客户端验证超时或错误处理。
  await withServer((_request, response) => {
    response.writeHead(422, { "content-type": "application/json" });
    response.end("x".repeat(128 * 1024));
  // 服务就绪后发送请求并断言本场景结果，结束时关闭服务。
  }, async ({ origin }) => {
    const client = createAdminClient(origin);
    await client.login("admin", "secret");
    await assert.rejects(client.json("GET", "/api/admin/oversized"), (error) => error instanceof ImportRequestError && error.fatal && error.message.length < 1000);
  });
});

// 验证正确解析大于 64 KiB 的完整剧集响应。
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
  // 模拟服务器构造当前测试需要的响应，供客户端验证超时或错误处理。
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(payload);
  // 服务就绪后发送请求并断言本场景结果，结束时关闭服务。
  }, async ({ origin }) => {
    const client = createAdminClient(origin);
    await client.login("admin", "secret");
    const response = await client.json("GET", "/api/admin/series/series-1");
    assert.equal(response.version, 602);
    assert.equal(response.seasons[0].episodes.length, 600);
    assert.equal(response.seasons[0].episodes[599].id, "episode-600");
  });
});

// 验证拒绝大于 16 MiB 的成功 JSON 响应。
test("rejects a successful JSON response larger than 16 MiB", async () => {
  const payload = JSON.stringify({ value: "x".repeat(16 * 1024 * 1024) });
  // 模拟服务器构造当前测试需要的响应，供客户端验证超时或错误处理。
  await withServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(payload);
  // 服务就绪后发送请求并断言本场景结果，结束时关闭服务。
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


// Catches writing ahead of the flush callback or miscounting UTF-8 multipart metadata.
// 验证共享 multipart 流限制缓冲并发送准确字节长度。
test("shared multipart streams with bounded buffering and an exact byte length", async (t) => {
  const { createMultipartFileBody } = await import("../tools/http/stream-multipart.mjs");
  const directory = await mkdtemp(join(tmpdir(), "mh-multipart-"));
  // 测试结束时删除专属临时目录，断言失败也不会遗留测试媒体。
  t.after(() => rm(directory, { recursive: true, force: true }));
  const localPath = join(directory, "影片.mp4");
  const payload = Buffer.alloc(1024 * 1024, 0x61);
  writeFileSync(localPath, payload);
  const chunks = [];
  let maxBuffered = 0;
  // 写入时记录缓冲和数据并延迟完成，模拟有背压的接收端。
  const sink = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
    maxBuffered = Math.max(maxBuffered, this.writableLength);
    chunks.push(chunk);
    // 延迟写入回调以模拟背压下的异步消费，检查缓冲有界。
    setTimeout(callback, 1);
  } });
  const multipart = createMultipartFileBody({ localPath, fileName: "影片.mp4", mimeType: "video/mp4", byteSize: payload.length });
  await multipart.writeTo(sink);
  const body = Buffer.concat(chunks);
  assert.equal(multipart.headers["content-length"], String(body.length));
  assert.ok(maxBuffered < payload.length);
  assert.match(body.toString("utf8", 0, 200), /name="file"; filename="影片.mp4"/);
  assert.ok(body.includes(payload));
  assert.equal(sink.writableFinished, true);
});

// Catches accepting short/long streams and leaving source/destination alive on cancellation.
// 验证共享 multipart 拒绝文件大小变化且取消时销毁两个流。
test("shared multipart rejects changed sizes and abort destroys both streams", async () => {
  const { createMultipartFileBody } = await import("../tools/http/stream-multipart.mjs");
  for (const size of [0, 2]) {
    // 测试接收端立即确认写入，供文件长度变化和取消场景使用。
    const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const source = Readable.from([Buffer.from("x")]);
    await assert.rejects(createMultipartFileBody({ localPath: "/unused", fileName: "v.mp4", mimeType: "video/mp4", byteSize: size })
      .writeTo(sink, { createStream: () => source }), /file size changed/);
    assert.equal(sink.destroyed, true);
    assert.equal(source.destroyed, true);
  }
  const abort = new AbortController();
  // 测试源流故意不产生数据，使取消发生在上传等待期间。
  const source = new Readable({ read() {} });
  // 测试接收端立即确认写入，供文件长度变化和取消场景使用。
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const writing = createMultipartFileBody({ localPath: "/unused", fileName: "v.mp4", mimeType: "video/mp4", byteSize: 1 })
    .writeTo(sink, { createStream: () => source, signal: abort.signal });
  // 下一事件循环取消停滞上传，确认请求和源流都被销毁。
  setImmediate(() => abort.abort());
  await assert.rejects(writing, /abort/i);
  assert.equal(source.destroyed, true);
  assert.equal(sink.destroyed, true);
});

// Catches header injection and overflow which can corrupt an HTTP message boundary.
// 验证共享 multipart 校验请求头，写入数据时拒绝远端关闭。
test("shared multipart validates headers and writeChunk rejects remote close", async () => {
  const { multipartParts, writeChunk } = await import("../tools/http/stream-multipart.mjs");
  for (const input of [
    { fileName: 'bad\rname.mp4', mimeType: 'video/mp4', byteSize: 1 },
    { fileName: 'v.mp4', mimeType: 'video/mp4\r\nX-Injected: yes', byteSize: 1 },
    { fileName: 'v.mp4', mimeType: 'video/mp4', byteSize: Number.MAX_SAFE_INTEGER },
  ]) assert.throws(() => multipartParts(input));
  // 测试接收端不完成写入，供模拟远端关闭并验证拒绝。
  const sink = new Writable({ write() {} });
  const writing = writeChunk(sink, Buffer.from("x"));
  sink.destroy();
  await assert.rejects(writing, /closed/i);
});

// Catches a shared multipart validation error escaping the CLI error contract.
// 验证CLI 按内容错误契约拒绝不安全的 multipart 长度。
test("CLI rejects unsafe multipart lengths with its content error contract", async () => {
  const client = createAdminClient("http://127.0.0.1:1");
  await assert.rejects(client.upload("/api/admin/media/movies/id/video", {
    localPath: "/unused/video.mp4", byteSize: Number.MAX_SAFE_INTEGER,
  }), error => error instanceof ImportRequestError && error.category === "content" && !error.fatal);
});
