import { isJsonObject, normalizeError, type CaughtValue, type JsonObject, type JsonValue } from "./dataTypes";

// API 查询参数允许的标量；空值由 URL 构造器省略。
export type QueryValue = string | number | boolean | null | undefined;
// API 查询参数的键值映射，支持多值并由 URL 构造器编码。
export type Query = Record<string, QueryValue | readonly QueryValue[]>;

// 普通 API 请求支持原生请求选项以及互斥的 body、json 和查询参数。
export interface ApiRequestInit<JsonBody extends object = Record<string, never>> extends Omit<RequestInit, "body"> {
  body?: BodyInit | null;
  json?: JsonBody;
  query?: Query;
}

// 管理导出下载结果，包含文件内容和经过校验的文件名。
export interface ApiDownload {
  blob: Blob;
  filename: string;
}

// 上传回调的两个阶段：传输时百分比可未知，服务端处理时为 100。
export type ApiUploadProgress =
  | { phase: "uploading"; percent: number | null }
  | { phase: "processing"; percent: 100 };

// 带进度的媒体上传所需 POST 表单、查询参数和进度回调。
export interface ApiUploadInit {
  method: "POST";
  body: FormData;
  query?: Query;
  onProgress: (progress: ApiUploadProgress) => void;
}

// HTTP 失败响应的状态、消息和可选 JSON 详情，供页面按状态处理。
export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly details: JsonValue | undefined;

  // 在请求返回失败状态时保存 HTTP 状态、消息和响应详情。
  constructor(status: number, statusText: string, message: string, details: JsonValue | undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
    this.details = details;
  }
}

// 网络或读取失败的原因及中止标记，供调用方区分网络异常。
export class ApiNetworkError extends Error {
  readonly aborted: boolean;
  override readonly cause: Error;

  // 在请求中断或网络失败时保存原因和中断标记。
  constructor(cause: Error) {
    const aborted = cause instanceof DOMException && cause.name === "AbortError";
    super(aborted ? "Request was aborted" : "Unable to reach the server", { cause });
    this.name = "ApiNetworkError";
    this.aborted = aborted;
    this.cause = cause;
  }
}

// 成功响应的 JSON 无法解析时携带 HTTP 状态和原始原因。
export class ApiResponseParseError extends Error {
  readonly status: number;
  override readonly cause: Error;

  // 在响应 JSON 无法解析时保存状态和原始原因。
  constructor(status: number, cause: Error) {
    super("The server returned invalid JSON", { cause });
    this.name = "ApiResponseParseError";
    this.status = status;
    this.cause = cause;
  }
}

let csrfToken: string | undefined;

// 在会话恢复后保存规范化 CSRF 令牌，供后续受保护写请求使用。
export function setCsrfToken(token: string | null | undefined): void {
  const normalized = token?.trim();
  csrfToken = normalized || undefined;
}

// 在身份结束或切换时清除内存中的 CSRF 令牌。
export function clearCsrfToken(): void {
  csrfToken = undefined;
}

// 在调用方需要响应体时拒绝空响应，避免后续使用缺失数据。
export function requiredResponse<T>(value: T | undefined): T {
  if (value === undefined) throw new TypeError("Expected an API response body");
  return value;
}

// 在构造 API 路径时编码各段，避免标识符改变路径结构。
export function apiPath(...segments: Array<string | number>): string {
  return `/api/${segments.map((segment) => encodeURIComponent(String(segment))).join("/")}`;
}

// 在发送请求前校验同源 API 路径并编码查询参数。
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

// 发送普通 API 请求并解析响应，供领域 API 调用。
export async function apiRequest<ResponseBody = JsonValue, JsonBody extends object = Record<string, never>>(
  path: string,
  init: ApiRequestInit<JsonBody> = {},
): Promise<ResponseBody | undefined> {
  const response = await performApiFetch(path, init);
  if (response.status === 204 || response.status === 205) return undefined;
  return parseApiResponse<ResponseBody>(response);
}

// 请求并校验 JSON 下载内容，供管理导出使用。
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

