import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { AdminApi, ViewerApi, adminName, baseURL, changedPassword, createPublishableMovie, initialPassword, poster, saveState, snapshotMediaFiles, uploadedSince, video, type Movie, type ViewerUser } from "./helpers";

test("user management preserves Unicode usernames and resets or deletes every viewer session", async ({ page, playwright }) => {
  const api = await AdminApi.login(playwright);
  const name = `ui-viewer-${Date.now()}`;
  // U+FEFF is not Unicode White_Space: backend normalization preserves it.
  const username = `\uFEFF${name}\uFEFF`;
  await page.goto("/admin/");
  await page.getByLabel("管理员名称").fill(adminName);
  await page.getByLabel("密码").fill(initialPassword);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "用户管理", exact: true }).click();
  await page.getByRole("button", { name: "＋ 添加用户" }).click();
  await page.getByRole("dialog").getByLabel("用户名").fill(username);
  await page.getByRole("dialog").getByLabel("初始密码").fill("viewer-initial-password");
  await page.getByRole("button", { name: "创建用户", exact: true }).click();
  await expect(page.getByText("用户已添加。", { exact: true })).toBeVisible();
  const users = await api.get<{ items: ViewerUser[] }>(`/api/admin/users?q=${name}`);
  expect(users.items[0].username).toBe(username);
  const first = await ViewerApi.login(playwright, username);
  const second = await ViewerApi.login(playwright, username);
  try {
    const movie = await api.setPrivacy("movies", await createPublishableMovie(api, `Reset Protected ${Date.now()}`), true);
    await page.getByLabel("搜索用户名").fill(name);
    await page.getByRole("button", { name: "查询", exact: true }).click();
    const row = page.getByRole("row", { name: new RegExp(name) });
    await row.getByRole("button", { name: "修改密码" }).click();
    await expect(page.getByRole("dialog").getByLabel("用户名")).toBeDisabled();
    await page.getByRole("dialog").getByLabel("新密码").fill("viewer-reset-password");
    await page.getByRole("button", { name: "保存新密码" }).click();
    await expect(page.getByText("密码已修改，该用户现有的登录会话已失效。", { exact: true })).toBeVisible();
    for (const client of [first.request, second.request]) {
      expect((await client.get("/api/viewer/session")).status()).toBe(401);
      expect((await client.get(movie.video!.url, { headers: { Range: "bytes=0-1" } })).status()).toBe(404);
    }
    expect((await first.request.post("/api/viewer/login", { data: { username, password: "viewer-initial-password" } })).status()).toBe(401);
    const fresh = await ViewerApi.login(playwright, username, "viewer-reset-password");
    expect((await fresh.request.get(movie.video!.url)).status()).toBe(200);
    await row.getByRole("button", { name: "删除", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "删除用户？" })).toBeVisible();
    expect((await fresh.request.get("/api/viewer/session")).status()).toBe(200);
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect(row).toHaveCount(0);
    expect((await fresh.request.get("/api/viewer/session")).status()).toBe(401);
    expect((await fresh.request.get(movie.video!.url)).status()).toBe(404);
    await fresh.dispose();
    await page.getByRole("button", { name: "内容管理", exact: true }).click();
    await page.getByLabel("名称", { exact: true }).fill(movie.name);
    await page.getByLabel("访问范围", { exact: true }).selectOption("private");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await page.getByRole("row", { name: new RegExp(movie.name) }).getByRole("button", { name: "设为公开" }).click();
    await expect(page.getByRole("row", { name: new RegExp(movie.name) })).toHaveCount(0);
    expect((await first.request.get(movie.video!.url, { headers: { Range: "bytes=0-1" } })).status()).toBe(206);
    await page.getByLabel("访问范围", { exact: true }).selectOption("public");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await page.getByRole("row", { name: new RegExp(movie.name) }).getByRole("button", { name: "设为私密" }).click();
    await expect(page.getByRole("row", { name: new RegExp(movie.name) })).toHaveCount(0);
    expect((await first.request.get(movie.video!.url, { headers: { Range: "bytes=0-1" } })).status()).toBe(404);
  } finally { await first.dispose(); await second.dispose(); await api.dispose(); }
});

