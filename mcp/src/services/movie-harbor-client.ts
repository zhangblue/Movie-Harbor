import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isAbsolute, relative, sep } from 'node:path';
import type { McpConfig } from '../config.js';
import { MovieHarborClientError, mapHttpError } from './error-mapper.js';
import type { CheckedFile } from './path-policy.js';
import { createUploadStream } from './upload-stream.js';
export { MovieHarborClientError } from './error-mapper.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH';
export type Progress = (sentBytes: number, totalBytes: number) => void;
export interface MovieHarborClient {
  json<T>(method: HttpMethod, path: string, body?: unknown): Promise<T>;
  upload<T>(path: string, file: CheckedFile, mimeType: string, onProgress?: Progress): Promise<T>;
}
export interface ClientDependencies { signal?: AbortSignal }

type Upload = ReturnType<typeof createUploadStream>;
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

export function createMovieHarborClient(config: McpConfig, dependencies: ClientDependencies = {}): MovieHarborClient {
  // Copy the authentication target so later mutation cannot redirect credentials.
  const baseUrl = new URL(config.baseUrl.href);
  const apiKey = config.apiKey;
  const roots = [...config.allowedRoots];
  const generatedRoot = config.generatedRoot;
  const timeoutMs = config.requestTimeoutMs;

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
      function progress() { if (upload && !done) timer.refresh(); }
      function cleanup() { clearTimeout(timer); dependencies.signal?.removeEventListener('abort', aborted); }
      function fail(error: MovieHarborClientError) {
        if (done) return;
        done = true;
        cleanup();
        controller.abort();
        response?.destroy();
        req?.destroy();
        reject(error);
      }
      function aborted() { fail(new MovieHarborClientError('network_error')); }
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
            if (!success) { fail(mapHttpError(status, parsed, apiKey)); return; }
            value = parsed as T;
            responseReceived = true;
            finishIfComplete();
          });
        });
        req.on('error', () => fail(new MovieHarborClientError('network_error')));
        req.on('close', () => {
          // A complete exchange may close while the fd post-validation is still pending.
          if (!requestFinished || !responseReceived) fail(new MovieHarborClientError('network_error'));
        });
        req.on('finish', () => { requestFinished = true; finishIfComplete(); });
        if (upload) {
          upload.writeTo(req, { signal: controller.signal, onProgress(sent, total) {
            progress(); onProgress?.(sent, total);
          } }).then(() => { writerDone = true; finishIfComplete(); })
            .catch(error => fail(error instanceof MovieHarborClientError ? error : new MovieHarborClientError('network_error')));
        } else req.end(body);
      } catch { fail(new MovieHarborClientError('network_error')); }
    });
  }

  return {
    async json<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
      const url = controlledUrl(baseUrl, path);
      if (!['GET', 'POST', 'PATCH'].includes(method)) throw new MovieHarborClientError('invalid_path');
      let encoded: Buffer | undefined;
      try { if (body !== undefined) encoded = Buffer.from(JSON.stringify(body)); }
      catch { throw new MovieHarborClientError('invalid_response'); }
      return request<T>(method, url, encoded);
    },
    async upload<T>(path: string, file: CheckedFile, mimeType: string, onProgress?: Progress): Promise<T> {
      const url = controlledUrl(baseUrl, path);
      const generatedRelative = relative(generatedRoot, file.realPath);
      const inGeneratedRoot = !isAbsolute(generatedRelative) && generatedRelative.split(sep)[0] !== '..';
      return request<T>('POST', url, undefined, createUploadStream(file, inGeneratedRoot ? [generatedRoot] : roots, mimeType), onProgress);
    },
  };
}
