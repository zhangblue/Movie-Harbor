import { constants, type BigIntStats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Writable } from 'node:stream';
import { createMultipartFileBody, type MultipartWriteOptions } from '../../../tools/http/stream-multipart.mjs';
import { MovieHarborClientError } from './error-mapper.js';
import { revalidateAllowedFile, type CheckedFile } from './path-policy.js';

// 文件变化发生在正文可能已完整发送之后时，额外标记写入结果需要远端核对。
export class UploadFileChangedAfterSendError extends MovieHarborClientError {
  // 上传进入可能提交的阶段后发现文件变化，保留通用文件变化码供现有调用方使用。
  constructor() {
    super('file_changed');
    this.name = 'UploadFileChangedAfterSendError';
  }
}

// 重新检查文件时比较保存的身份信息。
function sameIdentity(file: CheckedFile, info: BigIntStats): boolean {
  const expected = file.identity;
  return info.isFile() && info.dev === expected.dev && info.ino === expected.ino
    && Number(info.size) === expected.size && Number(info.mtimeNs) / 1_000_000 === expected.mtimeMs;
}

// 上传前后核验文件身份并从固定句柄流式写入请求。
export function createUploadStream(file: CheckedFile, roots: string[], mimeType: string) {
  let multipart: ReturnType<typeof createMultipartFileBody>;
  try {
    multipart = createMultipartFileBody({ localPath: file.realPath, fileName: basename(file.realPath),
      byteSize: file.identity.size, mimeType });
  } catch { throw new MovieHarborClientError('file_changed'); }
  return { headers: multipart.headers, /* 实际上传时核验文件并向请求写入 multipart 数据。 */ async writeTo(request: Writable, options: Omit<MultipartWriteOptions, 'createStream'> = {}) {
    let handle: FileHandle | undefined;
    try {
      // 打开前复验路径并禁止符号链接替换，后续始终从同一文件句柄读取。
      await revalidateAllowedFile(file, roots);
      handle = await open(file.realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!sameIdentity(file, await handle.stat({ bigint: true }))) throw new MovieHarborClientError('file_changed');
    } catch {
      await handle?.close();
      throw new MovieHarborClientError('file_changed');
    }
    let fileBytesSent = false;
    let bodySent = false;
    try {
      await multipart.writeTo(request, {
        ...options,
        // multipart 复用已验证句柄，关闭责任留给外层 finally。
        createStream: () => handle!.createReadStream({ autoClose: false }),
        // 记录最后一个文件字节交给请求的时机，之后结束边界可能已经到达后端。
        onProgress(sent, total) {
          fileBytesSent = sent === total;
          options.onProgress?.(sent, total);
        },
      });
      bodySent = true;
      // 正文写完后仍须核验原路径；此时身份变化不能推断远端未提交。
      await revalidateAllowedFile(file, roots);
    } catch (error) {
      if (bodySent) throw new UploadFileChangedAfterSendError();
      if (error instanceof MovieHarborClientError) throw error;
      // 传输提前结束时仍识别文件变化；若最后的边界可能已送达，则保留提交不确定性。
      try { await revalidateAllowedFile(file, roots); }
      catch {
        if (fileBytesSent || request.writableFinished) throw new UploadFileChangedAfterSendError();
        throw new MovieHarborClientError('file_changed');
      }
      throw new MovieHarborClientError('network_error');
    } finally { await handle.close(); }
  } };
}
