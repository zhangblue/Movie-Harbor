import { isJsonObject, normalizeError, type CaughtValue, type JsonObject, type JsonValue } from "./dataTypes";

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue | readonly QueryValue[]>;

export interface ApiRequestInit<JsonBody extends object = Record<string, never>> extends Omit<RequestInit, "body"> {
  body?: BodyInit | null;
  json?: JsonBody;
  query?: Query;
}

export interface ApiDownload {
  blob: Blob;
  filename: string;
}

export type ApiUploadProgress =
  | { phase: "uploading"; percent: number | null }
  | { phase: "processing"; percent: 100 };

export interface ApiUploadInit {
  method: "POST";
  body: FormData;
  query?: Query;
  onProgress: (progress: ApiUploadProgress) => void;
}

export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly details: JsonValue | undefined;

  constructor(status: number, statusText: string, message: string, details: JsonValue | undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
    this.details = details;
  }
}

export class ApiNetworkError extends Error {
  readonly aborted: boolean;
  override readonly cause: Error;

  constructor(cause: Error) {
    const aborted = cause instanceof DOMException && cause.name === "AbortError";
    super(aborted ? "Request was aborted" : "Unable to reach the server", { cause });
    this.name = "ApiNetworkError";
    this.aborted = aborted;
    this.cause = cause;
  }
}

export class ApiResponseParseError extends Error {
  readonly status: number;
  override readonly cause: Error;

  constructor(status: number, cause: Error) {
    super("The server returned invalid JSON", { cause });
    this.name = "ApiResponseParseError";
    this.status = status;
    this.cause = cause;
  }
}

let csrfToken: string | undefined;

export function setCsrfToken(token: string | null | undefined): void {
  const normalized = token?.trim();
  csrfToken = normalized || undefined;
}

export function clearCsrfToken(): void {
  csrfToken = undefined;
}

export function requiredResponse<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("Expected an API response body");
  return value;
}

export function apiPath(...segments: Array<string | number>): string {
  return `/api/${segments.map((segment) => encodeURIComponent(String(segment))).join("/")}`;
}

export function buildApiUrl(path: string, query?: Query): string {
  const validationBase = "https://movie-harbor.invalid";
  let normalized: URL;
  try {
    normalized = new URL(path, validationBase);
  } catch {
    throw new TypeError("API requests require a same-origin /api path");
  }
  if (
    !/^\/api(?:\/|$)/.test(path) ||
    normalized.origin !== validationBase ||
    normalized.pathname !== path ||
    normalized.search !== "" ||
    normalized.hash !== "" ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new TypeError("API requests require a same-origin /api path");
  }
  if (!query) return path;

  const params = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(query)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value !== undefined && value !== null) params.append(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

export async function apiRequest<ResponseBody = JsonValue, JsonBody extends object = Record<string, never>>(
  path: string,
  init: ApiRequestInit<JsonBody> = {},
): Promise<ResponseBody | undefined> {
  const response = await performApiFetch(path, init);
  if (response.status === 204 || response.status === 205) return undefined;
  return parseApiResponse<ResponseBody>(response);
}

export async function apiDownload(
  path: string,
  init: ApiRequestInit = {},
): Promise<ApiDownload> {
  const response = await performApiFetch(path, init);
  if (!isJsonContentType(response.headers.get("content-type"))) {
    throw new ApiResponseParseError(response.status, new TypeError("Expected a JSON download response"));
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch (cause) {
    throw new ApiNetworkError(normalizeError(cause as CaughtValue));
  }
  return { blob, filename: downloadFilename(response.headers.get("content-disposition")) };
}

export function apiUpload<T>(path: string, init: ApiUploadInit): Promise<T | undefined> {
  const url = buildApiUrl(path, init.query);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastPercent: number | null = 0;
    let hasComputableProgress = false;
    let settled = false;

    const rejectNetwork = (cause: CaughtValue) => {
      if (settled) return;
      settled = true;
      reject(new ApiNetworkError(normalizeError(cause)));
    };

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        if (!hasComputableProgress) init.onProgress({ phase: "uploading", percent: null });
        return;
      }
      hasComputableProgress = true;
      lastPercent = Math.max(lastPercent ?? 0, Math.min(100, Math.floor(event.loaded / event.total * 100)));
      init.onProgress({ phase: "uploading", percent: lastPercent });
    });
    xhr.upload.addEventListener("load", () => init.onProgress({ phase: "processing", percent: 100 }));
    xhr.addEventListener("load", () => {
      if (settled) return;
      settled = true;
      void resolveXhrResponse<T>(xhr).then(resolve, reject);
    });
    xhr.addEventListener("error", () => rejectNetwork(new TypeError("XMLHttpRequest error")));
    xhr.addEventListener("timeout", () => rejectNetwork(new TypeError("XMLHttpRequest timeout")));
    xhr.addEventListener("abort", () => rejectNetwork(new DOMException("Request was aborted", "AbortError")));

    xhr.open(init.method, url, true);
    xhr.setRequestHeader("Accept", "application/json");
    if (csrfToken) xhr.setRequestHeader("X-CSRF-Token", csrfToken);
    init.onProgress({ phase: "uploading", percent: 0 });
    xhr.send(init.body);
  });
}

