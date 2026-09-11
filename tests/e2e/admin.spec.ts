import { expect, test } from "@playwright/test";
import { AdminApi, adminName, baseURL, changedPassword, createPublishableMovie, initialPassword, poster, saveState, video, type Movie } from "./helpers";

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
  await page.getByLabel("海报文件").setInputFiles(poster);
  await page.getByLabel("视频文件").setInputFiles(video());
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await expect(page.getByRole("heading", { name: "查看电影" })).toBeVisible();
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
  expect((await request.get(`/api/catalog/movies/${movie.id}`)).status()).toBe(404);

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
