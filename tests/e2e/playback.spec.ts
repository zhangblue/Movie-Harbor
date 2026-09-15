import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AdminApi, createPublishableMovie, mediaHostDirs, restartCompose, storageComposeConfig, snapshotMediaFiles, uploadedSince, video as videoFixture, withPrivateMediaSentinels, type Movie } from "./helpers";

test("two isolated volumes support playback, replacement, deletion and restart without private-path exposure", async ({ page, playwright, request }) => {
  test.setTimeout(120_000);
  expect(mediaHostDirs).toHaveLength(2);
  const config = storageComposeConfig();
  expect(config.services.api.environment.MEDIA_DIRS).toBe("/media/volumes/0;/media/volumes/1");
  for (const service of ["api", "media-init", "caddy"]) {
    const mounts = config.services[service].volumes.filter((mount: { target: string }) => mount.target.includes("/media/volumes/"));
    expect(mounts.map((mount: { source: string }) => mount.source)).toEqual(mediaHostDirs);
    expect(mounts.map((mount: { target: string }) => mount.target)).toEqual(service === "caddy"
      ? ["/srv/media/volumes/0", "/srv/media/volumes/1"] : ["/media/volumes/0", "/media/volumes/1"]);
    expect(mounts.every((mount: { read_only?: boolean }) => Boolean(mount.read_only) === (service === "caddy"))).toBe(true);
  }
  async function expectPrivateStorage() {
    for (const [volume, directory] of mediaHostDirs.entries()) {
      expect(JSON.parse(readFileSync(join(directory, ".movie-harbor-volume.json"), "utf8"))).toEqual({ version: 1, volume });
      for (const internal of [".incoming", ".quarantine"]) {
        expect(readdirSync(join(directory, internal))).toEqual([]);
      }
      expect((await request.get(`/media/v${volume}/.movie-harbor-volume.json`)).status()).toBe(404);
      expect((await request.get(`/media/volumes/${volume}/.movie-harbor-volume.json`)).status()).toBe(404);
      expect((await request.get(`/media/v${volume}/poster/`)).status()).toBe(404);
    }
    await withPrivateMediaSentinels(async () => {
      for (const [volume, directory] of mediaHostDirs.entries()) {
        for (const internal of [".incoming", ".quarantine"]) {
          expect(readFileSync(join(directory, internal, "e2e-private-sentinel"), "utf8")).toBe("private");
          expect((await request.get(`/media/v${volume}/${internal}/e2e-private-sentinel`)).status()).toBe(404);
        }
      }
    });
  }
  await expectPrivateStorage();
  expect((await request.get("/media/.incoming/e2e-private-sentinel")).status()).toBe(404);
  expect((await request.get("/media/.quarantine/e2e-private-sentinel")).status()).toBe(404);
  const api = await AdminApi.login(playwright);
  const before = snapshotMediaFiles();
  let movie = await createPublishableMovie(api, `Range Movie ${Date.now()}`);
  const details = await request.get(`/api/catalog/movies/${movie.id}`);
  const body = await details.json();
  expect(body.poster_url).toMatch(/^\/media\/v0\/poster\//);
  expect(body.video_url).toMatch(/^\/media\/v0\/video\//);
  expect((await request.get(body.video_url)).status()).toBe(200);
  const originalFiles = uploadedSince(before);
  expect(originalFiles).toHaveLength(2);
  expect(originalFiles.every((file) => file.startsWith(`${mediaHostDirs[0]}/`))).toBe(true);
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

  movie = await api.write<Movie>("post", `/api/admin/movies/${movie.id}/archive`, { version: movie.version });
  movie = await api.write<Movie>("post", `/api/admin/movies/${movie.id}/draft`, { version: movie.version });
  const replaced = await api.upload<{ version: number }>(`/api/admin/media/movies/${movie.id}/video?version=${movie.version}`, videoFixture());
  expect((await request.get(body.video_url)).status()).toBe(404);
  const oldVideo = originalFiles.find((file) => file.includes("/video/"))!;
  expect(existsSync(oldVideo)).toBe(false);
  movie = await api.write<Movie>("post", `/api/admin/movies/${movie.id}/publish`, { version: replaced.version });
  const replacement = await (await request.get(`/api/catalog/movies/${movie.id}`)).json();
  expect(replacement.video_url).toMatch(/^\/media\/v0\/video\//);
  expect(replacement.video_url).not.toBe(body.video_url);
  expect((await request.get(replacement.video_url)).status()).toBe(200);
  const allFiles = [...originalFiles, ...uploadedSince(before)];
  movie = await api.write<Movie>("post", `/api/admin/movies/${movie.id}/archive`, { version: movie.version });
  await api.write("delete", `/api/admin/movies/${movie.id}`, { version: movie.version });
  for (const file of allFiles) expect(existsSync(file)).toBe(false);
  expect(snapshotMediaFiles()).toEqual(before);
  await expectPrivateStorage();
  await restartCompose();
  expect((await request.get(`/api/catalog/movies/${movie.id}`)).status()).toBe(404);
  for (const url of [body.poster_url, body.video_url, replacement.video_url]) expect((await request.get(url)).status()).toBe(404);
  expect(snapshotMediaFiles()).toEqual(before);
  await expectPrivateStorage();
  await api.dispose();
});
