import { ApiError, apiErrorCode, type GenreResponse } from "@movie-harbor/api-client";

export type EditorWriteError =
  | { kind: "conflict" }
  | { kind: "validation"; fields: string[] }
  | { kind: "message"; message: string };

export type GenreChoice = Pick<GenreResponse, "id" | "name" | "enabled">;

export function mergeGenreChoices(available: GenreChoice[], linked: GenreChoice[]): GenreChoice[] {
  const seen = new Set(available.map((genre) => genre.id));
  const extras = linked.filter((genre) => {
    if (seen.has(genre.id)) return false;
    seen.add(genre.id);
    return true;
  });
  return [...available, ...extras];
}

export function classifyEditorWriteError(cause: unknown): EditorWriteError {
  if (!(cause instanceof ApiError)) return { kind: "message", message: "操作失败，请检查网络后重试。" };

  switch (apiErrorCode(cause)) {
    case "media_delete_failed":
      return { kind: "message", message: "删除失败，内容和媒体文件已保留，请检查媒体目录权限后重试。" };
    case "media_replace_failed":
      return { kind: "message", message: "替换失败，原媒体文件已保留，请检查媒体目录权限后重试。" };
    case "media_content_mismatch":
      return { kind: "message", message: "上传失败：文件内容与声明的类型不匹配，请确认文件格式正确且未损坏。" };
    default:
      break;
  }

  if (cause.status === 409) return { kind: "conflict" };
  if (cause.status === 422 && cause.details && typeof cause.details === "object" && "fields" in cause.details && Array.isArray(cause.details.fields)) {
    return { kind: "validation", fields: cause.details.fields.filter((field): field is string => typeof field === "string") };
  }
  return { kind: "message", message: `操作失败：${cause.message}` };
}
