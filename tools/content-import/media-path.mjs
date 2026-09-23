import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export async function resolveMediaReference(mediaRoot, mediaPath, expectedKind) {
  if (mediaPath === null) return null;
  const prefix = `/media/${expectedKind}/`;
  if (
    !["poster", "video"].includes(expectedKind)
    || typeof mediaPath !== "string"
    || !mediaPath.startsWith(prefix)
    || mediaPath.includes("\\")
    || mediaPath.includes("\0")
    || mediaPath.slice(prefix.length).split("/").some((part) => part === "" || part === "." || part === "..")
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
