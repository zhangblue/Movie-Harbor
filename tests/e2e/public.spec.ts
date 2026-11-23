import { expect, test } from "@playwright/test";
import { AdminApi, ViewerApi, baseURL, createPublishableMovie, createPublishableSeries } from "./helpers";

// 验证已发布内容可搜索并显示公开详情。
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
    await page.goto(`/?q=${encodeURIComponent(prefix)}`);
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

    // 显式使用第一页以匹配三条内容的测试数据，验证保存的私密筛选地址可恢复且退出时会清除。
    await page.goto(`/?q=${encodeURIComponent(prefix)}&privacy=private&page=1`);
    await expect(privateOnly).toBeChecked();
    await expect(page.getByRole("heading", { name: privateSeries.name, exact: true })).toBeVisible();
    await expect(page).toHaveURL((url) => url.searchParams.get("page") === "1");
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
    await expect(privateOnly).toHaveCount(0);
    await expect(page).toHaveURL((url) => !url.searchParams.has("privacy") && !url.searchParams.has("page") && url.searchParams.get("q") === prefix);
    await expect(page.getByRole("heading", { name: privateMovie.name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: privateSeries.name, exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: publicMovie.name, exact: true })).toBeVisible();
  } finally { await api.dispose(); }
});

// 验证公开站登录、本人改密、私密内容刷新及会话撤销。
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

// 验证账号首页续播公开电影和私密剧集，并在实际退出后隐藏记录。
test("signed-in home resumes a public movie and a private episode", async ({ page, playwright }) => {
  const api = await AdminApi.login(playwright);
  try {
    const stamp = Date.now();
    const user = await api.createUser(`resume-${stamp}`);
    const movie = await createPublishableMovie(api, `Resume Movie ${stamp}`);
    const series = await api.setPrivacy("series", await createPublishableSeries(api, `Resume Series ${stamp}`), true);
    const episode = series.seasons[0]!.episodes[0]!;
    await page.goto("/");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    const login = page.getByRole("dialog");
    await login.getByLabel("用户名").fill(user.username);
    await login.getByLabel("密码", { exact: true }).fill("viewer-initial-password");
    await login.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
    // 写入已观看记录，使短媒体测试素材能覆盖剩余时长规则。
    await page.evaluate(({ viewerId, movieId, seriesId, episodeId }) => {
      const updatedAt = Date.now();
      localStorage.setItem(`movie-harbor:playback:v1:viewer:${viewerId}`, JSON.stringify({
        version: 1,
        recentEpisodes: {},
        progress: {
          [`movie:${movieId}`]: { position: 0.2, duration: 120, updatedAt },
          [`episode:${episodeId}`]: { position: 0.2, duration: 120, updatedAt, seriesId },
        },
      }));
    }, { viewerId: user.id, movieId: movie.id, seriesId: series.id, episodeId: episode.id });
    await page.reload();
    const section = page.getByRole("region", { name: "继续观看" });
    await expect(section.getByRole("link", { name: new RegExp(movie.name) })).toBeVisible();
    await section.getByRole("link", { name: new RegExp(series.name) }).click();
    await expect(page).toHaveURL(new RegExp(`/series/${series.id}/play/${episode.id}\\?resume=1$`));
    await expect(page.getByTestId("native-video")).toBeVisible();
    await page.goto("/");
    // 返回首页时本地缓存和服务端规范快照都必须仍保留未完成电影，避免异步单集同步误删其他目标。
    await expect.poll(() => page.evaluate(({ viewerId, movieId }) => {
      const raw = localStorage.getItem(`movie-harbor:playback:v1:viewer:${viewerId}`);
      return raw ? Boolean(JSON.parse(raw).progress?.[`movie:${movieId}`]) : false;
    }, { viewerId: user.id, movieId: movie.id })).toBe(true);
    await expect.poll(async () => {
      const snapshot = await (await page.request.get("/api/viewer/progress")).json() as { progress: Array<{ id: string }> };
      return snapshot.progress.some((item) => item.id === movie.id);
    }).toBe(true);
    await section.getByRole("link", { name: new RegExp(movie.name) }).click();
    await expect(page).toHaveURL(new RegExp(`/movies/${movie.id}/play\\?resume=1$`));
    await expect(page.getByTestId("native-video")).toBeVisible();
    await page.goto("/");
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
    await expect(section).toHaveCount(0);
  } finally {
    await api.dispose();
  }
});

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
