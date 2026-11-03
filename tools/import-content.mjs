#!/usr/bin/env node
import { createInterface, emitKeypressEvents } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadAndValidateExport } from "./content-import/schema.mjs";
import { openProgressStore } from "./content-import/progress.mjs";
import { createAdminClient } from "./content-import/client.mjs";
import { importContent } from "./content-import/importer.mjs";

const HELP = `Usage: npm run import:content -- --json <export.json> --media-root <directory> --target <http(s)://origin> --admin-name <name>
Password: prompted without echo on a terminal, or read from the first line of stdin.
Progress: <export.json>.movie-harbor-import-progress.json; rerun the same command to resume.
Options: --json, --media-root, --target, --admin-name, --help
`;

// 解析并验证导入命令参数，供读取密码和访问目标前使用。
function parseArguments(argv) {
  const options = {};
  const names = new Set(["--json", "--media-root", "--target", "--admin-name", "--help"]);
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!names.has(name) || Object.hasOwn(options, name)) throw new Error("unknown or duplicate argument; use --help");
    if (name === "--help") { options[name] = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error("missing argument value; use --help");
    options[name] = value;
  }
  if (options["--help"]) return { help: true };
  for (const name of ["--json", "--media-root", "--target", "--admin-name"]) {
    if (!options[name]?.trim()) throw new Error(`missing ${name}; use --help`);
  }
  let target;
  try { target = new URL(options["--target"]); } catch { throw new Error("invalid target origin"); }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.pathname !== "/" || options["--target"].includes("?") || options["--target"].includes("#")) {
    throw new Error("target must be an HTTP(S) origin without credentials or path");
  }
  return { jsonPath: resolve(options["--json"]), mediaRoot: resolve(options["--media-root"]), targetOrigin: target.origin, adminName: options["--admin-name"] };
}

// 从终端或标准输入读取密码，并在退出时恢复终端状态和监听器。
export async function readPassword({ stdin = process.stdin, stderr = process.stderr, signals = process } = {}) {
  if (!stdin.isTTY) {
    const lines = createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });
    try {
      // 非交互输入只等待第一行；结束或错误会结算并关闭读取器。
      return await new Promise((accept, reject) => {
        lines.once("line", accept);
        // 无输入就结束时返回空密码，让调用方拒绝登录。
        lines.once("close", () => accept(""));
        // 输入读取失败时拒绝密码读取，避免继续导入。
        lines.once("error", () => reject(new Error("password input failed")));
      });
    } finally { lines.close(); stdin.pause(); }
  }
  const previousRaw = !!stdin.isRaw;
  let onKey, onEnd, onError, onSignal;
  try {
    stderr.write("管理员密码：");
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    // 交互输入逐键处理密码；回车、结束、错误或中断都会结束等待。
    return await new Promise((accept, reject) => {
      let password = "";
      // 输入提前结束时拒绝密码读取，避免把残缺凭据用于登录。
      onEnd = () => reject(new Error("password input ended before Enter"));
      // 终端输入出错时拒绝读取并进入统一资源清理。
      onError = () => reject(new Error("password input failed"));
      // 中断信号或取消按键终止密码输入，随后恢复终端状态。
      onSignal = () => reject(new Error("password input cancelled"));
      // 处理回车、删除和取消按键；普通字符只保存在内存中而不回显。
      onKey = (text, key = {}) => {
        if (key.ctrl && key.name === "c") return onSignal();
        if (key.ctrl && key.name === "d") return onEnd();
        if (key.name === "return" || key.name === "enter") return accept(password);
        if (key.name === "backspace") { password = [...password].slice(0, -1).join(""); return; }
        if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) password += text;
      };
      stdin.on("keypress", onKey);
      stdin.once("end", onEnd);
      stdin.once("error", onError);
      signals.once("SIGINT", onSignal);
      stdin.resume();
    });
  } finally {
    if (onKey) stdin.off("keypress", onKey);
    if (onEnd) stdin.off("end", onEnd);
    if (onError) stdin.off("error", onError);
    if (onSignal) signals.off("SIGINT", onSignal);
    stdin.setRawMode(previousRaw);
    stdin.pause();
    stderr.write("\n");
  }
}

// 执行导入命令：预检来源、加载进度、登录并汇总结果，同时隐藏密码。
export async function run(argv, dependencies = {}) {
  const deps = { readPassword, loadAndValidateExport, openProgressStore, createAdminClient, importContent, stdout: process.stdout, stderr: process.stderr, ...dependencies };
  let password = "";
  // 输出日志前替换密码，避免导入错误泄漏凭据。
  const safe = (value) => password ? String(value).split(password).join("[REDACTED]") : String(value);
  // 写入脱敏后的单行日志，供导入结果和错误报告使用。
  const write = (stream, value) => stream.write(`${safe(value)}\n`);
  try {
    const options = parseArguments(argv);
    if (options.help) { deps.stdout.write(HELP); return 0; }
    password = await deps.readPassword();
    if (typeof password !== "string" || !password.length) throw new Error("password must not be empty");
    // 先完整预检导出和媒体，再登录或写入，避免输入错误导致部分导入。
    const source = await deps.loadAndValidateExport(options.jsonPath, options.mediaRoot);
    const progress = await deps.openProgressStore({ path: `${options.jsonPath}.movie-harbor-import-progress.json`, targetOrigin: options.targetOrigin, sourceIdentity: source.identity });
    const client = deps.createAdminClient(options.targetOrigin);
    // 获取管理员会话和 CSRF 令牌；认证失败时不开始导入。
    await client.login(options.adminName, password);
    // 导入各阶段的日志统一经过脱敏输出，防止密码出现在成功或错误信息中。
    const logger = { info: (value) => write(deps.stdout, value), warn: (value) => write(deps.stdout, value), error: (value) => write(deps.stderr, value) };
    const result = await deps.importContent({ source, client, progress, logger });
    write(deps.stdout, `SUMMARY completed=${result.completed.length} resumed=${result.resumed.length} skipped=${result.skipped.length} failed=${result.failed.length}`);
    return result.failed.length === 0 ? 0 : 1;
  } catch (error) {
    write(deps.stderr, `ERROR ${error instanceof Error ? error.message : "import failed"}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
