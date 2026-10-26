import { constants, type BigIntStats } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Writable } from 'node:stream';
import { createMultipartFileBody, type MultipartWriteOptions } from '../../../tools/http/stream-multipart.mjs';
import { MovieHarborClientError } from './error-mapper.js';
import { revalidateAllowedFile, type CheckedFile } from './path-policy.js';

function sameIdentity(file: CheckedFile, info: BigIntStats): boolean {
  const expected = file.identity;
  return info.isFile() && info.dev === expected.dev && info.ino === expected.ino
    && Number(info.size) === expected.size && Number(info.mtimeNs) / 1_000_000 === expected.mtimeMs;
}

export function createUploadStream(file: CheckedFile, roots: string[], mimeType: string) {
  let multipart: ReturnType<typeof createMultipartFileBody>;
  try {
    multipart = createMultipartFileBody({ localPath: file.realPath, fileName: basename(file.realPath),
      byteSize: file.identity.size, mimeType });
  } catch { throw new MovieHarborClientError('file_changed'); }
  return { headers: multipart.headers, async writeTo(request: Writable, options: Omit<MultipartWriteOptions, 'createStream'> = {}) {
    let handle: FileHandle | undefined;
    try {
      await revalidateAllowedFile(file, roots);
      // Refuse a symlink substituted at the canonical path; read from this fd thereafter.
      handle = await open(file.realPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!sameIdentity(file, await handle.stat({ bigint: true }))) throw new MovieHarborClientError('file_changed');
    } catch {
      await handle?.close();
      throw new MovieHarborClientError('file_changed');
    }
    try {
      await multipart.writeTo(request, { ...options, createStream: () => handle!.createReadStream({ autoClose: false }) });
      // The shared writer closes its source stream; verify the original path again after delivery.
      await revalidateAllowedFile(file, roots);
    } catch (error) {
      if (error instanceof MovieHarborClientError) throw error;
      // A changed file takes precedence over an incidental read/transport failure.
      try { await revalidateAllowedFile(file, roots); }
      catch { throw new MovieHarborClientError('file_changed'); }
      throw new MovieHarborClientError('network_error');
    } finally { await handle.close(); }
  } };
}
