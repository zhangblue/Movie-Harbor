import { afterEach, expect, it, vi } from "vitest";

import { changePassword, createGenre, getSession } from "./admin";
import { ApiError, clearCsrfToken } from "./http";

afterEach(() => {
  clearCsrfToken();
  vi.unstubAllGlobals();
});

it("acquires the session CSRF token in memory for later admin writes", async () => {
  const requests: RequestInit[] = [];
  const responses = [
    new Response('{"name":"管理员","csrf_token":"from-session"}', {
      headers: { "content-type": "application/json" },
    }),
    new Response('{"id":"genre-1","name":"剧情","sort_order":1,"enabled":true}', {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  ];
  vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    return responses.shift()!;
  }));

  await getSession();
  await createGenre("剧情");

  expect(new Headers(requests[0]?.headers).get("x-csrf-token")).toBeNull();
  expect(new Headers(requests[1]?.headers).get("x-csrf-token")).toBe("from-session");
});

it("keeps the session CSRF token when a password change is rejected", async () => {
  const requests: RequestInit[] = [];
  const responses = [
    new Response('{"name":"管理员","csrf_token":"still-valid"}', {
      headers: { "content-type": "application/json" },
    }),
    new Response('{"error":"authentication failed"}', {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
    new Response('{"id":"genre-1","name":"剧情","sort_order":1,"enabled":true}', {
      status: 201,
      headers: { "content-type": "application/json" },
    }),
  ];
  vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(init ?? {});
    return responses.shift()!;
  }));

  await getSession();
  await expect(changePassword({ current_password: "wrong", new_password: "new-secret" })).rejects.toBeInstanceOf(ApiError);
  await createGenre("剧情");

  expect(new Headers(requests[2]?.headers).get("x-csrf-token")).toBe("still-valid");
});
