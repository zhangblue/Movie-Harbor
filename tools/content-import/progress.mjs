import { randomUUID } from "node:crypto";
import * as defaultFs from "node:fs/promises";
import { dirname, basename, join } from "node:path";

const EMPTY_PROGRESS = {
  formatVersion: 1,
  targetOrigin: "",
  source: { exportedAt: "", sha256: "" },
  genres: {},
  movies: {},
  series: {},
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("unsupported progress field");
  }
}

function validateRecord(record, allowedFields, { version = false, flags = [], seasons = false, episodes = false } = {}) {
  if (!isRecord(record)) throw new Error("progress item must be an object");
  rejectUnknownKeys(record, allowedFields);
  if (typeof record.id !== "string" || record.id.trim() === "") {
    throw new Error("progress item id must be a nonblank string");
  }
  if (version && (!Number.isInteger(record.version) || record.version <= 0)) {
    throw new Error("progress item version must be a positive integer");
  }
  for (const flag of flags) {
    if (record[flag] !== undefined && typeof record[flag] !== "boolean") {
      throw new Error(`progress ${flag} must be a boolean`);
    }
  }
  if (seasons && record.seasons !== undefined) {
    if (!isRecord(record.seasons)) throw new Error("progress seasons must be an object");
    for (const season of Object.values(record.seasons)) {
      validateRecord(season, new Set(["id", "episodes"]), { episodes: true });
    }
  }
  if (episodes && record.episodes !== undefined) {
    if (!isRecord(record.episodes)) throw new Error("progress episodes must be an object");
    for (const episode of Object.values(record.episodes)) {
      validateRecord(episode,
        new Set(["id", "version", "metadataUpdated", "videoUploaded", "completed"]),
        { version: true, flags: ["metadataUpdated", "videoUploaded", "completed"] });
    }
  }
}

function validateProgress(progress, targetOrigin, sourceIdentity) {
  if (!isRecord(progress) || progress.formatVersion !== EMPTY_PROGRESS.formatVersion) {
    throw new Error("unsupported progress format version");
  }
  rejectUnknownKeys(progress, new Set(["formatVersion", "targetOrigin", "source", "genres", "movies", "series"]));
  if (progress.targetOrigin !== targetOrigin) throw new Error("progress target origin does not match");
  if (!isRecord(progress.source)
      || progress.source.exportedAt !== sourceIdentity.exportedAt
      || progress.source.sha256 !== sourceIdentity.sha256) {
    throw new Error("progress source identity does not match");
  }
  rejectUnknownKeys(progress.source, new Set(["exportedAt", "sha256"]));
  for (const key of ["genres", "movies", "series"]) {
    if (!isRecord(progress[key])) throw new Error(`progress ${key} must be an object`);
  }
  if (Object.values(progress.genres).some((id) => typeof id !== "string" || id.trim() === "")) {
    throw new Error("progress genre IDs must be nonblank strings");
  }
  for (const movie of Object.values(progress.movies)) {
    validateRecord(movie,
      new Set(["id", "version", "metadataUpdated", "posterUploaded", "videoUploaded", "completed"]),
      { version: true, flags: ["metadataUpdated", "posterUploaded", "videoUploaded", "completed"] });
  }
  for (const series of Object.values(progress.series)) {
    validateRecord(series,
      new Set(["id", "version", "metadataUpdated", "posterUploaded", "seasons", "completed"]),
      { version: true, flags: ["metadataUpdated", "posterUploaded", "completed"], seasons: true });
  }
  return progress;
}

export async function openProgressStore({ path, targetOrigin, sourceIdentity, fs = defaultFs }) {
  let state;
  try {
    const bytes = await fs.readFile(path, "utf8");
    state = validateProgress(JSON.parse(bytes), targetOrigin, sourceIdentity);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = {
      ...EMPTY_PROGRESS,
      targetOrigin,
      source: { exportedAt: sourceIdentity.exportedAt, sha256: sourceIdentity.sha256 },
      genres: {},
      movies: {},
      series: {},
    };
  }

  return {
    state,
    async save() {
      validateProgress(state, targetOrigin, sourceIdentity);
      const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
      let handle;
      let renamed = false;
      try {
        handle = await fs.open(temporaryPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.chmod(temporaryPath, 0o600);
        await fs.rename(temporaryPath, path);
        renamed = true;
      } finally {
        if (handle) await handle.close().catch(() => {});
        if (!renamed) {
          await fs.unlink(temporaryPath).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }
    },
  };
}
