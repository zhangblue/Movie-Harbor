import { ApiError } from "@movie-harbor/api-client";
import { expect, test } from "vitest";
import { classifyEditorWriteError, mergeGenreChoices } from "./editorSupport";

test("mergeGenreChoices keeps available order and appends linked inactive genres once", () => {
  const available = [
    { id: "g1", name: "剧情", enabled: true, sort_order: 1 },
    { id: "g2", name: "科幻", enabled: true, sort_order: 2 },
  ];
  const linked = [available[0], { id: "g3", name: "旧题材", enabled: false }];

  expect(mergeGenreChoices(available, linked).map((genre) => genre.id)).toEqual(["g1", "g2", "g3"]);
  expect(available.map((genre) => genre.id)).toEqual(["g1", "g2"]);
  expect(linked.map((genre) => genre.id)).toEqual(["g1", "g3"]);
});

test("mergeGenreChoices removes duplicate available genre IDs while preserving first occurrence order", () => {
  const available = [
    { id: "g1", name: "剧情", enabled: true },
    { id: "g1", name: "重复剧情", enabled: false },
    { id: "g2", name: "科幻", enabled: true },
  ];

  expect(mergeGenreChoices(available, []).map((genre) => genre.id)).toEqual(["g1", "g2"]);
});

test("classifyEditorWriteError preserves stable media and validation outcomes", () => {
  expect(classifyEditorWriteError(new ApiError(500, "", "", { code: "media_delete_failed" })))
    .toEqual({ kind: "message", message: "删除失败，内容和媒体文件已保留，请检查媒体目录权限后重试。" });
  expect(classifyEditorWriteError(new ApiError(500, "", "", { code: "media_replace_failed" })))
    .toEqual({ kind: "message", message: "替换失败，原媒体文件已保留，请检查媒体目录权限后重试。" });
  expect(classifyEditorWriteError(new ApiError(415, "", "", { code: "media_content_mismatch" })))
    .toEqual({ kind: "message", message: "上传失败：文件内容与声明的类型不匹配，请确认文件格式正确且未损坏。" });
  expect(classifyEditorWriteError(new ApiError(422, "", "", { fields: ["name", 7] })))
    .toEqual({ kind: "validation", fields: ["name"] });
  expect(classifyEditorWriteError(new ApiError(409, "", "", undefined)))
    .toEqual({ kind: "conflict" });
  expect(classifyEditorWriteError(new ApiError(500, "", "服务器繁忙", undefined)))
    .toEqual({ kind: "message", message: "操作失败：服务器繁忙" });
  expect(classifyEditorWriteError(new Error("offline")))
    .toEqual({ kind: "message", message: "操作失败，请检查网络后重试。" });
});