// 上传媒体并通知进度，供带进度反馈的上传流程使用。
export function apiUpload<T>(path: string, init: ApiUploadInit): Promise<T | undefined> {
  const url = buildApiUrl(path, init.query);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastPercent: number | null = 0;
    let hasComputableProgress = false;
    let settled = false;

    // 上传发生网络异常时统一拒绝一次请求，避免重复完成。
    const rejectNetwork = (cause: CaughtValue) => {
      if (settled) return;
      settled = true;
      reject(new ApiNetworkError(normalizeError(cause)));
    };

    // 传输期间先报告不可计算进度；一旦得到百分比就保持单调，避免界面倒退。
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        if (!hasComputableProgress) init.onProgress({ phase: "uploading", percent: null });
        return;
      }
      hasComputableProgress = true;
      lastPercent = Math.max(lastPercent ?? 0, Math.min(100, Math.floor(event.loaded / event.total * 100)));
      init.onProgress({ phase: "uploading", percent: lastPercent });
    });
    // 请求体传完不代表服务端已处理完成；切换阶段让界面继续等待最终响应。
    xhr.upload.addEventListener("load", () => init.onProgress({ phase: "processing", percent: 100 }));
    // 服务端响应到达后才解析结果或错误并完成 Promise，避免把传输完成误当作成功。
    xhr.addEventListener("load", () => {
      if (settled) return;
      settled = true;
      void resolveXhrResponse<T>(xhr).then(resolve, reject);
    });
    // 网络错误、超时和中止均通过同一完成保护拒绝，交给调用方展示失败。
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

// 在普通请求发送前设置凭据与 CSRF，并将失败转换为统一错误。
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
  if (csrfToken && isUnsafeSessionRequest(url, method) && !headers.has("X-CSRF-Token")) {
    // 只给会话写请求附加令牌，服务端据此验证操作来源。
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

  // 在返回给领域接口前统一转换失败响应，保留状态供界面判断。
  if (!response.ok) throw await responseError(response);
  return response;
}

// 读取成功响应并解析 JSON，供请求和上传结果复用。
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

// 上传完成后将 XHR 响应转换为统一解析结果或错误。
async function resolveXhrResponse<T>(xhr: XMLHttpRequest): Promise<T | undefined> {
  const response = new Response(
    xhr.status === 204 || xhr.status === 205 ? null : xhr.responseText,
    { status: xhr.status, statusText: xhr.statusText, headers: xhrResponseHeaders(xhr.getAllResponseHeaders()) },
  );
  if (!response.ok) throw await responseError(response);
  if (response.status === 204 || response.status === 205) return undefined;
  return parseApiResponse<T>(response);
}

// 在处理上传响应时解析原始响应头。
function xhrResponseHeaders(rawHeaders: string): Headers {
  const headers = new Headers();
  for (const line of rawHeaders.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) headers.append(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return headers;
}

// 将失败响应转换为带状态和详情的 API 错误，供界面区分失败原因。
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

// 判断响应是否声明 JSON 类型，供解析和下载校验使用。
function isJsonContentType(contentType: string | null): boolean {
  const normalized = contentType?.toLowerCase() ?? "";
  return normalized.includes("application/json") || normalized.includes("+json");
}

// 从导出响应提取安全文件名，异常时使用默认名称。
function downloadFilename(contentDisposition: string | null): string {
  const match = contentDisposition?.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;\s]*))/i);
  const filename = match?.[1] ?? match?.[2];
  return filename && /^movie-harbor-content-export-\d{8}-\d{6}\.json$/.test(filename)
    ? filename
    : "movie-harbor-content-export.json";
}

// 判断是否为受会话保护的写请求，以决定是否附加 CSRF 令牌。
function isUnsafeSessionRequest(url: string, method: string): boolean {
  return (url.startsWith("/api/admin/") || url.startsWith("/api/viewer/")) && !["GET", "HEAD", "OPTIONS"].includes(method);
}

// 从失败响应提取可展示的错误文本，供统一错误转换使用。
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
