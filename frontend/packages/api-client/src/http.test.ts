import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  ApiNetworkError,
  type ApiUploadProgress,
  ApiResponseParseError,
  apiDownload,
  apiUpload,
  apiRequest,
  buildApiUrl,
  clearCsrfToken,
  requiredResponse,
  setCsrfToken,
} from "./http";
import type { JsonObject } from "./dataTypes";

afterEach(() => {
  clearCsrfToken();
  vi.unstubAllGlobals();
});

function respond(body: string | null, init: ResponseInit = {}) {
  return new Response(body, init);
}

class FakeXMLHttpRequest extends EventTarget {
  readonly upload = new EventTarget();
  readonly headers = new Map<string, string>();
  method: string | undefined;
  url: string | undefined;
  body: Document | XMLHttpRequestBodyInit | null | undefined;
  status = 0;
  statusText = "";
  responseText = "";
  private responseHeaders = new Headers();

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body;
  }

  getAllResponseHeaders(): string {
    return [...this.responseHeaders].map(([name, value]) => `${name}: ${value}`).join("\r\n");
  }

  uploadProgress(event: { lengthComputable: boolean; loaded: number; total: number }): void {
    this.upload.dispatchEvent(progressEvent("progress", event));
  }

  finishUpload(): void {
    this.upload.dispatchEvent(new Event("load"));
  }

  respond(status: number, responseText: string, headers: HeadersInit = {}): void {
    this.status = status;
    this.statusText = status === 415 ? "Unsupported Media Type" : "OK";
    this.responseText = responseText;
    this.responseHeaders = new Headers(headers);
    this.dispatchEvent(new Event("load"));
  }

  fail(type: "error" | "timeout" | "abort"): void {
    this.dispatchEvent(new Event(type));
  }
}

function progressEvent(type: string, values: { lengthComputable: boolean; loaded: number; total: number }): ProgressEvent {
  return Object.assign(new Event(type), values) as ProgressEvent;
}

function installFakeXhr(): FakeXMLHttpRequest {
  let instance: FakeXMLHttpRequest | undefined;
  vi.stubGlobal("XMLHttpRequest", class extends FakeXMLHttpRequest {
    constructor() {
      super();
      instance = this;
    }
  });
  return new Proxy({} as FakeXMLHttpRequest, {
    get(_target, property, receiver) {
      if (!instance) throw new Error("XMLHttpRequest was not created");
      const value = Reflect.get(instance, property, receiver);
      return typeof value === "function" ? value.bind(instance) : value;
    },
  });
}

