import { expect, test } from "@playwright/test";
import { AdminApi, adminName, baseURL, changedPassword, initialPassword, loadState } from "./helpers";

test("database, media and changed password survive restart without environment overwrite", async ({ playwright, request }) => {
  const state = loadState<{ movieId: string; videoUrl: string }>();
  const oldContext = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
  const oldLogin = await oldContext.post("/api/admin/login", { data: { name: adminName, password: initialPassword } });
  expect(oldLogin.status()).toBe(401);
  await oldContext.dispose();

  const api = await AdminApi.login(playwright, changedPassword);
  expect((await request.get(`/api/catalog/movies/${state.movieId}`)).status()).toBe(200);
  const media = await request.get(state.videoUrl, { headers: { Range: "bytes=0-15" } });
  expect(media.status()).toBe(206);
  expect((await media.body()).byteLength).toBe(16);

  const restored = await api.request.post("/api/admin/password", {
    data: { current_password: changedPassword, new_password: initialPassword },
    headers: { Origin: baseURL, "X-CSRF-Token": api.csrf },
  });
  expect(restored.status()).toBe(204);
  await api.dispose();
});
