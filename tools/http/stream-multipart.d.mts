// NodeNext/.mjs declaration entry; keep in sync with stream-multipart.d.ts.
import type { Readable, Writable } from 'node:stream';
export interface MultipartMetadata { fileName: string; mimeType: string; byteSize: number; field?: string }
export interface MultipartHeaders { 'content-type': string; 'content-length': string }
export interface MultipartWriteOptions {
  createStream?: (path: string) => Readable;
  onStream?: (stream: Readable) => void;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}
export function multipartParts(metadata: MultipartMetadata): { headers: MultipartHeaders; prefix: Buffer; suffix: Buffer };
export function writeChunk(request: Writable, chunk: Uint8Array): Promise<void>;
export function createMultipartFileBody(media: MultipartMetadata & { localPath: string }): {
  headers: MultipartHeaders;
  writeTo(request: Writable, options?: MultipartWriteOptions): Promise<void>;
};
