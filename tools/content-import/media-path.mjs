import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export async function resolveMediaReference(mediaRoot, mediaPath, expectedKind) {
  if (mediaPath === null) return null;
  const prefix = `/media/${expectedKind}/`;
  const parts = typeof mediaPath === "string" ? mediaPath.split("/") : [];
  const shard = parts[3];
  const filename = parts[4];
  const file = /^([0-9a-f]{32})\.(jpg|png|webp|mp4|webm|ogv)$/.exec(filename ?? "");
  const extensions = expectedKind === "poster" ? new Set(["jpg", "png", "webp"]) : new Set(["mp4", "webm", "ogv"]);
  if (
    !["poster", "video"].includes(expectedKind)
    || typeof mediaPath !== "string"
    || !mediaPath.startsWith(prefix)
    || mediaPath.includes("\\")
    || mediaPath.includes("\0")
    || parts.length !== 5
    || !/^[0-9a-f]{2}$/.test(shard)
    || !file
    || !file[1].startsWith(shard)
    || !extensions.has(file[2])
  ) {
    throw new Error(`invalid ${expectedKind} media path`);
  }

  const root = await realpath(mediaRoot);
  let actual;
  try {
    actual = await realpath(resolve(root, mediaPath.slice("/media/".length)));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`missing media file: ${mediaPath}`, { cause: error });
    throw error;
  }
  const remainder = relative(root, actual);
  if (remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error("media path escapes media root");
  }
  const info = await stat(actual);
  if (!info.isFile()) throw new Error("media path is not a regular file");
  return { sourcePath: mediaPath, localPath: actual, byteSize: info.size };
}
