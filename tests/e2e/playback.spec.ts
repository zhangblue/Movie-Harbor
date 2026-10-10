import { expect, test } from "@playwright/test";
import { request as rawRequest } from "node:http";
import { AdminApi, baseURL, createMovieDraftWithMedia, createPublishableMovie, createSeriesDraftWithMedia, video, type Movie, type Series } from "./helpers";

test("media supports byte ranges and the public player uses the media URL", async ({ page, playwright, request }) => {
  expect((await request.get("/media/.incoming/e2e-private-sentinel")).status()).toBe(404);
  expect((await request.get("/media/.quarantine/e2e-private-sentinel")).status()).toBe(404);
  const api = await AdminApi.login(playwright);
  const movie = await createPublishableMovie(api, `Range Movie ${Date.now()}`);
  const details = await request.get(`/api/catalog/movies/${movie.id}`);
  const body = await details.json();
  const range = await request.get(body.video_url, { headers: { Range: "bytes=0-31" } });
  expect(range.status()).toBe(206);
  expect(range.headers()["content-range"]).toMatch(/^bytes 0-31\/\d+$/);
  expect((await range.body()).byteLength).toBe(32);
  await page.goto(`/movies/${movie.id}/play`);
  const video = page.getByTestId("native-video");
  await expect(video).toHaveAttribute("src", body.video_url);
  await expect(page.getByRole("status")).toHaveText("视频已可以播放");
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  await api.dispose();
});

