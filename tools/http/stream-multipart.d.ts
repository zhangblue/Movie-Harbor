// 通用声明兼容副本；更新时须同步 stream-multipart.d.mts，重新生成可能覆盖本文件的说明。
import type { Readable, Writable } from 'node:stream';
// 上传前提供文件名、类型、长度和表单字段，供构造 multipart 正文使用。
export interface MultipartMetadata { fileName: string; mimeType: string; byteSize: number; field?: string }
// 描述上传请求所需的内容类型和长度，供调用方设置请求头。
export interface MultipartHeaders { 'content-type': string; 'content-length': string }
// 配置上传时的流创建、进度通知和取消信号。
export interface MultipartWriteOptions {
  createStream?: (path: string) => Readable;
  onStream?: (stream: Readable) => void;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}
// 上传前构造 multipart 请求头及固定前后缀。
export function multipartParts(metadata: MultipartMetadata): { headers: MultipartHeaders; prefix: Buffer; suffix: Buffer };
// 上传时顺序写入一块数据，处理请求关闭或写入错误。
export function writeChunk(request: Writable, chunk: Uint8Array): Promise<void>;
// 为本地媒体创建流式上传正文，调用 writeTo 时发送至请求。
export function createMultipartFileBody(media: MultipartMetadata & { localPath: string }): {
  headers: MultipartHeaders;
  // 上传时将文件流和边界写入请求，并按选项处理进度或取消。
  writeTo(request: Writable, options?: MultipartWriteOptions): Promise<void>;
};
