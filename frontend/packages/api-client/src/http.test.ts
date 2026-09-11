import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  ApiNetworkError,
  apiRequest,
  buildApiUrl,
  clearCsrfToken,
  setCsrfToken,
} from "./http";

afterEach(() => {
  clearCsrfToken();
  vi.unstubAllGlobals();
});

function respond(body: string | null, init: ResponseInit = {}) {
  return new Response(body, init);
}

describe("buildApiUrl", () => {
  it("encodes query values without allowing them to change the path", () => {
    expect(buildApiUrl("/api/catalog", { q: "Alien & /? #", kind: "movie", empty: undefined })).toBe(
      "/api/catalog?q=Alien+%26+%2F%3F+%23&kind=movie",
    );
  });

  it.each([
    "https://evil.example/api",
    "//evil.example/api",
    "/media/file.mp4",
    "api/catalog",
    "/api/catalog/../admin/session",
    "/api/%2e%2e/admin/session",
  ])(
    "rejects a non-api or cross-origin URL: %s",
    (url) => expect(() => buildApiUrl(url)).toThrow(/same-origin \/api/),
  );
});

describe("apiRequest", () => {
  it("uses a relative same-origin API URL and sends the browser session", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      respond('{"items":[]}', { headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/catalog", { query: { page: 2 } });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/catalog?page=2");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  it("preserves caller headers while applying JSON defaults", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      respond('{"ok":true}', { headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/admin/movies", {
      method: "POST",
      headers: { "X-Trace-Id": "trace-1", Accept: "application/vnd.movie+json" },
      json: { name: "Moon" },
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("x-trace-id")).toBe("trace-1");
    expect(headers.get("accept")).toBe("application/vnd.movie+json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(init.body).toBe('{"name":"Moon"}');
  });

  it.each([
    ["cyclic JSON", (() => { const value: Record<string, unknown> = {}; value.self = value; return value; })()],
    ["BigInt JSON", { value: 1n }],
  ])("does not mislabel %s serialization errors as network failures", async (_label, json) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await apiRequest("/api/admin/movies", { method: "POST", json }).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ApiNetworkError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds CSRF only to unsafe admin methods and never overwrites a caller header", async () => {
    setCsrfToken("session-csrf");
    const headers: Array<Headers> = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return respond(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/admin/session");
    await apiRequest("/api/catalog", { method: "POST" });
    await apiRequest("/api/admin/movies", { method: "POST" });
    await apiRequest("/api/admin/movies/1", {
      method: "PATCH",
      headers: { "X-CSRF-Token": "explicit" },
    });

    expect(headers.map((value) => value.get("x-csrf-token"))).toEqual([
      null,
      null,
      "session-csrf",
      "explicit",
    ]);
  });

  it("returns undefined for a 204 response without trying to parse it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(null, { status: 204 })));
    await expect(apiRequest("/api/admin/logout", { method: "POST" })).resolves.toBeUndefined();
  });

  it("parses JSON and plain-text successful responses", async () => {
    const responses = [
      respond('{"name":"admin"}', { headers: { "content-type": "application/json; charset=utf-8" } }),
      respond("ready", { headers: { "content-type": "text/plain" } }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));

    await expect(apiRequest("/api/admin/session")).resolves.toEqual({ name: "admin" });
    await expect(apiRequest("/api/health")).resolves.toBe("ready");
  });

  it("exposes structured JSON errors without losing field details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        respond('{"error":"movie validation failed","fields":["poster","video"]}', {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const error = await apiRequest("/api/admin/movies/1/publish", { method: "POST" }).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      message: "movie validation failed",
      details: { error: "movie validation failed", fields: ["poster", "video"] },
    });
  });

  it("uses a useful bounded message for non-JSON and malformed JSON errors", async () => {
    const responses = [
      respond("proxy unavailable", { status: 502, statusText: "Bad Gateway" }),
      respond("<not-json>", {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "content-type": "application/json" },
      }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));

    await expect(apiRequest("/api/health")).rejects.toMatchObject({ message: "proxy unavailable" });
    await expect(apiRequest("/api/health")).rejects.toMatchObject({ message: "Internal Server Error" });
  });

  it("distinguishes aborts from other network failures", async () => {
    const abort = new DOMException("cancelled", "AbortError");
    const fetchMock = vi.fn().mockRejectedValueOnce(abort).mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiRequest("/api/catalog")).rejects.toMatchObject({
      name: "ApiNetworkError",
      aborted: true,
      cause: abort,
    });
    await expect(apiRequest("/api/catalog")).rejects.toMatchObject({
      name: "ApiNetworkError",
      aborted: false,
    });
  });

  it("reports a response stream failure as a network failure", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("connection reset"));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));

    await expect(apiRequest("/api/catalog")).rejects.toMatchObject({
      name: "ApiNetworkError",
      aborted: false,
    });
  });
});
