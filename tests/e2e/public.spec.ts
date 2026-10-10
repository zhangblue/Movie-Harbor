import { expect, test } from "@playwright/test";
import { AdminApi, ViewerApi, baseURL, createPublishableMovie } from "./helpers";

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
    await change.getByLabel("当前密码").fill("wrong-password");
    await change.getByLabel("新密码", { exact: true }).fill("viewer-updated-password");
    await change.getByRole("button", { name: "保存新密码" }).click();
    await expect(change.getByRole("alert")).toHaveText("当前密码不正确");
    await expect(page.getByText(user.username, { exact: true })).toBeVisible();
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

for (const operation of ["logout", "password"] as const) {
  test(`late ${operation} response preserves a newer viewer cookie and UI`, async ({ page, context, playwright }) => {
    const api = await AdminApi.login(playwright);
    const summer = await api.createUser(`summer-${operation}-${Date.now()}`);
    const winter = await api.createUser(`winter-${operation}-${Date.now()}`);
    const summerLogin = await context.request.post("/api/viewer/login", {
      data: { username: summer.username, password: "viewer-initial-password" }, headers: { Origin: baseURL },
    });
    expect(summerLogin.status()).toBe(200);
    const oldCookie = (await context.cookies()).find((cookie) => cookie.name === "mh_viewer_session")!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let received!: () => void;
    const responseReceived = new Promise<void>((resolve) => { received = resolve; });
    let headers: Record<string, string> = {};
    await page.route(`**/api/viewer/${operation}`, async (route) => {
      const response = await route.fetch();
      headers = response.headers();
      expect(response.status()).toBe(204);
      received();
      await gate;
      await route.fulfill({ response });
    });
    try {
      await page.goto("/");
      await expect(page.getByText(summer.username, { exact: true })).toBeVisible();
      if (operation === "logout") await page.getByRole("button", { name: "退出登录" }).click();
      else {
        await page.getByRole("button", { name: "修改密码" }).click();
        await page.getByLabel("当前密码").fill("viewer-initial-password");
        await page.getByLabel("新密码", { exact: true }).fill("viewer-updated-password");
        await page.getByRole("button", { name: "保存新密码" }).click();
      }
      await responseReceived;
      const newerLogin = await context.request.post("/api/viewer/login", {
        data: { username: winter.username, password: "viewer-initial-password" }, headers: { Origin: baseURL },
      });
      expect(newerLogin.status()).toBe(200);
      const newCookie = (await context.cookies()).find((cookie) => cookie.name === "mh_viewer_session")!;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByText(winter.username, { exact: true })).toBeVisible();
      const completed = page.waitForResponse((response) => response.url().endsWith(`/api/viewer/${operation}`));
      release(); await completed;
      await expect(page.getByText(winter.username, { exact: true })).toBeVisible();
      expect(headers).not.toHaveProperty("set-cookie");
      expect((await context.cookies()).find((cookie) => cookie.name === "mh_viewer_session")?.value).toBe(newCookie.value);
      expect((await (await context.request.get("/api/viewer/session")).json()).username).toBe(winter.username);
      const stale = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Cookie: `${oldCookie.name}=${oldCookie.value}` } });
      try { expect((await stale.get("/api/viewer/session")).status()).toBe(401); }
      finally { await stale.dispose(); }
      await page.unroute(`**/api/viewer/${operation}`);
      await page.getByRole("button", { name: "修改密码" }).click();
      await page.getByLabel("当前密码").fill("viewer-initial-password");
      await page.getByLabel("新密码", { exact: true }).fill("winter-updated-password");
      await page.getByRole("button", { name: "保存新密码" }).click();
      await expect(page.getByText("密码已修改，请重新登录", { exact: true })).toBeVisible();
    } finally { release(); await api.dispose(); }
  });
}
