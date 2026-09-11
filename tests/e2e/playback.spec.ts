import { expect, test } from "@playwright/test";
import { AdminApi, createPublishableMovie } from "./helpers";

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
