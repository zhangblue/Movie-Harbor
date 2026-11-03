import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir, access, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const entry = resolve("tools/convert-video.mjs");
const fixture = { format: { duration: "10" }, streams: [
  { index: 0, codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p", disposition: {} },
] };

// 创建隔离的视频、模拟工具和清理钩子，供转换 CLI 测试使用。
async function sandbox(t, name = "电影.mkv") {
  const directory = await mkdtemp(join(tmpdir(), "movie-conversion-"));
  // 测试结束后删除专属视频及模拟程序，失败时也释放临时目录。
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  const input = join(directory, name);
  await writeFile(input, "original");
  const env = { ...process.env, PATH: bin, FIXTURE: JSON.stringify(fixture),
    PROBE_LOG: join(directory, "probe.log"), FFMPEG_LOG: join(directory, "ffmpeg.log"),
    ENCODER_LOG: join(directory, "encoders.log"),
    SIGNAL_LOG: join(directory, "signal.log"), READY_LOG: join(directory, "ready.log"),
    ENCODERS: " V..... libx264 H264\n A..... aac AAC\n S..... mov_text text\n" };
  const header = `#!${process.execPath}\n`;
  await writeFile(join(bin, "ffprobe"), header + `
const fs = require('node:fs');
fs.writeFileSync(process.env.PROBE_LOG, JSON.stringify(process.argv.slice(2)));
if (process.env.PROBE_LARGE) process[process.env.PROBE_LARGE].write('x'.repeat(5 * 1024 * 1024));
else if (process.env.PROBE_FAIL) { process.stderr.write('probe damaged'); process.exitCode = 3; }
else process.stdout.write(process.env.FIXTURE);
`, { mode: 0o755 });
  await writeFile(join(bin, "ffmpeg"), header + `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('-encoders')) {
 fs.writeFileSync(process.env.ENCODER_LOG, JSON.stringify(args));
 process.stdout.write(process.env.ENCODERS);
}
else {
 fs.writeFileSync(process.env.FFMPEG_LOG, JSON.stringify(args));
 const output = args.at(-1);
 if (process.env.MODE === 'directory') fs.mkdirSync(output);
 else if (process.env.MODE !== 'no-output') fs.writeFileSync(output, 'converted');
 process.stdout.write(process.env.PROGRESS || 'out_time_ms=5000000\\nprogress=continue\\n');
 if (process.env.RACE_OUTPUT) fs.writeFileSync(process.env.RACE_OUTPUT, 'competitor');
 if (process.env.MODE === 'wait') {
   // 模拟 FFmpeg 接收中断后记录信号并退出，供检查转发和清理。
   for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
     fs.writeFileSync(process.env.SIGNAL_LOG, signal); process.exit(130);
   });
   fs.writeFileSync(process.env.READY_LOG, String(process.pid));
   // 让模拟 FFmpeg 保持运行，直到测试发出中断。
   setInterval(() => {}, 1000);
 } else if (process.env.MODE === 'fail') {
   process.stderr.write(process.env.DIAGNOSTIC || '转换诊断尾部'); process.exitCode = 9;
 }
}
`, { mode: 0o755 });
  return { directory, input, env, output: join(directory, name.slice(0, -4) + ".movie-harbor.mp4") };
}

// 启动转换 CLI 子进程，供信号传递和输出断言使用。
function launch(args, env, nodeArguments = []) {
  // 启动真实转换 CLI 子进程，供信号、退出码和输出测试使用。
  const child = spawn(process.execPath, [...nodeArguments, entry, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  // 收集子进程标准输出，供进度与成功消息断言。
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  // 收集子进程标准错误，供失败诊断与信号断言。
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // 等待进程错误或关闭后返回退出状态和收集的输出。
  const finished = new Promise((resolveResult, reject) => {
    child.on("error", reject);
    // 进程关闭后返回退出码、信号和输出，保证断言读取完整结果。
    child.on("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
  return { child, finished };
}
// 断言指定路径不存在，供失败后清理检查使用。
const absent = async (path) => assert.rejects(access(path), { code: "ENOENT" });
// 断言目录中没有转换临时 MP4，供失败和中断场景使用。
const noTemporary = async (directory) => assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp.mp4")), []);

// Breakage caught: removing listeners on child close leaves the publication/cleanup window unprotected.
for (const signal of ["SIGINT", "SIGTERM"]) {
  // 验证FFmpeg 关闭后收到中断信号时不发布并清理临时文件。
  test(`${signal} after FFmpeg close prevents publication and cleans the temporary file`, { timeout: 10_000 }, async (t) => {
    const s = await sandbox(t);
    const gate = join(s.directory, "publication-ready");
    const signalHandled = join(s.directory, "publication-signal-handled");
    const release = join(s.directory, "publication-release");
    const preload = join(s.directory, "publication-gate.mjs");
    await writeFile(preload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const original = fs.promises.lstat;
const originalEmit = process.emit;
// 测试预加载脚本观察信号分发并写入握手文件，不新增信号监听器。
process.emit = function(event, ...args) {
  const result = originalEmit.call(this, event, ...args);
  if (event === 'SIGINT' || event === 'SIGTERM') {
    fs.writeFileSync(${JSON.stringify(signalHandled)}, event);
  }
  return result;
};
// 测试预加载脚本在临时文件校验处等待握手，重现关闭后发布前的信号窗口。
fs.promises.lstat = async (...args) => {
  if (String(args[0]).endsWith('.tmp.mp4')) {
    fs.writeFileSync(${JSON.stringify(gate)}, 'ready');
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await fs.promises.access(${JSON.stringify(release)}); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (Date.now() >= deadline) throw new Error('publication release handshake timed out');
      await delay(10);
    }
  }
  return original(...args);
};
syncBuiltinESMExports();
`);
    const { child, finished } = launch([s.input], s.env, ["--import", preload]);
    // 设置超时兜底以终止卡住的进程，防止测试永久阻塞。
    const emergency = setTimeout(() => child.kill("SIGKILL"), 8000);
    // 测试结束时取消兜底定时器、终止进程并等待退出。
    t.after(async () => { clearTimeout(emergency); child.kill("SIGKILL"); await finished; });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await access(gate); ready = true; break; }
      catch (error) { if (error.code !== "ENOENT") throw error; await delay(30); }
    }
    assert.ok(ready, "post-close temporary-file validation must be reached");
    child.kill(signal);
    let acknowledged = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try { await access(signalHandled); acknowledged = true; break; }
      catch (error) { if (error.code !== "ENOENT") throw error; await delay(30); }
    }
    // Observing process.emit adds no signal listener: missing production protection still terminates the CLI.
    if (acknowledged) {
      assert.equal(await readFile(signalHandled, "utf8"), signal);
      await writeFile(release, "release");
    } else {
      child.kill("SIGKILL");
    }
    const result = await finished;
    assert.equal(result.code, 1, `must return CLI error instead of default signal termination: ${result.signal}`);
    assert.match(result.stderr, new RegExp(`已中断.*${signal}`));
    await absent(s.output); await noTemporary(s.directory);
    assert.equal(await readFile(s.input, "utf8"), "original");
  });
}

// Breakage caught: help/invalid arguments must never start external programs.
// 验证帮助和无效参数在运行外部程序前结束。
test("help and invalid arguments stop before external programs", async (t) => {
  const s = await sandbox(t);
  for (const [args, code] of [[['--help'], 0], [[], 2], [[s.input, s.input], 2], [['--unknown'], 2], [[join(s.directory, 'movie.avi')], 2]]) {
    const result = await launch(args, s.env).finished;
    assert.equal(result.code, code, result.stderr);
  }
  await absent(s.env.PROBE_LOG); await absent(s.env.FFMPEG_LOG); await absent(s.env.ENCODER_LOG);
});

// Breakage caught: filesystem preflight must precede probe and preserve existing output.
// 验证输入缺失、输入是目录或输出已存在时不执行探测。
test("missing input, directories and existing output stop before probe", async (t) => {
  const s = await sandbox(t);
  await mkdir(join(s.directory, "directory.mkv"));
  await writeFile(s.output, "existing");
  for (const input of [join(s.directory, "absent.mkv"), join(s.directory, "directory.mkv"), s.input]) {
    const result = await launch([input], s.env).finished;
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /ERROR/);
  }
  assert.equal(await readFile(s.output, "utf8"), "existing");
  await absent(s.env.PROBE_LOG); await absent(s.env.FFMPEG_LOG); await absent(s.env.ENCODER_LOG);
});

// Breakage caught: shell interpolation/splitting and direct writes to final output.
// 验证特殊路径保持单个参数，成功输出从临时 MP4 发布。
test("special paths stay one argument and successful output is published from a temporary MP4", async (t) => {
  const s = await sandbox(t, "中文 空格 ' ; $(touch injected).MKV");
  const result = await launch([s.input], s.env).finished;
  assert.equal(result.code, 0, result.stderr);
  const args = JSON.parse(await readFile(s.env.FFMPEG_LOG, "utf8"));
  assert.equal(args[args.indexOf("-i") + 1], s.input);
  assert.notEqual(args.at(-1), s.output);
  assert.match(args.at(-1), /\.tmp\.mp4$/);
  assert.equal(await readFile(s.output, "utf8"), "converted");
  assert.equal(await readFile(s.input, "utf8"), "original");
  assert.match(result.stdout, /完成：/);
  assert.match(result.stdout, /50%/);
  await absent(s.env.ENCODER_LOG);
  await noTemporary(s.directory);
  await absent(join(s.directory, "injected"));
});

// Breakage caught: a forbidden image subtitle must fail before any FFmpeg invocation.
// 验证执行 FFmpeg 前拒绝 PGS 并报告轨道和编码。
test("PGS is rejected with track and codec before FFmpeg", async (t) => {
  const s = await sandbox(t);
  s.env.FIXTURE = JSON.stringify({ ...fixture, streams: [...fixture.streams,
    { index: 7, codec_type: "subtitle", codec_name: "hdmv_pgs_subtitle" }] });
  const result = await launch([s.input], s.env).finished;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /7.*hdmv_pgs_subtitle/);
  await access(s.env.PROBE_LOG); await absent(s.env.FFMPEG_LOG); await absent(s.env.ENCODER_LOG);
});

// Breakage caught: failed FFmpeg must remove partial files and expose its diagnostic.
// 验证FFmpeg 失败时清理临时输出并报告诊断。
test("failed FFmpeg cleans temporary output and reports diagnostics", async (t) => {
  const s = await sandbox(t); s.env.MODE = "fail";
  const result = await launch([s.input], s.env).finished;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /转换诊断尾部/);
  await absent(s.output); await noTemporary(s.directory);
});

// Breakage caught: missing programs and required encoders must produce actionable errors.
// 验证缺少 FFprobe 或所需 libx264 时阻止转换。
test("missing FFprobe and required libx264 prevent conversion", async (t) => {
  const s = await sandbox(t);
  await rm(join(s.directory, "bin", "ffprobe"));
  let result = await launch([s.input], s.env).finished;
  assert.equal(result.code, 1); assert.match(result.stderr, /安装 FFmpeg/);
  await absent(s.env.FFMPEG_LOG);
  const other = await sandbox(t);
  other.env.FIXTURE = JSON.stringify({ ...fixture, streams: [{ ...fixture.streams[0], codec_name: "hevc" }] });
  other.env.ENCODERS = " A..... aac AAC\n";
  result = await launch([other.input], other.env).finished;
  assert.equal(result.code, 1); assert.match(result.stderr, /缺少.*libx264/);
  await absent(other.env.FFMPEG_LOG);
});

// Breakage caught: interrupted conversion must forward the signal and clean partial output.
for (const signal of ["SIGINT", "SIGTERM"]) {
  // 验证中断信号传递给 FFmpeg 并清理部分输出。
  test(`${signal} reaches FFmpeg and cleans its partial output`, async (t) => {
    const s = await sandbox(t); s.env.MODE = "wait";
    const { child, finished } = launch([s.input], s.env);
    // 测试结束时强制清理可能仍在运行的转换进程。
    t.after(() => { child.kill("SIGKILL"); });
    let pid;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { pid = Number(await readFile(s.env.READY_LOG, "utf8")); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; await delay(30); }
    }
    assert.ok(pid, "FFmpeg must be ready before sending a signal");
    // 设置子进程兜底终止定时器，防止信号测试悬挂。
    const emergency = setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch {} }, 1500);
    try {
      child.kill(signal);
      const result = await finished;
      assert.equal(result.code, 1, result.stderr);
      assert.equal(await readFile(s.env.SIGNAL_LOG, "utf8"), signal);
      await absent(s.output); await noTemporary(s.directory);
    } finally { clearTimeout(emergency); try { process.kill(pid, "SIGKILL"); } catch {} }
  });
}

// Breakage caught: progress must remain meaningful when duration is unknown.
// 验证未知时长显示已处理时间而不显示百分比。
test("unknown duration reports processed time without a percentage", async (t) => {
  const s = await sandbox(t); s.env.FIXTURE = JSON.stringify({ streams: fixture.streams });
  const result = await launch([s.input], s.env).finished;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已处理.*5/); assert.doesNotMatch(result.stdout, /%/);
});

// Breakage caught: failure output must not retain unbounded early diagnostics.
// 验证过长标准错误仅保留末尾诊断。
test("long stderr retains only the final diagnostic tail", async (t) => {
  const s = await sandbox(t); s.env.MODE = "fail";
  s.env.DIAGNOSTIC = "EARLY_MARKER" + "x".repeat(25_000) + "TAIL_MARKER";
  const result = await launch([s.input], s.env).finished;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /TAIL_MARKER/); assert.doesNotMatch(result.stderr, /EARLY_MARKER/);
  assert.ok(Buffer.byteLength(result.stderr) < 17_000);
});

// Breakage caught: probe output overflow or invalid media must stop before conversion.
// 验证探测失败、JSON 无效、视频缺失及输出过大均阻止转换。
test("probe failures, invalid JSON, missing video and oversized outputs stop conversion", async (t) => {
  for (const changes of [{ PROBE_FAIL: "1" }, { FIXTURE: "not-json" }, { FIXTURE: '{"streams":[]}' },
    { PROBE_LARGE: "stdout" }, { PROBE_LARGE: "stderr" }]) {
    const s = await sandbox(t); Object.assign(s.env, changes);
    const result = await launch([s.input], s.env).finished;
    assert.equal(result.code, 1); assert.match(result.stderr, /ERROR/);
    await absent(s.env.FFMPEG_LOG); await absent(s.output);
  }
});

// Breakage caught: a concurrent output creator or dangling symlink must never be overwritten.
// 验证原子发布拒绝并发创建的目标和悬空符号链接。
test("atomic publication rejects concurrent output creation and dangling symlinks", async (t) => {
  const s = await sandbox(t); s.env.RACE_OUTPUT = s.output;
  const result = await launch([s.input], s.env).finished;
  assert.equal(result.code, 1); assert.match(result.stderr, /目标已存在/);
  assert.equal(await readFile(s.output, "utf8"), "competitor"); await noTemporary(s.directory);
  const other = await sandbox(t);
  await symlink(join(other.directory, "missing"), other.output);
  const blocked = await launch([other.input], other.env).finished;
  assert.equal(blocked.code, 1); await absent(other.env.PROBE_LOG);
});

// Breakage caught: unknown subtitles must reach conversion and report FFmpeg rejection.
// 验证未知字幕转换失败时保留诊断并清理输出。
test("unknown subtitle conversion errors preserve diagnostics and clean output", async (t) => {
  const s = await sandbox(t); s.env.MODE = "fail"; s.env.DIAGNOSTIC = "unsupported subtitle encoding";
  s.env.FIXTURE = JSON.stringify({ ...fixture, streams: [...fixture.streams,
    { index: 4, codec_type: "subtitle", codec_name: "unknown-text" }] });
  const result = await launch([s.input], s.env).finished;
  assert.equal(result.code, 1); assert.match(result.stderr, /unsupported subtitle encoding/);
  const args = JSON.parse(await readFile(s.env.FFMPEG_LOG, "utf8"));
  assert.ok(args.includes("mov_text")); await absent(s.output); await noTemporary(s.directory);
});

// Breakage caught: missing FFmpeg must fail cleanly both for copy and encoder-list plans.
// 验证缺少 FFmpeg 时报告错误且不留下输出。
test("missing FFmpeg is reported and never leaves output", async (t) => {
  for (const codec of ["h264", "hevc"]) {
    const s = await sandbox(t);
    await rm(join(s.directory, "bin", "ffmpeg"));
    s.env.FIXTURE = JSON.stringify({ ...fixture, streams: [{ ...fixture.streams[0], codec_name: codec }] });
    const result = await launch([s.input], s.env).finished;
    assert.equal(result.code, 1); assert.match(result.stderr, /ffmpeg.*安装 FFmpeg/);
    await absent(s.output); await noTemporary(s.directory);
  }
});

// Breakage caught: missing/nonregular output must not be published; cleanup failure must coexist with main error.
// 验证进程成功但无普通输出时拒绝发布，并合并清理错误。
test("successful process without a regular output is refused and cleanup errors are combined", async (t) => {
  const missing = await sandbox(t); missing.env.MODE = "no-output";
  const result = await launch([missing.input], missing.env).finished;
  assert.equal(result.code, 1); assert.match(result.stderr, /未生成普通临时文件/);
  await absent(missing.output); await noTemporary(missing.directory);
  const directory = await sandbox(t); directory.env.MODE = "directory";
  const invalid = await launch([directory.input], directory.env).finished;
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /普通临时文件/); assert.match(invalid.stderr, /无法清理临时文件/);
  assert.match(invalid.stderr, /\.tmp\.mp4/); await absent(directory.output);
});

// Breakage caught: microsecond progress must clamp finite percentages into 0..100.
// 验证微秒进度的上下溢被限制在有效范围内。
test("microsecond progress clamps underflow and overflow", async (t) => {
  const s = await sandbox(t);
  s.env.PROGRESS = "out_time_us=-1000000\nprogress=continue\nout_time_us=20000000\nprogress=end\n";
  const result = await launch([s.input], s.env).finished;
  assert.equal(result.code, 0); assert.match(result.stdout, /进度：0%/); assert.match(result.stdout, /进度：100%/);
  assert.doesNotMatch(result.stdout, /200%|-[0-9]+%/);
});

// Breakage caught: callable run must return errors and preserve its host process.
// 验证运行入口返回错误而不终止调用方，并清理信号监听器。
test("run returns errors without terminating its caller and cleans signal listeners", async (t) => {
  const { run } = await import("../tools/convert-video.mjs");
  const { probeMedia, executeConversion } = await import("../tools/video-conversion/execute.mjs");
  const { buildConversionPlan } = await import("../tools/video-conversion/plan.mjs");
  const s = await sandbox(t); s.env.MODE = "fail";
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  let diagnostics = "";
  const code = await run([s.input], {
    // 用内存输出替身捕获错误诊断，避免测试写入真实终端。
    stdout: { write() {} }, stderr: { write(text) { diagnostics += text; } },
    probeMedia: (input) => probeMedia(input, { env: s.env }),
    executeConversion: (conversion, options) => executeConversion(conversion, { ...options, env: s.env }),
  });
  assert.equal(code, 1); assert.match(diagnostics, /转换诊断尾部/);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
  await absent(s.output); await noTemporary(s.directory);
  // A progress consumer throwing must still stop/reap FFmpeg and remove its output.
  const media = await probeMedia(s.input, { env: s.env });
  s.env.MODE = "wait";
  await assert.rejects(executeConversion({ inputPath: s.input, outputPath: s.output, media, plan: buildConversionPlan(media) },
    // 进度回调故意抛错，验证转换进程仍会停止并清理临时文件。
    { env: s.env, onProgress() { throw new Error("progress sink failed"); } }), /progress sink failed/);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
  await absent(s.output); await noTemporary(s.directory);
});
