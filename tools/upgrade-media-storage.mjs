import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readFileSync, realpathSync, unlinkSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseDotenvMediaHostDir, parseMediaHostDirs, readVolumeMarker, writeAtomically } from "./storage-compose.mjs";

const STATE = ".movie-harbor-storage-state.json";

// Only fixed, checked-in code executes in the fixed Alpine image. Paths and the
// pending operation ID are separate argv entries, never shell interpolation.
const UPGRADE_SCRIPT = String.raw`
set -eu
die() { echo "$1" >&2; exit 1; }
identity() { stat -Lc '%d:%i' "$1"; }
[ ! -L "/parent/$1" ] && [ -d "/parent/$1" ] || die 'media root is not a plain directory'
exec 3</volume
flock -n 3 || die 'another media upgrade is running'
[ "$(identity "/parent/$1")" = "$(identity /proc/self/fd/3)" ] || die 'media root changed during mount'
cd /proc/self/fd/3
legacy=false
for name in .incoming .quarantine .operations video poster; do
  if [ ! -L "$name" ] && [ -d "$name" ]; then legacy=true; fi
done
[ "$legacy" = true ] || die 'no legacy media structure; refusing an empty or unrelated mount point'
marker=.movie-harbor-volume.json
temporary=.movie-harbor-upgrade-$2.tmp
has_temporary=false
if [ -e "$temporary" ] || [ -L "$temporary" ]; then
  [ ! -L "$temporary" ] && [ -f "$temporary" ] || die 'unsafe upgrade temporary file'
  [ "$(stat -c '%u' "$temporary")" = 0 ] || die 'unexpected upgrade temporary owner'
  has_temporary=true
fi
has_marker=false
if [ -e "$marker" ] || [ -L "$marker" ]; then
  [ ! -L "$marker" ] && [ -f "$marker" ] || die 'marker is not a plain regular file'
  [ "$(stat -c '%s' "$marker")" -le 4096 ] || die 'marker is too large'
  before=$(identity "$marker")
  exec 4<"$marker"
  [ ! -L "$marker" ] && [ -f "$marker" ] && [ "$before" = "$(identity /proc/self/fd/4)" ] && [ "$before" = "$(identity "$marker")" ] || die 'marker changed while opening'
  links=$(stat -Lc '%h' /proc/self/fd/4)
  if [ "$links" != 1 ]; then
    [ "$links" = 2 ] && [ "$has_temporary" = true ] && [ "$before" = "$(identity "$temporary")" ] || die 'marker has foreign hard links'
  fi
  has_marker=true
  printf 'READY\t'; base64 /proc/self/fd/4 | tr -d '\n'; printf '\n'
else
  printf 'READY\t-\n'
fi
IFS= read -r decision
[ "$decision" = COMMIT ] || die 'upgrade was not authorized'
[ ! -L "/parent/$1" ] && [ "$(identity "/parent/$1")" = "$(identity /proc/self/fd/3)" ] || die 'media root changed before commit'
if [ "$has_temporary" = true ]; then
  if [ "$has_marker" = true ]; then
    [ "$(identity "$temporary")" = "$(identity /proc/self/fd/4)" ] || die 'unrelated upgrade temporary file'
  else
    [ "$(stat -c '%h' "$temporary")" = 1 ] || die 'temporary file has foreign hard links'
  fi
  rm -- "$temporary"
fi
if [ "$has_marker" = false ]; then
  (set -C; umask 077; printf '{"version":1,"volume":0}' > "$temporary")
  chmod 0644 "$temporary"
  sync "$temporary"
  exec 4<"$temporary"
  ln -T "$temporary" "$marker"
  rm -- "$temporary"
  sync .
fi
[ ! -L "$marker" ] && [ -f "$marker" ] && [ "$(identity "$marker")" = "$(identity /proc/self/fd/4)" ] || die 'marker changed before permissions update'
[ "$(stat -Lc '%h' /proc/self/fd/4)" = 1 ] || die 'marker has foreign hard links'
chmod 0644 /proc/self/fd/4
chown 10001:10001 /proc/self/fd/3
chmod 0711 /proc/self/fd/3
sync /proc/self/fd/4
sync .
printf 'DONE\n'
`;

function readState(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16_384) throw new Error("invalid state file");
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("media registration is damaged; restore a trusted backup", { cause: error });
  } finally { if (fd !== undefined) closeSync(fd); }
}

function rootIdentity(directory) {
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("media root must be a plain directory");
  return { device: String(stat.dev), inode: String(stat.ino) };
}

function requirePending(value, directory, identity) {
  const upgrade = value?.upgrade;
  if (!value || Object.keys(value).length !== 3 || value.version !== 1 ||
      !Array.isArray(value.directories) || value.directories.length !== 1 ||
      value.directories[0] !== directory || !upgrade || Object.keys(upgrade).length !== 5 ||
      upgrade.kind !== "legacy-volume-zero" || !/^[a-f0-9]{32}$/.test(upgrade.id) ||
      typeof upgrade.markerAllowed !== "boolean" ||
      upgrade.device !== identity.device || upgrade.inode !== identity.inode) {
    throw new Error("registration is not a matching pending legacy upgrade; refusing to replace paths or upgrade a normal deployment");
  }
}

