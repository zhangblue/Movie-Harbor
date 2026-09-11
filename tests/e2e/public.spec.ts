import { expect, test } from "@playwright/test";
import { AdminApi, createPublishableMovie } from "./helpers";

test("published content is searchable and has public details", async ({ page, playwright }) => {
  const api = await AdminApi.login(playwright);
  const name = `Public Movie ${Date.now()}`;
  const movie = await createPublishableMovie(api, name);
  await page.goto(`/?q=${encodeURIComponent(name)}`);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.getByRole("link", { name }).click();
  await expect(page).toHaveURL(new RegExp(`/movies/${movie.id}$`));
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByRole("link", { name: "播放电影" })).toBeVisible();
  await api.dispose();
});
