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

function validateItemMap(items, allowedFields, nested = false) {
  for (const item of Object.values(items)) {
    if (!isRecord(item)) throw new Error("progress item must be an object");
    rejectUnknownKeys(item, allowedFields);
    if (nested && item.seasons !== undefined) {
      if (!isRecord(item.seasons)) throw new Error("progress seasons must be an object");
      validateItemMap(item.seasons, new Set(["id", "episodes"]));
      for (const season of Object.values(item.seasons)) {
        if (season.episodes !== undefined) {
          if (!isRecord(season.episodes)) throw new Error("progress episodes must be an object");
          validateItemMap(season.episodes, new Set(["id", "version", "metadataUpdated", "videoUploaded", "completed"]));
        }
      }
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
  if (Object.values(progress.genres).some((id) => typeof id !== "string")) {
    throw new Error("progress genre IDs must be strings");
  }
  validateItemMap(progress.movies, new Set(["id", "version", "metadataUpdated", "posterUploaded", "videoUploaded", "completed"]));
  validateItemMap(progress.series, new Set(["id", "version", "metadataUpdated", "posterUploaded", "seasons", "completed"]), true);
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
      try {
        handle = await fs.open(temporaryPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(temporaryPath, path);
        await fs.chmod(path, 0o600);
      } finally {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(temporaryPath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
  };
}