it("requiredResponse preserves values and rejects an absent body", () => {
  expect(requiredResponse({ id: "movie-1" })).toEqual({ id: "movie-1" });
  expect(() => requiredResponse(undefined)).toThrowError(
    new TypeError("Expected an API response body"),
  );
  expect(requiredResponse(null)).toBeNull();
});

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
    ["cyclic JSON", (() => { const value: JsonObject = {}; value.self = value; return value; })()],
    ["BigInt JSON", { value: 1n }],
  ])("does not mislabel %s serialization errors as network failures", async (_label, json) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await apiRequest("/api/admin/movies", { method: "POST", json }).catch(
      (error: Error) => error,
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
      (error: Error) => error,
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

describe("apiUpload", () => {
  it("reports monotonic upload progress and a processing phase", async () => {
    const xhr = installFakeXhr();
    setCsrfToken("session-csrf");
    const events: ApiUploadProgress[] = [];
    const request = apiUpload<{ ok: boolean }>("/api/admin/media/movies/movie-1/video", {
      method: "POST",
      query: { version: 4 },
      body: new FormData(),
      onProgress: (event) => events.push(event),
    });

    xhr.uploadProgress({ lengthComputable: true, loaded: 40, total: 100 });
    xhr.uploadProgress({ lengthComputable: true, loaded: 30, total: 100 });
    xhr.finishUpload();
    xhr.respond(200, '{"ok":true}', { "content-type": "application/json" });

    await expect(request).resolves.toEqual({ ok: true });
    expect(events).toEqual([
      { phase: "uploading", percent: 0 },
      { phase: "uploading", percent: 40 },
      { phase: "uploading", percent: 40 },
      { phase: "processing", percent: 100 },
    ]);
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/admin/media/movies/movie-1/video?version=4");
    expect(xhr.headers.get("accept")).toBe("application/json");
    expect(xhr.headers.get("x-csrf-token")).toBe("session-csrf");
    expect(xhr.headers.has("content-type")).toBe(false);
    expect(xhr.body).toBeInstanceOf(FormData);
  });

  it("reports unknown progress only until a computable percentage is available", async () => {
    const xhr = installFakeXhr();
    const events: ApiUploadProgress[] = [];
    const request = apiUpload("/api/admin/media/movies/movie-1/video", {
      method: "POST",
      body: new FormData(),
      onProgress: (event) => events.push(event),
    });

    xhr.uploadProgress({ lengthComputable: false, loaded: 20, total: 0 });
    expect(events.at(-1)).toEqual({ phase: "uploading", percent: null });
    xhr.uploadProgress({ lengthComputable: true, loaded: 25, total: 100 });
    xhr.uploadProgress({ lengthComputable: false, loaded: 30, total: 0 });
    xhr.respond(204, "");

    await expect(request).resolves.toBeUndefined();
    expect(events).toEqual([
      { phase: "uploading", percent: 0 },
      { phase: "uploading", percent: null },
      { phase: "uploading", percent: 25 },
    ]);
  });

  it("does not replace a computable zero percent with unknown progress", async () => {
    const xhr = installFakeXhr();
    const events: ApiUploadProgress[] = [];
    const request = apiUpload("/api/admin/media/movies/movie-1/video", {
      method: "POST",
      body: new FormData(),
      onProgress: (event) => events.push(event),
    });

    xhr.uploadProgress({ lengthComputable: true, loaded: 0, total: 100 });
    xhr.uploadProgress({ lengthComputable: false, loaded: 0, total: 0 });
    xhr.respond(205, "");

    await expect(request).resolves.toBeUndefined();
    expect(events).toEqual([
      { phase: "uploading", percent: 0 },
      { phase: "uploading", percent: 0 },
    ]);
  });

  it("preserves API response error and parse error semantics", async () => {
    const unsupportedXhr = installFakeXhr();
    const unsupported = apiUpload("/api/admin/media/movies/movie-1/video", {
      method: "POST", body: new FormData(), onProgress: () => undefined,
    });
    unsupportedXhr.respond(415, '{"error":"unsupported media"}', { "content-type": "application/json" });
    await expect(unsupported).rejects.toMatchObject({
      name: "ApiError", status: 415, message: "unsupported media",
    });

    const malformedXhr = installFakeXhr();
    const malformed = apiUpload("/api/admin/media/movies/movie-1/video", {
      method: "POST", body: new FormData(), onProgress: () => undefined,
    });
    malformedXhr.respond(200, "not-json", { "content-type": "application/json" });
    await expect(malformed).rejects.toBeInstanceOf(ApiResponseParseError);
  });

  it.each([
    ["error", false],
    ["timeout", false],
    ["abort", true],
  ] as const)("maps XHR %s events to network errors", async (event, aborted) => {
    const xhr = installFakeXhr();
    const request = apiUpload("/api/admin/media/movies/movie-1/video", {
      method: "POST", body: new FormData(), onProgress: () => undefined,
    });
    xhr.fail(event);
    xhr.respond(200, '{"ignored":true}', { "content-type": "application/json" });

    await expect(request).rejects.toMatchObject({ name: "ApiNetworkError", aborted });
  });
});

describe("apiDownload", () => {
  it("downloads the JSON export through the same-origin authenticated API boundary", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      respond('{"movies":[]}', {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": 'attachment; filename="movie-harbor-content-export-20260916-120000.json"',
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiDownload("/api/admin/contents/export");

    expect(result.filename).toBe("movie-harbor-content-export-20260916-120000.json");
    expect(await result.blob.text()).toContain('"movies"');
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/contents/export");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  it("preserves API error semantics and maps network failures", async () => {
    const responses = [
      respond('{"error":"authentication failed"}', { status: 401, headers: { "content-type": "application/json" } }),
      respond('{"error":"export unavailable"}', { status: 500, headers: { "content-type": "application/json" } }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));

    await expect(apiDownload("/api/admin/contents/export")).rejects.toMatchObject({
      name: "ApiError", status: 401, message: "authentication failed",
    });
    await expect(apiDownload("/api/admin/contents/export")).rejects.toMatchObject({
      name: "ApiError", status: 500, message: "export unavailable",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(apiDownload("/api/admin/contents/export")).rejects.toBeInstanceOf(ApiNetworkError);
  });

  it("uses a fixed safe filename and rejects non-JSON success responses", async () => {
    const responses = [
      respond('{"movies":[]}', {
        headers: {
          "content-type": "application/json",
          "content-disposition": "attachment; filename=../../untrusted.json",
        },
      }),
      respond("not JSON", { headers: { "content-type": "text/plain" } }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));

    await expect(apiDownload("/api/admin/contents/export")).resolves.toMatchObject({
      filename: "movie-harbor-content-export.json",
    });
    await expect(apiDownload("/api/admin/contents/export")).rejects.toBeInstanceOf(ApiResponseParseError);
  });

  it("maps a response blob stream failure to ApiNetworkError", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("connection reset"));
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    })));

    await expect(apiDownload("/api/admin/contents/export")).rejects.toBeInstanceOf(ApiNetworkError);
  });
});
