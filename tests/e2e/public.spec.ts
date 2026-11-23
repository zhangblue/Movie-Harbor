import { expect, test } from "@playwright/test";
import {
  AdminApi, ViewerApi, baseURL, createPublishableMovie, createPublishableMovieWithoutPoster,
  createPublishableSeries, type Genre,
} from "./helpers";

// 验证已发布内容可搜索并显示公开详情。
test("published content is searchable and has public details", async ({ page, playwright }) => {
  const api = await AdminApi.login(playwright);
  const name = `Public Movie ${Date.now()}`;
  const movie = await createPublishableMovie(api, name);
  await page.goto(`/browse?q=${encodeURIComponent(name)}`);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.getByRole("link", { name }).click();
  await expect(page).toHaveURL(new RegExp(`/movies/${movie.id}$`));
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByRole("link", { name: "播放电影" })).toBeVisible();
  await api.dispose();
});

// Removing the server visibility predicate would expose both search results and direct details.
// 验证匿名用户无法发现或读取私密内容，登录用户可以访问。
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

// 验证私密目录筛选电影和剧集，并在退出后清除。
test("private-only catalog filters movies and series and clears on logout", async ({ page, playwright }) => {
  const api = await AdminApi.login(playwright);
  try {
    const prefix = `Private Filter ${Date.now()}`;
    const user = await api.createUser(`private-filter-${Date.now()}`);
    const publicMovie = await createPublishableMovie(api, `${prefix} Public Movie`);
    const privateMovie = await api.setPrivacy("movies", await createPublishableMovie(api, `${prefix} Private Movie`), true);
    const privateSeries = await api.setPrivacy("series", await createPublishableSeries(api, `${prefix} Private Series`), true);
    await page.goto(`/browse?q=${encodeURIComponent(prefix)}`);
    const privateOnly = page.getByRole("checkbox", { name: "只看私密", exact: true });
    await expect(privateOnly).toHaveCount(0);
    await expect(page.getByRole("heading", { name: publicMovie.name, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: privateMovie.name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: privateSeries.name, exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "登录", exact: true }).click();
    const login = page.getByRole("dialog");
    await login.getByLabel("用户名").fill(user.username);
    await login.getByLabel("密码", { exact: true }).fill("viewer-initial-password");
    await login.getByRole("button", { name: "登录", exact: true }).click();
    for (const content of [publicMovie, privateMovie, privateSeries]) {
      await expect(page.getByRole("heading", { name: content.name, exact: true })).toBeVisible();
    }
    await privateOnly.check();
    await expect(privateOnly).toBeChecked();
    await expect(page).toHaveURL((url) => url.searchParams.get("privacy") === "private" && url.searchParams.get("q") === prefix);
    await expect(page.getByRole("heading", { name: publicMovie.name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: privateMovie.name, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: privateSeries.name, exact: true })).toBeVisible();

    // 显式输入第一页地址，验证恢复私密筛选后会规范化默认页，且退出时继续清除身份专属条件。
    await page.goto(`/browse?q=${encodeURIComponent(prefix)}&privacy=private&page=1`);
    await expect(privateOnly).toBeChecked();
    await expect(page.getByRole("heading", { name: privateSeries.name, exact: true })).toBeVisible();
    await expect(page).toHaveURL((url) => !url.searchParams.has("page"));
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
    await expect(privateOnly).toHaveCount(0);
    await expect(page).toHaveURL((url) => !url.searchParams.has("privacy") && !url.searchParams.has("page") && url.searchParams.get("q") === prefix);
    await expect(page.getByRole("heading", { name: privateMovie.name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: privateSeries.name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: publicMovie.name, exact: true })).toBeVisible();
  } finally { await api.dispose(); }
});

// 验证超过二十条的公开浏览在匿名与登录阶段保持 facets 可见性、组合筛选、稳定排序和历史恢复。
test("browse combines visible facets, stable sorting, pagination and shared URL restoration", async ({ page, playwright }) => {
  test.setTimeout(240_000);
  const api = await AdminApi.login(playwright);
  const stamp = Date.now();
  const prefix = `Browse Matrix ${stamp}`;
  const user = await api.createUser(`browse-matrix-${stamp}`);
  const publicGenre = await api.write<Genre>("post", "/api/admin/genres", { name: `Public Facet ${stamp}` });
  const privateGenre = await api.write<Genre>("post", "/api/admin/genres", { name: `Private Facet ${stamp}` });
  try {
    const publicMovies = [];
    for (let index = 1; index <= 21; index += 1) {
      publicMovies.push(await createPublishableMovieWithoutPoster(
        api,
        `${prefix} ${String(index).padStart(2, "0")}`,
        { year: index % 2 === 0 ? 2024 : 2025, genreIds: [publicGenre.id] },
      ));
    }
    const privateMovie = await api.setPrivacy("movies", await createPublishableMovieWithoutPoster(
      api, `${prefix} Private`, { year: 2033, genreIds: [privateGenre.id] },
    ), true);

    const anonymousFacets = await (await page.request.get("/api/catalog/facets")).json() as { genres: Genre[]; years: number[] };
    expect(anonymousFacets.genres).toEqual(expect.arrayContaining([expect.objectContaining({ id: publicGenre.id })]));
    expect(anonymousFacets.genres).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: privateGenre.id })]));
    expect(anonymousFacets.years).not.toContain(2033);

    await page.goto(`/browse?q=${encodeURIComponent(prefix)}&sort=name_asc`);
    const cards = page.getByRole("list", { name: "影片目录" }).getByRole("listitem");
    await expect(cards).toHaveCount(20);
    await expect(cards.first().getByRole("heading")).toHaveText(publicMovies[0]!.name);
    await page.getByRole("button", { name: "第 2 页" }).click();
    await expect(page).toHaveURL((url) => url.searchParams.get("page") === "2" && url.searchParams.get("sort") === "name_asc");
    await expect(cards).toHaveCount(1);
    await expect(cards.first().getByRole("heading")).toHaveText(publicMovies[20]!.name);

    await page.getByRole("checkbox", { name: publicGenre.name }).check();
    await page.getByLabel("年份", { exact: true }).selectOption("2024");
    await expect(page).toHaveURL((url) => url.searchParams.get("genres") === publicGenre.id
      && url.searchParams.get("year") === "2024" && !url.searchParams.has("page"));
    const sharedUrl = page.url();
    await expect(cards).toHaveCount(10);
    await cards.first().getByRole("link").click();
    await page.goBack();
    await expect(page).toHaveURL(sharedUrl);
    await expect(page.getByRole("checkbox", { name: publicGenre.name })).toBeChecked();
    await expect(page.getByLabel("年份", { exact: true })).toHaveValue("2024");

    await page.getByRole("button", { name: "登录", exact: true }).click();
    const login = page.getByRole("dialog");
    await login.getByLabel("用户名").fill(user.username);
    await login.getByLabel("密码", { exact: true }).fill("viewer-initial-password");
    await login.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: privateGenre.name })).toBeVisible();
    await page.getByRole("button", { name: "清除全部" }).click();
    await page.getByRole("searchbox", { name: "浏览关键词" }).fill(prefix);
    await page.getByRole("checkbox", { name: privateGenre.name }).check();
    await page.getByRole("checkbox", { name: "只看私密" }).check();
    await expect(page.getByRole("heading", { name: privateMovie.name, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: publicMovies[0]!.name, exact: true })).toHaveCount(0);
  } finally {
    await api.dispose();
  }
});

