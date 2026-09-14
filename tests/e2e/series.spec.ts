import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { AdminApi, adminName, initialPassword, poster, snapshotMediaFiles, uploadedSince, video, type Series } from "./helpers";

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
  const beforePoster = snapshotMediaFiles();
  await page.getByLabel("海报文件").setInputFiles(poster);
  await page.getByRole("button", { name: "保存剧集草稿" }).click();
  await expect(page.getByRole("status")).toHaveText("剧集草稿已保存。");
  const seriesPosterFiles = uploadedSince(beforePoster);
  expect(seriesPosterFiles).toHaveLength(1);

  const firstDraft = page.getByRole("form", { name: "新单集草稿" });
  await firstDraft.getByLabel("单集名称").fill("Pilot");
  await firstDraft.getByRole("button", { name: "保存单集草稿" }).click();
  const firstEpisode = page.getByRole("form", { name: /第 1 集 · Pilot/ });
  await firstEpisode.getByLabel("时长（分钟）").fill("0.02");
  const beforeFirstVideo = snapshotMediaFiles();
  await firstEpisode.getByLabel("视频文件").setInputFiles(video());
  await firstEpisode.getByRole("button", { name: "发布单集" }).click();
  await expect(firstEpisode.getByText("已发布")).toBeVisible();
  const firstVideoFiles = uploadedSince(beforeFirstVideo);
  expect(firstVideoFiles).toHaveLength(1);
  await page.getByRole("button", { name: "发布剧集" }).click();
  await expect(page.getByRole("heading", { name: "查看剧集" })).toBeVisible();

  const seasonCard = page.getByRole("article", { name: "第 1 季" });
  await seasonCard.getByRole("button", { name: "添加一集" }).click();
  const secondDraft = seasonCard.getByRole("form", { name: "新单集草稿" });
  await secondDraft.getByLabel("单集名称").fill("Second Wave");
  await secondDraft.getByRole("button", { name: "保存单集草稿" }).click();
  const secondEpisode = seasonCard.getByRole("form", { name: /第 2 集 · Second Wave/ });
  await secondEpisode.getByLabel("时长（分钟）").fill("0.02");
  const beforeSecondVideo = snapshotMediaFiles();
  await secondEpisode.getByLabel("视频文件").setInputFiles(video());
  await secondEpisode.getByRole("button", { name: "发布单集" }).click();
  await expect(secondEpisode.getByText("已发布")).toBeVisible();
  const secondVideoFiles = uploadedSince(beforeSecondVideo);
  expect(secondVideoFiles).toHaveLength(1);

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

  await page.goto("/admin/");
  const archivedRow = page.getByRole("row", { name: new RegExp(name) });
  await archivedRow.getByRole("button", { name: "查看" }).click();
  const archivedSeason = page.getByRole("article", { name: "第 1 季" });
  const expandSeason = archivedSeason.getByRole("button", { name: "展开第 1 季" });
  await expandSeason.click();
  await expect(archivedSeason.getByRole("button", { name: "折叠第 1 季" })).toHaveAttribute("aria-expanded", "true");
  const firstForDelete = archivedSeason.getByRole("form", { name: /第 1 集 · Pilot/ });
  await firstForDelete.getByRole("button", { name: "归档单集" }).click();
  await firstForDelete.getByRole("button", { name: "单集转为草稿" }).click();
  await firstForDelete.getByRole("button", { name: "删除单集" }).click();
  await page.getByLabel("输入完整内容名称").fill("Pilot");
  await page.getByRole("button", { name: "确认永久删除" }).click();
  await expect(page.getByText("内容及其媒体文件已删除")).toBeVisible();
  for (const path of firstVideoFiles) await expect.poll(() => existsSync(path)).toBe(false);

  const secondForDelete = archivedSeason.getByRole("form", { name: /第 2 集 · Second Wave/ });
  await secondForDelete.getByRole("button", { name: "归档单集" }).click();
  await secondForDelete.getByRole("button", { name: "单集转为草稿" }).click();
  await archivedSeason.getByRole("button", { name: "删除本季" }).click();
  await page.getByLabel("输入完整内容名称").fill("第 1 季");
  await page.getByRole("button", { name: "确认永久删除" }).click();
  await expect(page.getByText("内容及其媒体文件已删除")).toBeVisible();
  for (const path of secondVideoFiles) await expect.poll(() => existsSync(path)).toBe(false);

  await page.getByRole("button", { name: "永久删除剧集" }).click();
  await page.getByLabel("输入完整内容名称").fill(name);
  await page.getByRole("button", { name: "确认永久删除" }).click();
  await expect(page.getByRole("heading", { name: "内容管理" })).toBeVisible();
  await expect(page.getByText("内容及其媒体文件已删除")).toBeVisible();
  for (const path of seriesPosterFiles) await expect.poll(() => existsSync(path)).toBe(false);
  await api.dispose();
});

test("a posterless series reports the exact episode requirement then publishes", async ({ page }) => {
  await page.goto("/admin/");
  await page.getByLabel("管理员名称").fill(adminName);
  await page.getByLabel("密码").fill(initialPassword);
  await page.getByRole("button", { name: "登录" }).click();
  await page.getByRole("button", { name: "＋ 新建内容" }).click();
  await page.getByLabel("新建内容形态").selectOption("series");
  await page.getByLabel("剧集名称").fill(`No Poster Series ${Date.now()}`);
  await page.getByRole("button", { name: "创建草稿" }).click();
  await page.getByRole("button", { name: "发布剧集" }).click();
  await expect(page.getByRole("alert")).toHaveText("发布剧集失败：当前剧集没有已发布的单集。请先为单集上传可播放视频并发布至少一集，然后再发布整个剧集。");

  const draft = page.getByRole("form", { name: "新单集草稿" });
  await draft.getByLabel("单集名称").fill("Only Episode");
  await draft.getByRole("button", { name: "保存单集草稿" }).click();
  const episode = page.getByRole("form", { name: /第 1 集 · Only Episode/ });
  await episode.getByLabel("视频文件").setInputFiles(video());
  await episode.getByRole("button", { name: "发布单集" }).click();
  await page.getByRole("button", { name: "发布剧集" }).click();
  await expect(page.getByRole("heading", { name: "查看剧集" })).toBeVisible();
  await expect(page.getByRole("img", { name: "当前海报预览" })).toHaveCount(0);
});
