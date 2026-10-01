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

async function sandbox(t, name = "电影.mkv") {
  const directory = await mkdtemp(join(tmpdir(), "movie-conversion-"));
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
   for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
     fs.writeFileSync(process.env.SIGNAL_LOG, signal); process.exit(130);
   });
   fs.writeFileSync(process.env.READY_LOG, String(process.pid));
   setInterval(() => {}, 1000);
 } else if (process.env.MODE === 'fail') {
   process.stderr.write(process.env.DIAGNOSTIC || '转换诊断尾部'); process.exitCode = 9;
 }
}
`, { mode: 0o755 });
  return { directory, input, env, output: join(directory, name.slice(0, -4) + ".movie-harbor.mp4") };
}

function launch(args, env, nodeArguments = []) {
  const child = spawn(process.execPath, [...nodeArguments, entry, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const finished = new Promise((resolveResult, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
  return { child, finished };
}
const absent = async (path) => assert.rejects(access(path), { code: "ENOENT" });
const noTemporary = async (directory) => assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp.mp4")), []);

// Breakage caught: removing listeners on child close leaves the publication/cleanup window unprotected.
for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} after FFmpeg close prevents publication and cleans the temporary file`, async (t) => {
    const s = await sandbox(t);
    const gate = join(s.directory, "publication-ready");
    const preload = join(s.directory, "publication-gate.mjs");
    await writeFile(preload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.promises.lstat;
fs.promises.lstat = async (...args) => {
  if (String(args[0]).endsWith('.tmp.mp4')) {
    fs.writeFileSync(${JSON.stringify(gate)}, 'ready');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return original(...args);
};
syncBuiltinESMExports();
`);
    const { child, finished } = launch([s.input], s.env, ["--import", preload]);
    t.after(() => child.kill("SIGKILL"));
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await access(gate); ready = true; break; }
      catch (error) { if (error.code !== "ENOENT") throw error; await delay(30); }
    }
    assert.ok(ready, "post-close temporary-file validation must be reached");
    child.kill(signal);
    const result = await finished;
    assert.equal(result.code, 1, `must return CLI error instead of default signal termination: ${result.signal}`);
    assert.match(result.stderr, new RegExp(`已中断.*${signal}`));
    await absent(s.output); await noTemporary(s.directory);
    assert.equal(await readFile(s.input, "utf8"), "original");
  });
}

// Breakage caught: help/invalid arguments must never start external programs.
test("help and invalid arguments stop before external programs", async (t) => {
  const s = await sandbox(t);
  for (const [args, code] of [[['--help'], 0], [[], 2], [[s.input, s.input], 2], [['--unknown'], 2], [[join(s.directory, 'movie.avi')], 2]]) {
    const result = await launch(args, s.env).finished;
    assert.equal(result.code, code, result.stderr);
  }
  await absent(s.env.PROBE_LOG); await absent(s.env.FFMPEG_LOG); await absent(s.env.ENCODER_LOG);
});

// Breakage caught: filesystem preflight must precede probe and preserve existing output.
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
test("failed FFmpeg cleans temporary output and reports diagnostics", async (t) => {
  const s = await sandbox(t); s.env.MODE = "fail";
  const result = await launch([s.input], s.env).finished;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /转换诊断尾部/);
  await absent(s.output); await noTemporary(s.directory);
});

// Breakage caught: missing programs and required encoders must produce actionable errors.
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
  test(`${signal} reaches FFmpeg and cleans its partial output`, async (t) => {
    const s = await sandbox(t); s.env.MODE = "wait";
    const { child, finished } = launch([s.input], s.env);
    t.after(() => { child.kill("SIGKILL"); });
    let pid;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { pid = Number(await readFile(s.env.READY_LOG, "utf8")); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; await delay(30); }
    }
    assert.ok(pid, "FFmpeg must be ready before sending a signal");
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
test("unknown duration reports processed time without a percentage", async (t) => {
  const s = await sandbox(t); s.env.FIXTURE = JSON.stringify({ streams: fixture.streams });
  const result = await launch([s.input], s.env).finished;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已处理.*5/); assert.doesNotMatch(result.stdout, /%/);
});

// Breakage caught: failure output must not retain unbounded early diagnostics.
test("long stderr retains only the final diagnostic tail", async (t) => {
  const s = await sandbox(t); s.env.MODE = "fail";
  s.env.DIAGNOSTIC = "EARLY_MARKER" + "x".repeat(25_000) + "TAIL_MARKER";
  const result = await launch([s.input], s.env).finished;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /TAIL_MARKER/); assert.doesNotMatch(result.stderr, /EARLY_MARKER/);
  assert.ok(Buffer.byteLength(result.stderr) < 17_000);
});

// Breakage caught: probe output overflow or invalid media must stop before conversion.
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
test("microsecond progress clamps underflow and overflow", async (t) => {
  const s = await sandbox(t);
  s.env.PROGRESS = "out_time_us=-1000000\nprogress=continue\nout_time_us=20000000\nprogress=end\n";
  const result = await launch([s.input], s.env).finished;
  assert.equal(result.code, 0); assert.match(result.stdout, /进度：0%/); assert.match(result.stdout, /进度：100%/);
  assert.doesNotMatch(result.stdout, /200%|-[0-9]+%/);
});

// Breakage caught: callable run must return errors and preserve its host process.
test("run returns errors without terminating its caller and cleans signal listeners", async (t) => {
  const { run } = await import("../tools/convert-video.mjs");
  const { probeMedia, executeConversion } = await import("../tools/video-conversion/execute.mjs");
  const { buildConversionPlan } = await import("../tools/video-conversion/plan.mjs");
  const s = await sandbox(t); s.env.MODE = "fail";
  const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  let diagnostics = "";
  const code = await run([s.input], {
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
    { env: s.env, onProgress() { throw new Error("progress sink failed"); } }), /progress sink failed/);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], listeners);
  await absent(s.output); await noTemporary(s.directory);
});
