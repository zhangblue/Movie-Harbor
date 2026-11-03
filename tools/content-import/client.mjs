import { createMultipartFileBody } from "../http/stream-multipart.mjs";
import { createReadStream as defaultCreateReadStream } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, extname } from "node:path";

const MAX_SUCCESS_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;
const CONTENT_FAILURE_STATUSES = new Set([400, 404, 409, 413, 415, 422]);
const MIME_TYPES = new Map([
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".png", "image/png"], [".webp", "image/webp"],
  [".mp4", "video/mp4"], [".webm", "video/webm"],
]);

// 记录导入请求的错误类别与是否致命，供导入流程决定继续还是停止。
export class ImportRequestError extends Error {
  // 构造带状态和分类的请求错误，供认证、网络及内容失败时使用。
  constructor(message, { fatal = false, category = "content", status } = {}) {
    super(message);
    this.name = "ImportRequestError";
    this.fatal = fatal;
    this.category = category;
    this.status = status;
  }
}

// 创建客户端时校验目标来源，拒绝凭据、路径及非 HTTP 协议。
function targetOrigin(target) {
  if (typeof target !== "string") throw new ImportRequestError("invalid target origin", { fatal: true, category: "config" });
  let url;
  try { url = new URL(target); } catch { throw new ImportRequestError("invalid target origin", { fatal: true, category: "config" }); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || target.includes("?") || target.includes("#")) {
    throw new ImportRequestError("target must be an HTTP(S) origin without credentials or path", { fatal: true, category: "config" });
  }
  return url.origin;
}

// 发送请求前限制 API 路径属于目标来源，防止请求被重定向到其他主机。
function requestPath(origin, path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("#")) {
    throw new ImportRequestError("invalid API path", { fatal: true, category: "config" });
  }
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new ImportRequestError("invalid API path", { fatal: true, category: "config" });
  return url;
}

// 收到非成功状态时分类错误，区分单条内容失败和需要中止的故障。
function responseError(status) {
  const fatal = !CONTENT_FAILURE_STATUSES.has(status);
  return new ImportRequestError(`request failed (HTTP ${status})`, {
    fatal, category: status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limit" : fatal ? "network" : "content", status,
  });
}

// 将传输异常转换为致命网络错误，供请求各阶段统一处理。
function networkError(reason = "request failed") {
  return new ImportRequestError(reason, { fatal: true, category: "network" });
}

