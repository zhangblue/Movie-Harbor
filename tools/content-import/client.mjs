import { randomBytes } from "node:crypto";
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

export class ImportRequestError extends Error {
  constructor(message, { fatal = false, category = "content", status } = {}) {
    super(message);
    this.name = "ImportRequestError";
    this.fatal = fatal;
    this.category = category;
    this.status = status;
  }
}

function targetOrigin(target) {
  if (typeof target !== "string") throw new ImportRequestError("invalid target origin", { fatal: true, category: "config" });
  let url;
  try { url = new URL(target); } catch { throw new ImportRequestError("invalid target origin", { fatal: true, category: "config" }); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || target.includes("?") || target.includes("#")) {
    throw new ImportRequestError("target must be an HTTP(S) origin without credentials or path", { fatal: true, category: "config" });
  }
  return url.origin;
}

function requestPath(origin, path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("#")) {
    throw new ImportRequestError("invalid API path", { fatal: true, category: "config" });
  }
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new ImportRequestError("invalid API path", { fatal: true, category: "config" });
  return url;
}

function responseError(status) {
  const fatal = !CONTENT_FAILURE_STATUSES.has(status);
  return new ImportRequestError(`request failed (HTTP ${status})`, {
    fatal, category: status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limit" : fatal ? "network" : "content", status,
  });
}

function networkError(reason = "request failed") {
  return new ImportRequestError(reason, { fatal: true, category: "network" });
}

export function createAdminClient(target, { timeoutMs = 30_000, createReadStream = defaultCreateReadStream } = {}) {
  const origin = targetOrigin(target);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ImportRequestError("invalid request timeout", { fatal: true, category: "config" });
  }
  let cookie;
  let csrfToken;

  function request(method, path, { headers = {}, body, writeBody } = {}) {
    const url = requestPath(origin, path);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      let done = false;
      let file;
      let writerDone = !writeBody;
      let requestFinished = false;
      let responseValue;
      let responseReceived = false;
      const req = send(url, { method, headers: { origin, ...(cookie ? { cookie } : {}), ...(csrfToken && !["GET", "HEAD"].includes(method) ? { "x-csrf-token": csrfToken } : {}), ...headers } }, (res) => {
        const chunks = [];
        let size = 0;
        const maxResponseBytes = res.statusCode >= 200 && res.statusCode < 300
          ? MAX_SUCCESS_JSON_BYTES : MAX_ERROR_RESPONSE_BYTES;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            fail(networkError("response exceeds size limit"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", () => fail(networkError("response interrupted")));
        res.on("aborted", () => fail(networkError("response interrupted")));
        res.on("close", () => {
          if (!res.complete) fail(networkError("response interrupted"));
        });
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

      const timer = setTimeout(() => fail(networkError("request timed out")), timeoutMs);
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
      function fail(error) { finish(error); }
      function finishIfComplete() {
        if (writerDone && requestFinished && responseReceived) finish(null, responseValue);
      }
      req.on("error", () => fail(networkError()));
      req.on("close", () => { if (!done) fail(networkError("request interrupted")); });
      req.on("finish", () => {
        requestFinished = true;
        finishIfComplete();
      });
      if (writeBody) {
        Promise.resolve().then(() => {
          if (!done) return writeBody(req, (stream) => {
            file = stream;
            if (done) stream.destroy();
          });
        }).then(() => {
          writerDone = true;
          finishIfComplete();
        }).catch(() => fail(networkError("file upload failed")));
      } else {
        try { req.end(body); } catch { fail(networkError()); }
      }
    });
  }

  async function json(method, path, value) {
    const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
    const { result } = await request(method.toUpperCase(), path, { headers: body ? { "content-type": "application/json", "content-length": String(body.length) } : {}, body });
    return result;
  }

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

  async function upload(path, media) {
    const localPath = media?.localPath;
    const byteSize = media?.byteSize;
    const fileName = media?.fileName ?? (typeof localPath === "string" ? basename(localPath) : "");
    const mimeType = MIME_TYPES.get(extname(fileName).toLowerCase());
    if (typeof localPath !== "string" || !Number.isSafeInteger(byteSize) || byteSize < 0 ||
        !fileName || /[\r\n"\\\0/]/.test(fileName) || !mimeType) {
      throw new ImportRequestError("invalid upload media", { category: "content" });
    }
    const boundary = `movie-harbor-${randomBytes(16).toString("hex")}`;
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const contentLength = prefix.length + byteSize + suffix.length;
    const { result } = await request("POST", path, {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(contentLength) },
      async writeBody(req, setFile) {
        const file = createReadStream(localPath);
        setFile(file);
        async function write(chunk) {
          if (!req.write(chunk)) await new Promise((resolve, reject) => {
            function drained() { req.off("error", failed); resolve(); }
            function failed(error) { req.off("drain", drained); reject(error); }
            req.once("drain", drained);
            req.once("error", failed);
          });
        }
        await write(prefix);
        let sent = 0;
        for await (const chunk of file) {
          sent += chunk.length;
          if (sent > byteSize) throw new Error("file size changed");
          await write(chunk);
        }
        if (sent !== byteSize) throw new Error("file size changed");
        req.end(suffix);
      },
    });
    return result;
  }

  return { login, json, upload };
}
