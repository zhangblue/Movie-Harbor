import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const VOLUME_MARKER = ".movie-harbor-volume.json";
const REGISTRATION_STATE = ".movie-harbor-storage-state.json";

function fail(message) {
  throw new Error(`Invalid MEDIA_HOST_DIR: ${message}`);
}

function pathForNoFollowCheck(value) {
  const root = path.parse(value).root;
  let checked = value;
  while (checked.length > root.length && checked.endsWith(path.sep)) {
    checked = checked.slice(0, -path.sep.length);
  }
  return checked;
}

function verifyHostDirectory(value) {
  let stat;
  try {
    stat = lstatSync(pathForNoFollowCheck(value));
  } catch {
    fail("directory does not exist");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("entry is not a directory");
  return value;
}

/**
 * Parses a deployment MEDIA_HOST_DIR value without evaluating dotenv syntax.
 * The retained relative single-directory form supports the checked-in local default.
 */
export function parseMediaHostDirs(
  value,
  { baseDirectory = process.cwd(), requireExisting = true } = {},
) {
  if (typeof value !== "string") fail("must be set");
  const entries = value.split(";").map((entry) => entry.trim());
  if (entries.length === 0 || entries.some((entry) => !entry)) fail("empty directory entry");

  const directories = entries.map((entry, index) => {
    if (!entry) fail("empty directory entry");
    if (entry.includes(";")) fail("directory entries cannot contain semicolons");
    if (!path.isAbsolute(entry) && (entries.length !== 1 || index !== 0)) {
      fail("only the single-volume local default may be relative");
    }
    const directory = path.isAbsolute(entry) ? entry : path.resolve(baseDirectory, entry);
    return requireExisting ? verifyHostDirectory(directory) : directory;
  });
  const canonical = requireExisting
    ? directories.map((directory) => realpathSync(directory))
    : directories.map((directory) => path.resolve(directory));
  if (new Set(canonical).size !== canonical.length) fail("duplicate directory");
  return directories;
}

function mounts(hostDirs, root, readOnly) {
  return hostDirs.map((source, volume) => ({
    type: "bind",
    source: source.replaceAll("$", () => "$$"),
    target: `${root}/${volume}`,
    ...(readOnly ? { read_only: true } : {}),
    bind: { create_host_path: false },
  }));
}

export function renderStorageCompose(hostDirs) {
  if (!Array.isArray(hostDirs) || hostDirs.length === 0) {
    throw new Error("at least one media host directory is required");
  }
  return {
    services: {
      "media-init": { volumes: mounts(hostDirs, "/media/volumes", false) },
      api: {
        environment: {
          MEDIA_DIRS: hostDirs.map((_, volume) => `/media/volumes/${volume}`).join(";"),
        },
        volumes: mounts(hostDirs, "/media/volumes", false),
      },
      caddy: { volumes: mounts(hostDirs, "/srv/media/volumes", true) },
    },
  };
}

export function readVolumeMarker(directory, volume) {
  let marker, descriptor;
  try {
    const markerPath = path.join(directory, VOLUME_MARKER);
    descriptor = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error("marker is not an exclusive regular file");
    marker = JSON.parse(readFileSync(descriptor, "utf8"));
  } catch {
    throw new Error(`media volume ${volume} has no valid identity marker`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (
    !marker ||
    Object.keys(marker).length !== 2 ||
    marker.version !== 1 ||
    marker.volume !== volume
  ) {
    throw new Error(`media volume ${volume} identity marker does not match`);
  }
  return marker;
}

function markerEntryExists(markerPath) {
  try {
    lstatSync(markerPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function parseDotenvMediaHostDir(envPath) {
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("MEDIA_HOST_DIR=")) return line.slice("MEDIA_HOST_DIR=".length);
  }
  fail("MEDIA_HOST_DIR is missing");
}

export function writeAtomically(output, data, mode = 0o600) {
  const outputDirectory = path.dirname(output);
  const temporary = path.join(
    outputDirectory,
    `.${path.basename(output)}.${process.pid}.${Date.now()}.tmp`,
  );
  const descriptor = openSync(temporary, "wx", mode);
  try {
    fchmodSync(descriptor, mode);
    writeSync(descriptor, data);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, output);
  const directoryDescriptor = openSync(outputDirectory, "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

function readRegistration(statePath) {
  if (!markerEntryExists(statePath)) return null;
  try {
    if (!lstatSync(statePath).isFile()) throw new Error();
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (state?.upgrade?.kind === "legacy-volume-zero") {
      throw new Error("pending-upgrade");
    }
    if (
      !state || Object.keys(state).length !== 2 || state.version !== 1 ||
      !Array.isArray(state.directories) || state.directories.length === 0 ||
      state.directories.some((directory) => typeof directory !== "string" || !path.isAbsolute(directory)) ||
      new Set(state.directories).size !== state.directories.length
    ) throw new Error();
    return state;
  } catch (error) {
    if (error.message === "pending-upgrade") {
      throw new Error("media storage upgrade is pending; rerun tools/upgrade-media-storage.sh --confirm-existing-volume-zero");
    }
    throw new Error("media volume registration is invalid; restore the deployment registration from backup");
  }
}

function initializeMarkers(hostDirs, statePath, outputPath) {
  const directories = hostDirs.map((directory) => realpathSync(directory));
  const registered = readRegistration(statePath);
  const previous = registered?.directories ?? [];
  if (!registered && (
    markerEntryExists(outputPath) ||
    hostDirs.some((directory) => markerEntryExists(path.join(directory, VOLUME_MARKER)))
  )) {
    throw new Error("media volume registration is missing; restore it before starting an existing deployment");
  }
  if (previous.length > directories.length || previous.some((directory, volume) => directory !== directories[volume])) {
    throw new Error("registered media volume paths cannot be replaced, reordered or removed");
  }

  // Validate the complete prefix and every new directory before any persistent write.
  for (const [volume, directory] of hostDirs.entries()) {
    if (volume < previous.length) {
      readVolumeMarker(directory, volume);
    } else {
      if (markerEntryExists(path.join(directory, VOLUME_MARKER))) {
        throw new Error(`new media volume ${volume} already has an identity marker`);
      }
      if (volume > 0 && readdirSync(directory).length !== 0) {
        throw new Error(`new media volume ${volume} must be empty`);
      }
    }
  }

  if (previous.length === directories.length) return;
  // Persist intent first: interruption while creating markers must fail closed on restart.
  writeAtomically(statePath, `${JSON.stringify({ version: 1, directories }, null, 2)}\n`);
  for (let volume = previous.length; volume < hostDirs.length; volume += 1) {
    writeAtomically(path.join(hostDirs[volume], VOLUME_MARKER), JSON.stringify({ version: 1, volume }), 0o644);
  }
}

function parseArguments(argumentsList) {
  const options = { env: ".env", output: "compose.storage.generated.json", initialize: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--initialize") options.initialize = true;
    else if (argument === "--env" || argument === "--output") {
      const value = argumentsList[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const envPath = path.resolve(options.env);
  const hostDirs = parseMediaHostDirs(parseDotenvMediaHostDir(envPath), {
    baseDirectory: path.dirname(envPath),
    requireExisting: options.initialize,
  });
  const outputPath = path.resolve(options.output);
  if (options.initialize) {
    initializeMarkers(hostDirs, path.join(path.dirname(envPath), REGISTRATION_STATE), outputPath);
  }
  writeAtomically(outputPath, `${JSON.stringify(renderStorageCompose(hostDirs), null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