async function performApiFetch<JsonBody extends object>(path: string, init: ApiRequestInit<JsonBody>): Promise<Response> {
  const { query, json, body, ...requestInit } = init;
  if (json !== undefined && body !== undefined) {
    throw new TypeError("Use either json or body, not both");
  }

  const method = (requestInit.method ?? "GET").toUpperCase();
  const url = buildApiUrl(path, query);
  const headers = new Headers(requestInit.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (json !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (csrfToken && isUnsafeAdminRequest(url, method) && !headers.has("X-CSRF-Token")) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  const requestBody = json === undefined ? body : JSON.stringify(json);

  let response: Response;
  try {
    response = await fetch(url, {
      ...requestInit,
      method,
      headers,
      credentials: "same-origin",
      body: requestBody,
    });
  } catch (cause) {
    throw new ApiNetworkError(normalizeError(cause as CaughtValue));
  }

  if (!response.ok) throw await responseError(response);
  return response;
}

async function parseApiResponse<T>(response: Response): Promise<T | undefined> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new ApiNetworkError(normalizeError(cause as CaughtValue));
  }
  const expectsJson = isJsonContentType(response.headers.get("content-type"));
  let parsed: JsonValue | undefined = text;
  if (text && expectsJson) {
    try {
      parsed = JSON.parse(text) as JsonValue;
    } catch (cause) {
      throw new ApiResponseParseError(response.status, normalizeError(cause as CaughtValue));
    }
  } else if (!text) {
    parsed = undefined;
  }
  return parsed as T | undefined;
}

async function resolveXhrResponse<T>(xhr: XMLHttpRequest): Promise<T | undefined> {
  const response = new Response(
    xhr.status === 204 || xhr.status === 205 ? null : xhr.responseText,
    { status: xhr.status, statusText: xhr.statusText, headers: xhrResponseHeaders(xhr.getAllResponseHeaders()) },
  );
  if (!response.ok) throw await responseError(response);
  if (response.status === 204 || response.status === 205) return undefined;
  return parseApiResponse<T>(response);
}

function xhrResponseHeaders(rawHeaders: string): Headers {
  const headers = new Headers();
  for (const line of rawHeaders.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) headers.append(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return headers;
}

async function responseError(response: Response): Promise<ApiError> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new ApiNetworkError(normalizeError(cause as CaughtValue));
  }
  const expectsJson = isJsonContentType(response.headers.get("content-type"));
  let parsed: JsonValue | undefined = text;
  if (text && expectsJson) {
    try {
      parsed = JSON.parse(text) as JsonValue;
    } catch {
      parsed = undefined;
    }
  } else if (!text) {
    parsed = undefined;
  }
  return new ApiError(response.status, response.statusText, errorMessage(parsed, text, response.statusText), parsed);
}

function isJsonContentType(contentType: string | null): boolean {
  const normalized = contentType?.toLowerCase() ?? "";
  return normalized.includes("application/json") || normalized.includes("+json");
}

function downloadFilename(contentDisposition: string | null): string {
  const match = contentDisposition?.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;\s]*))/i);
  const filename = match?.[1] ?? match?.[2];
  return filename && /^movie-harbor-content-export-\d{8}-\d{6}\.json$/.test(filename)
    ? filename
    : "movie-harbor-content-export.json";
}

function isUnsafeAdminRequest(url: string, method: string): boolean {
  return url.startsWith("/api/admin/") && !["GET", "HEAD", "OPTIONS"].includes(method);
}

function errorMessage(parsed: JsonValue | undefined, rawText: string, statusText: string): string {
  if (isJsonObject(parsed)) {
    const record: JsonObject = parsed;
    for (const key of ["error", "message"]) {
      if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
    }
  }
  if (typeof parsed === "string" && parsed.trim()) return parsed.trim().slice(0, 512);
  if (rawText && !rawText.trim().startsWith("<")) return rawText.trim().slice(0, 512);
  return statusText || "Request failed";
}
