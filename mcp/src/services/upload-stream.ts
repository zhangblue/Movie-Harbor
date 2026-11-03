import { constants, type BigIntStats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Writable } from 'node:stream';
import { createMultipartFileBody, type MultipartWriteOptions } from '../../../tools/http/stream-multipart.mjs';
import { MovieHarborClientError } from './error-mapper.js';
import { revalidateAllowedFile, type CheckedFile } from './path-policy.js';

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
    try {
      await multipart.writeTo(request, { ...options, createStream: () => handle!.createReadStream({ autoClose: false }) });
      // 流写完后再核验原路径，避免上传期间被替换仍报告成功。
      await revalidateAllowedFile(file, roots);
    } catch (error) {
      if (error instanceof MovieHarborClientError) throw error;
      // 读取或传输失败时优先识别文件变化，使调用方知道需要重新检查。
      try { await revalidateAllowedFile(file, roots); }
      catch { throw new MovieHarborClientError('file_changed'); }
      throw new MovieHarborClientError('network_error');
    } finally { await handle.close(); }
  } };
}