test("media authorization applies to posters, movie and episode ranges, lifecycle and logout", async ({ playwright, request }) => {
  const api = await AdminApi.login(playwright);
  const username = `media-viewer-${Date.now()}`;
  await api.write("post", "/api/admin/users", { username, password: "media-viewer-password" });
  const viewer = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  try {
    let movie = await createPublishableMovie(api, `Protected Movie ${Date.now()}`);
    let series = await createSeriesDraftWithMedia(api, `Protected Series ${Date.now()}`, {
      synopsis: "media authorization", seasonNumber: 1, episodeNumber: 1, episodeName: "Published", durationSeconds: 1,
    });
    const season = series.seasons[0];
    const episode = season.episodes[0];
    const episodesPath = `/api/admin/series/${series.id}/seasons/${season.id}/episodes`;
    const published = await api.write<{ series_version: number }>("post", `${episodesPath}/${episode.id}/publish`, { version: episode.version });
    series = await api.write<Series>("post", `/api/admin/series/${series.id}/publish`, { version: published.series_version });
    series = await api.write<Series>("post", episodesPath, { version: series.version, number: 2, name: "Draft" });
    const draftEpisode = series.seasons[0].episodes.find((item) => item.number === 2)!;
    await api.upload(`/api/admin/media/episodes/${draftEpisode.id}/video?version=${draftEpisode.version}`, video());
    series = await api.get<Series>(`/api/admin/series/${series.id}`);
    const draft = await createMovieDraftWithMedia(api, `Draft Media ${Date.now()}`, { synopsis: "draft", durationSeconds: 1 });
    const publishedUrls = [movie.poster!.url, movie.video!.url, series.poster!.url, episode.video!.url];
    const draftUrls = [draft.poster!.url, draft.video!.url, series.seasons[0].episodes.find((item) => item.number === 2)!.video!.url];
    for (const url of publishedUrls) expect((await request.get(url)).status()).toBe(200);
    for (const url of draftUrls) {
      expect((await request.get(url)).status()).toBe(404);
      expect((await api.request.get(url)).status()).toBe(200);
    }
    movie = await api.write<Movie>("put", `/api/admin/movies/${movie.id}/privacy`, { version: movie.version, is_private: true });
    series = await api.write<Series>("put", `/api/admin/series/${series.id}/privacy`, { version: series.version, is_private: true });
    expect((await request.get(`/api/catalog/series/${series.id}`)).status()).toBe(404);
    expect((await (await request.get(`/api/catalog?q=${encodeURIComponent(series.name)}`)).json()).items).toEqual([]);
    for (const url of publishedUrls) {
      const denied = await request.get(url, { headers: { Range: "bytes=0-1" } });
      expect(denied.status()).toBe(404);
      expect(denied.headers()["cache-control"]).toBe("private, no-store");
      expect((await api.request.get(url)).status()).toBe(200);
    }
    expect((await viewer.post("/api/viewer/login", { data: { username, password: "media-viewer-password" } })).status()).toBe(200);
    const seriesDetails = await viewer.get(`/api/catalog/series/${series.id}`);
    expect(seriesDetails.status()).toBe(200);
    const visibleSeries = await seriesDetails.json();
    expect(visibleSeries.is_private).toBe(true);
    expect(visibleSeries.seasons.flatMap((item: { episodes: Array<{ id: string }> }) => item.episodes).map((item: { id: string }) => item.id)).toEqual([episode.id]);
    for (const url of publishedUrls) {
      const response = await viewer.get(url);
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toBe("private, no-store");
    }
    for (const url of draftUrls) expect((await viewer.get(url)).status()).toBe(404);
    for (const url of [movie.video!.url, episode.video!.url]) {
      const range = await viewer.get(url, { headers: { Range: "bytes=0-1" } });
      expect(range.status()).toBe(206);
      expect(range.headers()["content-range"]).toMatch(/^bytes 0-1\/\d+$/);
      expect(await range.body()).toEqual(video().buffer.subarray(0, 2));
      expect((await viewer.head(url)).status()).toBe(200);
      const full = await viewer.get(url);
      expect((await request.get(url, { headers: { "If-None-Match": full.headers().etag } })).status()).toBe(404);
    }
    const oldCookies = (await viewer.storageState()).cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const session = await (await viewer.get("/api/viewer/session")).json();
    expect((await viewer.post("/api/viewer/logout", { headers: { "X-CSRF-Token": session.csrf_token } })).status()).toBe(204);
    for (const url of publishedUrls) {
      expect((await viewer.get(url)).status()).toBe(404);
      expect((await request.get(url, { headers: { Cookie: oldCookies } })).status()).toBe(404);
    }
    // Published resources become inaccessible immediately after archive, including child episodes.
    movie = await api.write<Movie>("post", `/api/admin/movies/${movie.id}/archive`, { version: movie.version });
    series = await api.write<Series>("post", `/api/admin/series/${series.id}/archive`, { version: series.version });
    await viewer.post("/api/viewer/login", { data: { username, password: "media-viewer-password" } });
    for (const url of publishedUrls) {
      expect((await viewer.get(url)).status()).toBe(404);
      expect((await api.request.get(url)).status()).toBe(200);
    }
  } finally { await viewer.dispose(); await api.dispose(); }
});

test("Caddy rejects unsafe original paths and external authorization probes", async ({ playwright, request }) => {
  const api = await AdminApi.login(playwright);
  try {
    const movie = await createPublishableMovie(api, `Canonical Media ${Date.now()}`);
    const url = movie.video!.url;
    expect((await request.get(`${url}?download=1`)).status()).toBe(200);
    for (const path of [
      "/api/media/authorize", "/media", "/media/", "/media/.incoming/e2e-private-sentinel",
      "/media/.quarantine/e2e-private-sentinel", url.replace("/video/", "/video//"),
      url.replace("/video/", "/video/../video/"), url.replace("/video/", "/%76ideo/"),
      url.replace("/video/", "/video%2f"), url.replace("/video/", "/video/%2e%2e/video/"),
      url.replace("/video/", "/video/%252e%252e/video/"), `${url}/extra`,
      "/media/video/aa/aa000000000000000000000000000000.mp4",
    ]) {
      // Use the raw request target so the HTTP client cannot normalize traversal before Caddy sees it.
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = rawRequest(baseURL, { path, headers: { "X-Forwarded-Uri": url, "X-Movie-Harbor-Proxy-Token": "forged" } }, (response) => {
          response.resume(); response.on("end", () => resolve(response.statusCode));
        });
        req.on("error", reject); req.end();
      });
      expect(status, path).toBe(404);
    }
  } finally { await api.dispose(); }
});
