import { ApiError, apiErrorCode, type GenreResponse } from "@movie-harbor/api-client";

// 描述编辑写入错误分类，在处理版本冲突和校验失败时使用。
export type EditorWriteError =
  | { kind: "conflict" }
  | { kind: "validation"; fields: string[] }
  | { kind: "message"; message: string };

// 定义编辑器题材选项所需字段，在合并可选和已关联题材时使用。
export type GenreChoice = Pick<GenreResponse, "id" | "name" | "enabled">;

// 合并可选题材与已关联题材并去重，在初始化编辑选项时调用。
export function mergeGenreChoices(available: GenreChoice[], linked: GenreChoice[]): GenreChoice[] {
  const seen = new Set<string>();
  return [...available, ...linked].filter((genre) => {
    if (seen.has(genre.id)) return false;
    seen.add(genre.id);
    return true;
  });
}

// 将写入错误分类为冲突、校验或消息，在编辑器写入失败时调用。
export function classifyEditorWriteError(cause: Error): EditorWriteError {
  if (!(cause instanceof ApiError)) return { kind: "message", message: "操作失败，请检查网络后重试。" };

  switch (apiErrorCode(cause)) {
    case "media_delete_failed":
      return { kind: "message", message: "删除失败，内容和媒体文件已保留，请检查媒体目录权限后重试。" };
    case "media_replace_outcome_unknown":
      return { kind: "message", message: "媒体替换结果未知，请重新读取内容版本和已保存的媒体后再决定是否重试。" };
    case "media_replace_failed":
      return { kind: "message", message: "替换失败，原媒体文件已保留，请检查媒体目录权限后重试。" };
    case "storage_space_low":
      return { kind: "message", message: "媒体卷空间不足，请释放空间后重试。" };
    case "storage_capacity_unavailable":
      return { kind: "message", message: "暂时无法读取媒体卷容量，请稍后重试。" };
    case "declared_size_invalid":
      return { kind: "message", message: "视频大小声明无效，请重新选择文件后重试。" };
    case "declared_size_mismatch":
      return { kind: "message", message: "收到的视频大小与声明不符，请重新选择文件后重试。" };
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
