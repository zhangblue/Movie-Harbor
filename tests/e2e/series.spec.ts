import { expect, test } from "@playwright/test";
import { AdminApi, adminName, initialPassword, poster, video, type Series } from "./helpers";

test("a series publishes episodes incrementally and archives immediately", async ({ page, playwright, request }) => {
  await page.goto("/admin/");
  await page.getByLabel("管理员名称").fill(adminName);
  await page.getByLabel("密码").fill(initialPassword);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "＋ 新建内容" }).click();
  await page.getByLabel("新建内容形态").selectOption("series");
  const api = await AdminApi.login(playwright);
  const name = `Incremental Series ${Date.now()}`;
  await page.getByLabel("剧集名称").fill(name);
  await page.getByRole("button", { name: "创建草稿" }).click();
  await expect(page.getByRole("heading", { name: "编辑剧集草稿" })).toBeVisible();
  await page.getByLabel("首播年份").fill("2026");
  await page.getByLabel("简介").fill("incremental release");
  await page.getByLabel("海报文件").setInputFiles(poster);
  await page.getByRole("button", { name: "保存剧集草稿" }).click();
  await expect(page.getByRole("status")).toHaveText("剧集草稿已保存。");

  const firstDraft = page.getByRole("form", { name: "新单集草稿" });
  await firstDraft.getByLabel("单集名称").fill("Pilot");
  await firstDraft.getByRole("button", { name: "保存单集草稿" }).click();
  const firstEpisode = page.getByRole("form", { name: /第 1 集 · Pilot/ });
  await firstEpisode.getByLabel("时长（分钟）").fill("0.02");
  await firstEpisode.getByLabel("视频文件").setInputFiles(video());
  await firstEpisode.getByRole("button", { name: "发布单集" }).click();
  await expect(firstEpisode.getByText("已发布")).toBeVisible();
  await page.getByRole("button", { name: "发布剧集" }).click();
  await expect(page.getByRole("heading", { name: "查看剧集" })).toBeVisible();

  const seasonCard = page.getByRole("article", { name: "第 1 季" });
  await seasonCard.getByRole("button", { name: "添加一集" }).click();
  const secondDraft = seasonCard.getByRole("form", { name: "新单集草稿" });
  await secondDraft.getByLabel("单集名称").fill("Second Wave");
  await secondDraft.getByRole("button", { name: "保存单集草稿" }).click();
  const secondEpisode = seasonCard.getByRole("form", { name: /第 2 集 · Second Wave/ });
  await secondEpisode.getByLabel("时长（分钟）").fill("0.02");
  await secondEpisode.getByLabel("视频文件").setInputFiles(video());
  await secondEpisode.getByRole("button", { name: "发布单集" }).click();
  await expect(secondEpisode.getByText("已发布")).toBeVisible();

  const series = (await api.get<Series[]>(`/api/admin/series?name=${encodeURIComponent(name)}`)).find((item) => item.name === name)!;

  await page.goto(`/series/${series.id}`);
  await expect(page.getByRole("link", { name: /第 1 集 · Pilot/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /第 2 集 · Second Wave/ })).toBeVisible();
  await page.goto("/admin/");
  await expect(page.getByRole("heading", { name: "内容管理" })).toBeVisible();
  const row = page.getByRole("row", { name: new RegExp(name) });
  await row.getByRole("button", { name: "归档" }).click();
  await expect(row.getByRole("button", { name: "原样发布" })).toBeVisible();
  await expect.poll(async () => (await request.get(`/api/catalog/series/${series.id}`)).status()).toBe(404);
  await page.goto(`/series/${series.id}`);
  await expect(page.getByRole("heading", { name: "404 · 内容不存在" })).toBeVisible();
  await api.dispose();
});
