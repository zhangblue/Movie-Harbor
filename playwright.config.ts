import { defineConfig } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:18080";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "public", testMatch: /public\.spec\.ts/ },
    { name: "series", testMatch: /series\.spec\.ts/, dependencies: ["public"] },
    { name: "export", testMatch: /export\.spec\.ts/, dependencies: ["series"] },
    { name: "playback", testMatch: /playback\.spec\.ts/, dependencies: ["export"] },
    { name: "pagination", testMatch: /pagination\.spec\.ts/, dependencies: ["playback"] },
    { name: "admin", testMatch: /admin\.spec\.ts/, dependencies: ["pagination"] },
    { name: "persistence", testMatch: /persistence\.spec\.ts/ },
  ],
});
