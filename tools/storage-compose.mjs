import {
  closeSync,
  fchmodSync,
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
  let marker;
  try {
    const markerPath = path.join(directory, VOLUME_MARKER);
    if (!lstatSync(markerPath).isFile()) throw new Error("marker is not a regular file");
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw new Error(`media volume ${volume} has no valid identity marker`);
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

function parseDotenvMediaHostDir(envPath) {
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("MEDIA_HOST_DIR=")) return line.slice("MEDIA_HOST_DIR=".length);
  }
  fail("MEDIA_HOST_DIR is missing");
}

function writeAtomically(output, data, mode = 0o600) {
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

function initializeMarkers(hostDirs) {
  for (const [volume, directory] of hostDirs.entries()) {
    const markerPath = path.join(directory, VOLUME_MARKER);
    try {
      readVolumeMarker(directory, volume);
      continue;
    } catch (error) {
      if (markerEntryExists(markerPath)) throw error;
    }

    if (volume > 0 && readdirSync(directory).length !== 0) {
      throw new Error(`media volume ${volume} is non-empty and has no identity marker`);
    }
    writeAtomically(markerPath, JSON.stringify({ version: 1, volume }), 0o644);
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
  if (options.initialize) initializeMarkers(hostDirs);
  writeAtomically(path.resolve(options.output), `${JSON.stringify(renderStorageCompose(hostDirs), null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
