import { expect, test } from "@playwright/test";
import { readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { AdminApi, createMovieDraftWithMedia, mediaHostDir, snapshotMediaFiles, video, type Movie } from "./helpers";

// 在隔离服务核对正常上传、空间不足时的数据完整性及隐藏暂存目录。
test("capacity rejection preserves the original movie video and leaves no partial upload", async ({ playwright }) => {
  const runDir = process.env.E2E_RUN_DIR;
  if (!runDir || realpathSync(mediaHostDir) !== join(realpathSync(runDir), "media")) {
    throw new Error("capacity test requires the runner-owned media directory");
  }
  const admin = await AdminApi.login(playwright);
  try {
    // 正确声明真实 MP4 的长度，先建立可以实际读取的旧视频作对照。
    const movie = await createMovieDraftWithMedia(admin, `Capacity ${Date.now()}`, {
      synopsis: "容量保护验收", durationSeconds: 1, includePoster: false,
    });
    const fixture = video();
    const existing = await admin.request.get(movie.video!.url);
    expect(existing.status()).toBe(200);
    expect(await existing.body()).toEqual(fixture.buffer);
    const filesBefore = snapshotMediaFiles();
    const incoming = resolve(mediaHostDir, ".incoming");
    const pendingBefore = readdirSync(incoming).sort();
    expect(pendingBefore.filter(name => name.endsWith(".part"))).toEqual([]);

    // 最大合法声明只能触发空间拒绝，错误码应先于实际正文长度不符返回。
    const rejected = await admin.request.post(`/api/admin/media/movies/${movie.id}/video?version=${movie.version}`, {
      headers: { "X-CSRF-Token": admin.csrf, "X-Media-Byte-Size": "18446744073709551615" },
      multipart: { file: fixture },
    });
    expect(rejected.status()).toBe(507);
    expect(await rejected.json()).toMatchObject({ code: "storage_space_low" });

    // 从 API 和挂载目录分别核对，避免只检查业务版本而漏掉文件副作用。
    const after = await admin.get<Movie>(`/api/admin/movies/${movie.id}`);
    expect(after).toMatchObject({ version: movie.version, video: movie.video });
    expect(await (await admin.request.get(after.video!.url)).body()).toEqual(fixture.buffer);
    expect(snapshotMediaFiles()).toEqual(filesBefore);
    expect(readdirSync(incoming).sort()).toEqual(pendingBefore);
  } finally {
    await admin.dispose();
  }
});
