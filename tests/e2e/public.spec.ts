import { expect, test } from "@playwright/test";
import { AdminApi, ViewerApi, createPublishableMovie } from "./helpers";

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

// Removing the server visibility predicate would expose both search results and direct details.
test("anonymous users cannot discover or fetch private content while viewers can", async ({ request, playwright }) => {
  const api = await AdminApi.login(playwright);
  const user = await api.createUser(`catalog-viewer-${Date.now()}`);
  const viewer = await ViewerApi.login(playwright, user.username);
  try {
    const movie = await api.setPrivacy("movies", await createPublishableMovie(api, `Private Catalog ${Date.now()}`), true);
    for (const client of [request, api.request]) {
      const catalog = await client.get(`/api/catalog?q=${encodeURIComponent(movie.name)}&include_private=true`);
      expect((await catalog.json()).items).toEqual([]);
      expect(catalog.headers()["cache-control"]).toContain("no-store");
      expect((await client.get(`/api/catalog/movies/${movie.id}`)).status()).toBe(404);
    }
    const catalog = await viewer.request.get(`/api/catalog?q=${encodeURIComponent(movie.name)}`);
    expect((await catalog.json()).items).toEqual([expect.objectContaining({ id: movie.id, is_private: true })]);
    expect(catalog.headers()["cache-control"]).toContain("no-store");
    expect((await viewer.request.get(`/api/catalog/movies/${movie.id}`)).status()).toBe(200);
    expect((await viewer.request.get("/api/admin/users")).status()).toBe(401);
  } finally { await viewer.dispose(); await api.dispose(); }
});

test("public login and self password change refresh private content and revoke both sessions", async ({ page, playwright }) => {
  const api = await AdminApi.login(playwright);
  const user = await api.createUser(`public-ui-${Date.now()}`);
  const other = await ViewerApi.login(playwright, user.username);
  try {
    const movie = await api.setPrivacy("movies", await createPublishableMovie(api, `Private UI ${Date.now()}`), true);
    await page.goto(`/?q=${encodeURIComponent(movie.name)}`);
    await expect(page.getByRole("heading", { name: movie.name })).toHaveCount(0);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    const login = page.getByRole("dialog");
    await login.getByLabel("用户名").fill(user.username);
    await login.getByLabel("密码", { exact: true }).fill("viewer-initial-password");
    await login.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: movie.name })).toBeVisible();
    await page.getByRole("link", { name: movie.name }).click();
    await expect(page.getByText("私密", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "修改密码", exact: true }).click();
    const change = page.getByRole("dialog");
    await change.getByLabel("当前密码").fill("viewer-initial-password");
    await change.getByLabel("新密码", { exact: true }).fill("viewer-updated-password");
    await change.getByRole("button", { name: "保存新密码" }).click();
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: movie.name })).toHaveCount(0);
    for (const client of [page.request, other.request]) {
      expect((await client.get("/api/viewer/session")).status()).toBe(401);
      expect((await client.get(movie.video!.url)).status()).toBe(404);
    }
    const fresh = await ViewerApi.login(playwright, user.username, "viewer-updated-password");
    expect((await fresh.request.get(movie.video!.url, { headers: { Range: "bytes=0-31" } })).status()).toBe(206);
    await fresh.dispose();
  } finally { await other.dispose(); await api.dispose(); }
});