// 验证公开站登录、本人改密、私密内容刷新及会话撤销。
test("public login and self password change refresh private content and revoke both sessions", async ({ page, playwright }) => {
  const api = await AdminApi.login(playwright);
  const user = await api.createUser(`public-ui-${Date.now()}`);
  const other = await ViewerApi.login(playwright, user.username);
  try {
    const movie = await api.setPrivacy("movies", await createPublishableMovie(api, `Private UI ${Date.now()}`), true);
    await page.goto(`/browse?q=${encodeURIComponent(movie.name)}`);
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
  // 验证较晚返回的操作不会覆盖更新后的用户 Cookie 与界面。
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
    // 保存放行回调以暂缓旧响应，制造登录状态变化后的竞态。
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let received!: () => void;
    // 保存响应到达通知，确保测试先观察旧请求再变更会话。
    const responseReceived = new Promise<void>((resolve) => { received = resolve; });
    let headers: Record<string, string> = {};
    // 拦截目标请求并等待放行，验证迟到响应不会覆盖更新后的会话。
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

// 验证两个独立普通用户会话共享规范进度，且旧设备不能越过另一设备的删除墓碑。
test("viewer progress synchronizes across devices and removal blocks stale replay", async ({ playwright }) => {
  const admin = await AdminApi.login(playwright);
  const user = await admin.createUser(`progress-sync-${Date.now()}`);
  const movie = await createPublishableMovie(admin, `Progress Sync ${Date.now()}`);
  const deviceA = await ViewerApi.login(playwright, user.username);
  const deviceB = await ViewerApi.login(playwright, user.username);
  const headersA = { "X-CSRF-Token": deviceA.csrf, Origin: baseURL };
  const headersB = { "X-CSRF-Token": deviceB.csrf, Origin: baseURL };
  try {
    const playedAt = new Date(Date.now() - 2_000).toISOString();
    const write = await deviceA.request.post("/api/viewer/progress/merge", { headers: headersA, data: {
      progress: [{ kind: "movie", id: movie.id, position_seconds: 0.2, duration_seconds: 120, completed: false, updated_at: playedAt }], cursors: [], removals: [],
    } });
    expect(write.status(), await write.text()).toBe(200);
    await expect((await deviceB.request.get("/api/viewer/progress")).json()).resolves.toEqual(expect.objectContaining({
      progress: [expect.objectContaining({ id: movie.id, position_seconds: 0.2 })],
    }));

    const removedAt = new Date().toISOString();
    const removed = await deviceB.request.delete(`/api/viewer/progress/movie/${movie.id}`, { headers: headersB, data: { removed_at: removedAt } });
    expect(removed.status(), await removed.text()).toBe(200);
    await deviceA.request.post("/api/viewer/progress/merge", { headers: headersA, data: {
      progress: [{ kind: "movie", id: movie.id, position_seconds: 0.4, duration_seconds: 120, completed: false, updated_at: playedAt }], cursors: [], removals: [],
    } });
    await expect((await deviceA.request.get("/api/viewer/progress")).json()).resolves.toEqual(expect.objectContaining({ progress: [] }));
  } finally {
    await deviceA.dispose(); await deviceB.dispose(); await admin.dispose();
  }
});