// 创建保存会话和 CSRF 令牌的管理客户端，供导入流程登录及上传。
export function createAdminClient(target, { timeoutMs = 30_000, createReadStream = defaultCreateReadStream } = {}) {
  const origin = targetOrigin(target);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ImportRequestError("invalid request timeout", { fatal: true, category: "config" });
  }
  let cookie;
  let csrfToken;

  // 执行单次管理 API 请求，并协调响应、请求完成和上传流的结束。
  function request(method, path, { headers = {}, body, writeBody } = {}) {
    const url = requestPath(origin, path);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    // 建立请求生命周期，确保发送、接收和文件写入都完成后才返回。
    return new Promise((resolve, reject) => {
      let done = false;
      let file;
      let writerDone = !writeBody;
      let requestFinished = false;
      let responseValue;
      let responseReceived = false;
      // 发出受限目标的请求；响应回调收集并校验结果后参与统一完成判断。
      const req = send(url, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(csrfToken && !["GET", "HEAD"].includes(method) ? { "x-csrf-token": csrfToken } : {}), ...headers } }, (res) => {
        progress();
        const chunks = [];
        let size = 0;
        const maxResponseBytes = res.statusCode >= 200 && res.statusCode < 300
          ? MAX_SUCCESS_JSON_BYTES : MAX_ERROR_RESPONSE_BYTES;
        // 收到响应数据时刷新上传空闲计时并限制缓冲，超限即终止请求。
        res.on("data", (chunk) => {
          progress();
          size += chunk.length;
          if (size > maxResponseBytes) {
            fail(networkError("response exceeds size limit"));
            return;
          }
          chunks.push(chunk);
        });
        // 响应出错或中止都按网络失败处理，避免返回不完整数据。
        res.on("error", () => fail(networkError("response interrupted")));
        res.on("aborted", () => fail(networkError("response interrupted")));
        // 响应关闭时核对完整性，提前关闭则报告网络错误。
        res.on("close", () => {
          if (!res.complete) fail(networkError("response interrupted"));
        });
        // 响应结束后校验状态与 JSON，再等待请求和上传流完成。
        res.on("end", () => {
          if (done) return;
          if (!res.complete) return fail(networkError("response interrupted"));
          if (res.statusCode < 200 || res.statusCode >= 300) return fail(responseError(res.statusCode));
          let result = null;
          const data = Buffer.concat(chunks).toString("utf8");
          if (data) {
            try { result = JSON.parse(data); } catch { return fail(networkError("invalid JSON response")); }
          }
          responseValue = { result, headers: res.headers };
          responseReceived = true;
          finishIfComplete();
        });
      });

      // 超时回调终止未完成请求；上传进度会刷新计时器。
      const timer = setTimeout(() => fail(networkError("request timed out")), timeoutMs);
      // Uploads may run for hours: only inactivity is bounded. JSON retains its total deadline.
      // 上传有进展时刷新空闲超时，避免长时间正常上传被错误中断。
      function progress() { if (writeBody && !done) timer.refresh(); }
      // 请求结束时只结算一次并清理定时器；失败时关闭文件和请求流。
      function finish(error, value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) {
          file?.destroy();
          req.destroy();
          reject(error);
        } else resolve(value);
      }
      // 传输失败时通过统一收尾路径拒绝请求。
      function fail(error) { finish(error); }
      // 仅在写入、请求发送和响应均完成后返回成功，避免提前响应掩盖上传失败。
      function finishIfComplete() {
        if (writerDone && requestFinished && responseReceived) finish(null, responseValue);
      }
      // 请求连接错误和提前关闭均进入统一失败清理。
      req.on("error", () => fail(networkError()));
      req.on("close", () => { if (!done) fail(networkError("request interrupted")); });
      // 请求正文发送完成后记录状态，与响应及上传写入共同决定成功。
      req.on("finish", () => {
        progress();
        requestFinished = true;
        finishIfComplete();
      });
      if (writeBody) {
        // 异步启动文件写入以捕获同步及异步异常，并在失败时关闭请求。
        Promise.resolve().then(() => {
          // 登记打开的文件流；若请求已结束立即销毁，避免流泄漏。
          if (!done) return writeBody(req, (stream) => {
            file = stream;
            if (done) stream.destroy();
          }, progress);
        // 文件写入完成后仍需等待请求发送和完整响应，防止提前成功。
        }).then(() => {
          writerDone = true;
          finishIfComplete();
        // 写入失败统一转为致命网络错误并执行清理。
        }).catch(() => fail(networkError("file upload failed")));
      } else {
        try { req.end(body); } catch { fail(networkError()); }
      }
    });
  }

  // 序列化管理 API 请求并返回解析结果，供登录和导入步骤调用。
  async function json(method, path, value) {
    const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
    const { result } = await request(method.toUpperCase(), path, { headers: body ? { "content-type": "application/json", "content-length": String(body.length) } : {}, body });
    return result;
  }

  // 登录管理员并读取 CSRF 令牌；会话读取失败时丢弃 Cookie，避免使用不完整认证。
  async function login(name, password) {
    cookie = undefined;
    csrfToken = undefined;
    const body = Buffer.from(JSON.stringify({ name, password }));
    const loginResponse = await request("POST", "/api/admin/login", { headers: { "content-type": "application/json", "content-length": String(body.length) }, body });
    const setCookies = loginResponse.headers["set-cookie"] ?? [];
    const sessionCookie = setCookies.map((value) => /^mh_session=([^;]+)/.exec(value)).find(Boolean);
    if (!sessionCookie) throw networkError("login response missing session cookie");
    cookie = `mh_session=${sessionCookie[1]}`;
    try {
      const session = await json("GET", "/api/admin/session");
      if (typeof session?.csrf_token !== "string" || !session.csrf_token) throw networkError("session response missing CSRF token");
      csrfToken = session.csrf_token;
      return session;
    } catch (error) {
      cookie = undefined;
      throw error;
    }
  }

  // 校验媒体元数据并流式上传，供电影和剧集媒体导入步骤调用。
  async function upload(path, media) {
    const localPath = media?.localPath;
    const byteSize = media?.byteSize;
    const fileName = media?.fileName ?? (typeof localPath === "string" ? basename(localPath) : "");
    const mimeType = MIME_TYPES.get(extname(fileName).toLowerCase());
    if (typeof localPath !== "string" || !Number.isSafeInteger(byteSize) || byteSize < 0 ||
        !fileName || /[\r\n"\\\0/]/.test(fileName) || !mimeType) {
      throw new ImportRequestError("invalid upload media", { category: "content" });
    }
    let multipart;
    try { multipart = createMultipartFileBody({ localPath, fileName, mimeType, byteSize }); }
    catch { throw new ImportRequestError("invalid upload media", { category: "content" }); }
    const { result } = await request("POST", path, {
      headers: multipart.headers,
      // 将 multipart 正文写入请求，并登记文件流以便失败时关闭。
      writeBody(req, setFile, progress) {
        return multipart.writeTo(req, { createStream: createReadStream, onStream: setFile, onProgress: progress });
      },
    });
    return result;
  }

  return { login, json, upload };
}
