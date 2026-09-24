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

export async function readPassword({ stdin = process.stdin, stderr = process.stderr, signals = process } = {}) {
  if (!stdin.isTTY) {
    const lines = createInterface({ input: stdin, terminal: false, crlfDelay: Infinity });
    try {
      return await new Promise((accept, reject) => {
        lines.once("line", accept);
        lines.once("close", () => accept(""));
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
    return await new Promise((accept, reject) => {
      let password = "";
      onEnd = () => reject(new Error("password input ended before Enter"));
      onError = () => reject(new Error("password input failed"));
      onSignal = () => reject(new Error("password input cancelled"));
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

export async function run(argv, dependencies = {}) {
  const deps = { readPassword, loadAndValidateExport, openProgressStore, createAdminClient, importContent, stdout: process.stdout, stderr: process.stderr, ...dependencies };
  let password = "";
  const safe = (value) => password ? String(value).split(password).join("[REDACTED]") : String(value);
  const write = (stream, value) => stream.write(`${safe(value)}\n`);
  try {
    const options = parseArguments(argv);
    if (options.help) { deps.stdout.write(HELP); return 0; }
    password = await deps.readPassword();
    if (typeof password !== "string" || !password.length) throw new Error("password must not be empty");
    const source = await deps.loadAndValidateExport(options.jsonPath, options.mediaRoot);
    const progress = await deps.openProgressStore({ path: `${options.jsonPath}.movie-harbor-import-progress.json`, targetOrigin: options.targetOrigin, sourceIdentity: source.identity });
    const client = deps.createAdminClient(options.targetOrigin);
    await client.login(options.adminName, password);
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