function createPending(statePath, pending) {
  const temporary = `${statePath}.${pending.upgrade.id}.pending`;
  writeAtomically(temporary, `${JSON.stringify(pending, null, 2)}\n`);
  try { linkSync(temporary, statePath); } finally { unlinkSync(temporary); }
  const fd = openSync(path.dirname(statePath), "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function runUpgradeContainer(directory, operationId, allowExisting, authorizeMarker) {
  // Docker --mount parses CSV; quote the entire source field to preserve commas.
  const mount = (source, target, readOnly = false) => `type=bind,"src=${source.replaceAll('"', '""')}",dst=${target}${readOnly ? ",readonly" : ""}`;
  const args = ["run", "--rm", "--init", "--interactive", "--user", "0:0", "--network", "none", "--read-only",
    "--mount", mount(path.dirname(directory), "/parent", true),
    "--mount", mount(directory, "/volume"),
    "alpine:3.22", "timeout", "-s", "KILL", "50", "sh", "-c", UPGRADE_SCRIPT, "upgrade", path.basename(directory), operationId];
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    let failure, killTimer, ready = false, done = false, stderr = "", bytes = 0;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      child.stdin.destroy();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const timeout = setTimeout(() => stop(new Error("upgrade container timed out; pending registration retained")), 60_000);
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.stdout.on("data", (chunk) => { bytes += chunk.length; if (bytes > 8192) stop(new Error("invalid upgrade response")); });
    child.stdin.on("error", stop);
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (failure) return;
      try {
        if (!ready && line.startsWith("READY\t")) {
          ready = true;
          const encoded = line.slice(6);
          if (encoded !== "-") {
            if (!allowExisting) throw new Error("existing marker without registration; restore a trusted backup");
            const marker = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
            if (!marker || Object.keys(marker).length !== 2 || marker.version !== 1 || marker.volume !== 0) {
              throw new Error("existing marker identity does not match volume zero");
            }
          }
          authorizeMarker();
          child.stdin.end("COMMIT\n");
        } else if (ready && !done && line === "DONE") done = true;
        else throw new Error("invalid upgrade container response");
      } catch (error) { stop(error); }
    });
    child.on("error", stop);
    child.on("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      if (failure || code !== 0 || !done) reject(failure ?? new Error(`upgrade container failed; pending registration retained: ${stderr.trim() || code}`));
      else resolve();
    });
  });
}

async function main(args) {
  let envFile = ".env", confirmed = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--confirm-existing-volume-zero") confirmed = true;
    else if (args[index] === "--env" && args[index + 1]) envFile = args[++index];
    else throw new Error(`unknown or incomplete argument: ${args[index]}`);
  }
  if (!confirmed) throw new Error("explicit confirmation required: --confirm-existing-volume-zero");
  const envPath = path.resolve(envFile);
  const directories = parseMediaHostDirs(parseDotenvMediaHostDir(envPath), { baseDirectory: path.dirname(envPath) });
  if (directories.length !== 1) throw new Error("legacy upgrade requires exactly one existing media directory");
  const directory = realpathSync(directories[0]);
  if (directory === path.parse(directory).root) throw new Error("filesystem root cannot be a media upgrade target");
  const identity = rootIdentity(directory);
  const statePath = path.join(path.dirname(envPath), STATE);
  let pending = readState(statePath);
  if (pending) requirePending(pending, directory, identity);
  else {
    const generated = path.resolve(process.env.MOVIE_HARBOR_STORAGE_COMPOSE_OUTPUT ?? "compose.storage.generated.json");
    try { lstatSync(generated); throw new Error("generated storage configuration exists without registration; restore a trusted backup"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    pending = { version: 1, directories: [directory], upgrade: { kind: "legacy-volume-zero", id: randomBytes(16).toString("hex"), ...identity, markerAllowed: false } };
    createPending(statePath, pending);
  }
  await runUpgradeContainer(directory, pending.upgrade.id, pending.upgrade.markerAllowed, () => {
    const current = readState(statePath);
    requirePending(current, directory, rootIdentity(directory));
    if (current.upgrade.id !== pending.upgrade.id) throw new Error("upgrade registration changed while running");
    if (!current.upgrade.markerAllowed) {
      pending.upgrade.markerAllowed = true;
      writeAtomically(statePath, `${JSON.stringify(pending, null, 2)}\n`);
    }
  });
  requirePending(readState(statePath), directory, rootIdentity(directory));
  if (readState(statePath).upgrade.id !== pending.upgrade.id) throw new Error("upgrade registration changed while running");
  readVolumeMarker(directory, 0);
  writeAtomically(statePath, `${JSON.stringify({ version: 1, directories: [directory] }, null, 2)}\n`);
  process.stdout.write("媒体卷 0 升级完成。请运行 ./tools/start-compose.sh 启动应用。\n");
}

main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