test("empty deployment initializes the admin and a movie completes its lifecycle", async ({ page, playwright, request }) => {
  await page.goto("/admin/");
  await page.getByLabel("管理员名称").fill(adminName);
  await page.getByLabel("密码").fill(initialPassword);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "内容管理" })).toBeVisible();

  const genreName = `E2E Genre ${Date.now()}`;
  await page.getByRole("button", { name: "题材配置" }).click();
  await page.getByLabel("题材名称").fill(genreName);
  await page.getByRole("button", { name: "新增题材" }).click();
  await expect(page.getByRole("row", { name: new RegExp(genreName) })).toBeVisible();

  const api = await AdminApi.login(playwright);
  const genres = await api.get<Array<{ name: string }>>("/api/admin/genres");
  expect(genres.some((genre) => genre.name === genreName)).toBe(true);

  await page.getByRole("button", { name: "内容管理" }).click();
  await page.getByRole("button", { name: "＋ 新建内容" }).click();
  const name = `Lifecycle Movie ${Date.now()}`;
  await page.getByLabel("名称").fill(name);
  await page.getByRole("button", { name: "创建草稿" }).click();
  await expect(page.getByRole("heading", { name: "编辑电影草稿" })).toBeVisible();
  await page.getByLabel("年份").fill("2026");
  await page.getByLabel("时长（分钟）").fill("0.02");
  await page.getByLabel("简介").fill(`${name} searchable synopsis`);
  await page.getByLabel("题材").selectOption({ label: genreName });
  const beforePoster = snapshotMediaFiles();
  await page.getByLabel("海报文件").setInputFiles(poster);
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByRole("status")).toHaveText("草稿已保存。");
  const moviePosterFiles = uploadedSince(beforePoster);
  expect(moviePosterFiles).toHaveLength(1);

  const beforeVideo = snapshotMediaFiles();
  await page.getByLabel("视频文件").setInputFiles(video());
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await expect(page.getByRole("heading", { name: "查看电影" })).toBeVisible();
  const movieVideoFiles = uploadedSince(beforeVideo);
  expect(movieVideoFiles).toHaveLength(1);
  let movie = (await api.get<Movie[]>(`/api/admin/movies?name=${encodeURIComponent(name)}`)).find((item) => item.name === name)!;
  expect((await request.get(`/api/catalog/movies/${movie.id}`)).status()).toBe(200);
  await page.getByRole("button", { name: "归档", exact: true }).click();
  await expect(page.getByRole("button", { name: "原样发布" })).toBeVisible();
  expect((await request.get(`/api/catalog/movies/${movie.id}`)).status()).toBe(404);
  const hidden = await (await request.get(`/api/catalog?q=${encodeURIComponent(name)}`)).json();
  expect(hidden.items).toHaveLength(0);
  await page.getByRole("button", { name: "原样发布" }).click();
  await expect(page.getByRole("button", { name: "归档", exact: true })).toBeVisible();
  expect((await request.get(`/api/catalog/movies/${movie.id}`)).status()).toBe(200);
  await page.getByRole("button", { name: "归档", exact: true }).click();
  await page.getByRole("button", { name: "转为草稿" }).click();
  await expect(page.getByRole("heading", { name: "编辑电影草稿" })).toBeVisible();
  await page.getByRole("button", { name: "永久删除" }).click();
  await page.getByLabel("输入完整内容名称").fill(name);
  await page.getByRole("button", { name: "确认永久删除" }).click();
  await expect(page.getByRole("heading", { name: "内容管理" })).toBeVisible();
  await expect(page.getByText("内容及其媒体文件已删除")).toBeVisible();
  for (const path of [...moviePosterFiles, ...movieVideoFiles]) {
    await expect.poll(() => existsSync(path)).toBe(false);
  }
  expect((await request.get(`/api/catalog/movies/${movie.id}`)).status()).toBe(404);

  await page.getByRole("button", { name: "＋ 新建内容" }).click();
  const noPosterName = `No Poster Movie ${Date.now()}`;
  await page.getByLabel("名称").fill(noPosterName);
  await page.getByRole("button", { name: "创建草稿" }).click();
  await page.getByLabel("时长（分钟）").fill("0.02");
  await page.getByLabel("视频文件").setInputFiles(video());
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await expect(page.getByRole("heading", { name: "查看电影" })).toBeVisible();
  await expect(page.getByRole("img", { name: "当前海报预览" })).toHaveCount(0);
  await page.getByRole("button", { name: "返回列表" }).click();

  const persistent = await createPublishableMovie(api, `Persistent Movie ${Date.now()}`);
  const detail = await (await request.get(`/api/catalog/movies/${persistent.id}`)).json();
  const passwordResponse = await api.request.post("/api/admin/password", {
    data: { current_password: initialPassword, new_password: changedPassword },
    headers: { Origin: baseURL, "X-CSRF-Token": api.csrf },
  });
  expect(passwordResponse.status()).toBe(204);
  saveState({ movieId: persistent.id, videoUrl: detail.video_url });
  await api.dispose();
});
