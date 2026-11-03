import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isAbsolute, relative, sep } from 'node:path';
import type { McpConfig } from '../config.js';
import { MovieHarborClientError, mapHttpError } from './error-mapper.js';
import type { CheckedFile } from './path-policy.js';
import { createUploadStream } from './upload-stream.js';
export { MovieHarborClientError } from './error-mapper.js';

// 限定客户端允许发送的管理 API 方法。
export type HttpMethod = 'GET' | 'POST' | 'PATCH';
// 描述上传时报告文件字节进度的回调。
export type Progress = (sentBytes: number, totalBytes: number) => void;
// 定义工具访问管理 API 和上传文件的接口。
export interface MovieHarborClient {
  // 工具调用管理 API 时编码 JSON 请求。
  json<T>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
  // 工具上传媒体时选择正确的受控目录并发送文件流。
  upload<T>(path: string, file: CheckedFile, mimeType: string, onProgress?: Progress): Promise<T>;
}
// 描述创建客户端时可注入的取消信号。
export interface ClientDependencies { signal?: AbortSignal }

// 描述请求阶段使用的流式上传对象。
type Upload = ReturnType<typeof createUploadStream>;
// 发送请求前限制目标为同源管理接口。
function controlledUrl(baseUrl: URL, path: string): URL {
  try {
    if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.pathname !== '/'
      || baseUrl.search || baseUrl.hash || typeof path !== 'string' || !path.startsWith('/api/admin/')
      || /[\\\u0000-\u0020\u007f#]/.test(path)) throw new Error();
    const url = new URL(path, baseUrl);
    const decoded = decodeURIComponent(url.pathname);
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || /%2f/i.test(url.pathname)
      || url.origin !== baseUrl.origin || url.username || url.password || !url.pathname.startsWith('/api/admin/')
      || !new URL(decoded, baseUrl).pathname.startsWith('/api/admin/')) throw new Error();
    return url;
  } catch { throw new MovieHarborClientError('invalid_path'); }
}

// 创建持有固定认证目标和路径策略的管理 API 客户端。
export function createMovieHarborClient(config: McpConfig, dependencies: ClientDependencies = {}): MovieHarborClient {
  // 固定认证目标，防止配置对象后续变化将 Bearer 凭据发送到其他地址。
  const baseUrl = new URL(config.baseUrl.href);
  const apiKey = config.apiKey;
  const roots = [...config.allowedRoots];
  const generatedRoot = config.generatedRoot;
  const timeoutMs = config.requestTimeoutMs;

  // 请求管理 API 时协调超时、响应、上传和取消。
  function request<T>(method: HttpMethod, url: URL, body?: Buffer, upload?: Upload, onProgress?: Progress): Promise<T> {
    return new Promise((resolve, reject) => {
      let done = false;
      let req: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      let writerDone = !upload;
      let requestFinished = false;
      let responseReceived = false;
      let value: T;
      const controller = new AbortController();
      const timer = setTimeout(() => fail(new MovieHarborClientError('timeout')), timeoutMs);
      // 上传或接收进展时刷新不活动超时。
      function progress() { if (upload && !done) timer.refresh(); }
      // 请求结束时移除定时器与取消监听。
      function cleanup() { clearTimeout(timer); dependencies.signal?.removeEventListener('abort', aborted); }
      // 请求失败时只结算一次并关闭相关资源。
      function fail(error: MovieHarborClientError) {
        if (done) return;
        done = true;
        cleanup();
        controller.abort();
        response?.destroy();
        req?.destroy();
        reject(error);
      }
      // 收到取消信号时以安全网络错误结束请求。
      function aborted() { fail(new MovieHarborClientError('network_error')); }
      // 上传、请求和响应均完成后才返回结果。
      function finishIfComplete() {
        if (!done && writerDone && requestFinished && responseReceived) {
          done = true; cleanup(); resolve(value);
        }
      }
      dependencies.signal?.addEventListener('abort', aborted, { once: true });
      if (dependencies.signal?.aborted) { aborted(); return; }
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      try {
        req = send(url, { method, headers: {
          authorization: `Bearer ${apiKey}`,
          ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}),
          ...upload?.headers,
        } }, res => {
          response = res;
          progress();
          const chunks: Buffer[] = [];
          let size = 0;
          const status = res.statusCode ?? 0;
          const success = status >= 200 && status < 300;
          const limit = success ? 16 * 1024 * 1024 : 64 * 1024;
          res.on('data', (chunk: Buffer) => {
            if (done) return;
            progress(); size += chunk.length;
            if (size > limit) { fail(new MovieHarborClientError('response_too_large', status)); return; }
            chunks.push(chunk);
          });
          res.on('error', () => fail(new MovieHarborClientError('network_error')));
          res.on('close', () => { if (!res.complete) fail(new MovieHarborClientError('network_error')); });
          res.on('end', () => {
            if (done) return;
            if (!res.complete) { fail(new MovieHarborClientError('network_error')); return; }
            let parsed: unknown = null;
            try { if (size) parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
            catch {
              if (success) { fail(new MovieHarborClientError('invalid_response', status)); return; }
            }
            // 非成功响应统一映射并清理远端字段，避免将服务端信息或密钥泄露给工具调用方。
            if (!success) { fail(mapHttpError(status, parsed, apiKey)); return; }
            value = parsed as T;
            responseReceived = true;
            finishIfComplete();
          });
        });
        req.on('error', () => fail(new MovieHarborClientError('network_error')));
        req.on('close', () => {
          // 完整响应可能先于文件句柄的上传后复验结束，因此仅在交换未完成时判错。
          if (!requestFinished || !responseReceived) fail(new MovieHarborClientError('network_error'));
        });
        req.on('finish', () => { requestFinished = true; finishIfComplete(); });
        if (upload) {
          upload.writeTo(req, { signal: controller.signal, /* 上传进度到来时刷新超时并转发给调用方。 */ onProgress(sent, total) {
            progress(); onProgress?.(sent, total);
          } }).then(() => { writerDone = true; finishIfComplete(); })
            .catch(error => fail(error instanceof MovieHarborClientError ? error : new MovieHarborClientError('network_error')));
        } else req.end(body);
      } catch { fail(new MovieHarborClientError('network_error')); }
    });
  }

  return {
    // 工具调用管理 API 时编码 JSON 请求。
    async json<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
      // 发出认证请求前限制地址；路径越界时不发送任何网络请求。
      const url = controlledUrl(baseUrl, path);
      if (!['GET', 'POST', 'PATCH'].includes(method)) throw new MovieHarborClientError('invalid_path');
      let encoded: Buffer | undefined;
      try { if (body !== undefined) encoded = Buffer.from(JSON.stringify(body)); }
      catch { throw new MovieHarborClientError('invalid_response'); }
      return request<T>(method, url, encoded);
    },
    // 工具上传媒体时选择正确的受控目录并发送文件流。
    async upload<T>(path: string, file: CheckedFile, mimeType: string, onProgress?: Progress): Promise<T> {
      const url = controlledUrl(baseUrl, path);
      const generatedRelative = relative(generatedRoot, file.realPath);
      const inGeneratedRoot = !isAbsolute(generatedRelative) && generatedRelative.split(sep)[0] !== '..';
      // 输出目录与用户输入目录分别限制，流式读取并复验身份，避免扩展任意文件访问权限。
      return request<T>('POST', url, undefined, createUploadStream(file, inGeneratedRoot ? [generatedRoot] : roots, mimeType), onProgress);
    },
  };
}
