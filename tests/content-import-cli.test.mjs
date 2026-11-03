import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAndValidateExport } from "../tools/content-import/schema.mjs";
import { run, readPassword } from "../tools/import-content.mjs";

const args = ["--json", "/source/export.json", "--media-root", "/source/media", "--target", "https://example.test/", "--admin-name", "admin"];
// 创建内存输出流，供断言 CLI 信息和密码脱敏使用。
function capture() { return { text: "", write(value) { this.text += value; } }; }
// 创建导入命令的可替换依赖，供参数、预检及错误场景使用。
function setup(overrides = {}) {
  const output = capture();
  const calls = [];
  const source = { identity: { exportedAt: "2026-09-24T00:00:00Z", sha256: "abc" }, movies: [], series: [] };
  return { output, calls, deps: {
    stdout: output, stderr: output,
    // 替身记录密码读取顺序并返回测试凭据，供预检顺序断言。
    readPassword: async () => { calls.push("password"); return "top-secret"; },
    // 替身记录来源预检并返回测试数据，供登录前预检断言。
    loadAndValidateExport: async () => { calls.push("preflight"); return source; },
    // 替身记录进度参数，供检查默认路径和来源绑定。
    openProgressStore: async (options) => { calls.push(["progress", options]); return {}; },
    // 替身登录记录管理员和密码，供确认调用顺序及参数。
    createAdminClient: () => ({ login: async (name, password) => { calls.push(["login", name, password]); } }),
    // 替身记录导入开始并返回统计，供 CLI 退出码测试。
    importContent: async () => { calls.push("import"); return { completed: [], resumed: [], skipped: [], failed: [] }; },
    ...overrides,
  } };
}

// 验证帮助选项不会提示输入密码或访问来源和目标。
test("help does not prompt or access source/target", async () => {
  const { deps, calls, output } = setup();
  assert.equal(await run(["--help"], deps), 0);
  assert.deepEqual(calls, []);
  assert.match(output.text, /--json/);
});

// 验证读取密码前拒绝缺失、重复、未知、位置及无值参数。
test("rejects missing, duplicate, unknown, positional and valueless arguments before password", async () => {
  for (const invalid of [[], args.slice(0, -2), [...args, "--json", "other"], [...args, "--password", "secret"], [...args, "positional"], ["--json", "--media-root", "x"], ["--help", "--help"], ["--help", "--unknown"]]) {
    const { deps, calls } = setup();
    assert.equal(await run(invalid, deps), 1, JSON.stringify(invalid));
    assert.deepEqual(calls, []);
  }
});

// 验证完整预检后规范化目标并使用默认进度，随后才登录。
test("normalizes target and uses default progress after complete preflight, before login", async () => {
  const { deps, calls, output } = setup();
  assert.equal(await run(args, deps), 0);
  assert.deepEqual(calls, ["password", "preflight", ["progress", {
    path: "/source/export.json.movie-harbor-import-progress.json",
    targetOrigin: "https://example.test", sourceIdentity: { exportedAt: "2026-09-24T00:00:00Z", sha256: "abc" },
  }], ["login", "admin", "top-secret"], "import"]);
  assert.doesNotMatch(output.text, /top-secret/);
});

// 验证无效目标来源在读取凭据前失败。
test("invalid origins fail before reading credentials", async () => {
  for (const target of ["https://u:p@example.test", "https://example.test/path", "ftp://example.test", "https://example.test?x"]) {
    const { deps, calls } = setup();
    const argv = [...args]; argv[5] = target;
    assert.equal(await run(argv, deps), 1);
    assert.deepEqual(calls, []);
  }
});

// 验证空密码和预检失败均阻止登录。
test("empty passwords and preflight failures prevent login", async () => {
  const empty = setup({ readPassword: async () => "" });
  assert.equal(await run(args, empty.deps), 1);
  assert.deepEqual(empty.calls, []);
  const invalid = setup({ loadAndValidateExport: async () => { throw new Error("invalid source"); } });
  assert.equal(await run(args, invalid.deps), 1);
  assert.deepEqual(invalid.calls, ["password"]);
});

// 验证空白题材在登录或创建进度前被真实来源预检拒绝。
test("blank genres fail real source preflight before login or progress creation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mh-cli-genres-"));
  // 测试结束时删除专属导出文件及媒体目录。
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jsonPath = join(directory, "export.json");
  await writeFile(jsonPath, JSON.stringify({ exported_at: "2026-09-24T00:00:00Z", series: [],
    movies: [{ name: "Film", synopsis: "", year: null, genres: [" \t"], poster_path: null, video_path: null, duration_seconds: null }] }));
  const { deps, calls, output } = setup({ loadAndValidateExport });
  const argv = [...args];
  argv[1] = jsonPath;
  argv[3] = directory;
  assert.equal(await run(argv, deps), 1);
  assert.deepEqual(calls, ["password"]);
  assert.match(output.text, /genres.*nonblank/);
});

// 验证跳过项可成功，内容失败返回失败，所有输出隐藏密码。
test("skips succeed, content failures fail, and all output redacts password", async () => {
  for (const failed of [[], [{ name: "failure" }]]) {
    const { deps, output } = setup({ importContent: async ({ logger }) => {
      logger.warn("SKIP top-secret");
      return { completed: [], resumed: [], skipped: [{ name: "existing" }], failed };
    } });
    assert.equal(await run(args, deps), failed.length ? 1 : 0);
    assert.match(output.text, /SKIP/);
    assert.match(output.text, /skipped=1/);
    assert.doesNotMatch(output.text, /top-secret/);
  }
  const { deps, output } = setup({ importContent: async () => { throw new Error("failed top-secret"); } });
  assert.equal(await run(args, deps), 1);
  assert.doesNotMatch(output.text, /top-secret/);
});

// 验证管道只读取一行密码且不回显。
test("pipe reads only one password line and never echoes it", async () => {
  const input = new PassThrough(); const output = capture();
  const pending = readPassword({ stdin: input, stderr: output });
  input.end("top-secret\r\nignored\n");
  assert.equal(await pending, "top-secret");
  assert.doesNotMatch(output.text, /top-secret|ignored/);
});

for (const outcome of ["enter", "eof", "ctrl-d", "ctrl-c", "signal", "error"]) {
  // 验证终端读取在各退出情形下恢复原始模式和监听器。
  test(`TTY restores raw mode and listeners on ${outcome}`, async () => {
    const input = new PassThrough(); input.isTTY = true; input.isRaw = false;
    // 记录终端模式切换，供确认密码读取结束时恢复原始模式。
    const modes = []; input.setRawMode = (raw) => { input.isRaw = raw; modes.push(raw); };
    const signals = new EventEmitter(); const output = capture();
    const pending = readPassword({ stdin: input, stderr: output, signals });
    input.write("secret\u007ft");
    if (outcome === "enter") input.write("\r");
    if (outcome === "eof") input.end();
    if (outcome === "ctrl-d") input.write("\u0004");
    if (outcome === "ctrl-c") input.write("\u0003");
    if (outcome === "signal") signals.emit("SIGINT");
    if (outcome === "error") input.emit("error", new Error("read failed"));
    if (outcome === "enter") assert.equal(await pending, "secret");
    else await assert.rejects(pending);
    assert.deepEqual(modes, [true, false]);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(input.listenerCount("keypress"), 0);
    assert.doesNotMatch(output.text, /secret/);
  });
}
