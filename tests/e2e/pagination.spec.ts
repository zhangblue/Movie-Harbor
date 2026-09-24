import { expect, test } from "@playwright/test";
import {
  AdminApi,
  adminName,
  createPublishableMovieWithoutPoster,
  initialPassword,
} from "./helpers";

type PageResult = { page: number; size: number; total: number; items: Array<{ name: string }> };

test("admin and public content lists paginate after twenty items", async ({ page, playwright }) => {
  test.setTimeout(180_000);
  const api = await AdminApi.login(playwright);
  const prefix = `Pagination ${Date.now()}`;
  try {
    for (let index = 1; index <= 21; index += 1) {
      await createPublishableMovieWithoutPoster(api, `${prefix} ${String(index).padStart(2, "0")}`);
    }
    const encoded = encodeURIComponent(prefix);
    const adminSecond = await api.get<PageResult>(`/api/admin/contents?kind=movie&name=${encoded}&page=2`);
    const publicSecond = await api.get<PageResult>(`/api/catalog?kind=movie&q=${encoded}&page=2&size=20`);

    await page.goto("/admin/");
    await page.getByLabel("管理员名称").fill(adminName);
    await page.getByLabel("密码").fill(initialPassword);
    await page.getByRole("button", { name: "登录" }).click();
    await page.getByLabel("内容形态").selectOption("movie");
    await page.getByLabel("名称").fill(prefix);
    await page.getByRole("button", { name: "查询" }).click();
    await expect(page.locator(".content-table tbody tr")).toHaveCount(20);
    await expect(page.getByText("共 21 条 · 第 1/2 页")).toBeVisible();
    await page.getByRole("button", { name: "第 2 页" }).click();
    const adminRows = page.locator(".content-table tbody tr");
    await expect(adminRows).toHaveCount(1);
    const adminRow = adminRows.first();
    await expect(adminRow.getByRole("rowheader", { name: adminSecond.items[0].name })).toBeVisible();
    await expect(adminRow.getByRole("cell", { name: "21", exact: true })).toBeVisible();

    await page.goto(`/?kind=movie&q=${encoded}`);
    const cards = page.getByRole("list", { name: "影片目录" }).getByRole("listitem");
    await expect(cards).toHaveCount(20);
    await page.getByRole("button", { name: "第 2 页" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(cards).toHaveCount(1);
    await expect(page.getByRole("link", { name: `查看${publicSecond.items[0].name}详情` })).toBeVisible();
  } finally {
    await api.dispose();
  }
});
