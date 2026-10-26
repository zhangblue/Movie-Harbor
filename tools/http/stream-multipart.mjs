import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { finished } from 'node:stream/promises';

export function multipartParts({ fileName, mimeType, byteSize, field = 'file' }) {
  const unsafe = /[\r\n"\\\0]/;
  if (typeof fileName !== 'string' || !fileName || unsafe.test(fileName) || fileName.includes('/')
    || typeof field !== 'string' || !field || unsafe.test(field)
    || typeof mimeType !== 'string' || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mimeType)
    || !Number.isSafeInteger(byteSize) || byteSize < 0) throw new Error('invalid multipart metadata');
  const boundary = `movie-harbor-${randomBytes(16).toString('hex')}`;
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const length = prefix.length + byteSize + suffix.length;
  if (!Number.isSafeInteger(length)) throw new Error('invalid multipart length');
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(length) }, prefix, suffix };
}

// One chunk at a time, including when write() reports room in the buffer.
export function writeChunk(request, chunk) {
  return new Promise((resolve, reject) => {
    if (request.destroyed || request.writableEnded) return reject(new Error('request closed'));
    function cleanup() { request.off('close', closed); request.off('error', failed); }
    function closed() { cleanup(); reject(new Error('request closed')); }
    function failed(error) { cleanup(); reject(error); }
    request.once('close', closed);
    request.once('error', failed);
    try {
      request.write(chunk, error => {
        if (error) {
          // Writable emits error after its callback; retain the listener until then.
          request.off('close', closed);
          reject(error);
        } else { cleanup(); resolve(); }
      });
    } catch (error) { failed(error); }
  });
}

export function createMultipartFileBody({ localPath, fileName, mimeType, byteSize, field }) {
  const { headers, prefix, suffix } = multipartParts({ fileName, mimeType, byteSize, field });
  return { headers, async writeTo(request, { createStream = createReadStream, onStream, onProgress, signal } = {}) {
    let file;
    const completion = finished(request, { cleanup: true, readable: false });
    // Observe early close/error even while waiting on the file source.
    completion.catch(() => {});
    function stop() { file?.destroy(); request.destroy(); }
    function closed() { file?.destroy(); }
    request.once('close', closed);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted) throw new Error('upload aborted');
      await writeChunk(request, prefix);
      file = createStream(localPath);
      onStream?.(file);
      if (signal?.aborted || request.destroyed) { file.destroy(); throw new Error('upload aborted'); }
      let sent = 0;
      for await (const chunk of file) {
        sent += chunk.length;
        if (sent > byteSize) throw new Error('file size changed');
        await writeChunk(request, chunk);
        onProgress?.(sent, byteSize);
      }
      if (sent !== byteSize) throw new Error('file size changed');
      await writeChunk(request, suffix);
      request.end();
      await completion;
    } catch (error) {
      stop();
      if (signal?.aborted) throw new Error('upload aborted');
      throw error;
    } finally {
      file?.destroy();
      request.off('close', closed);
      signal?.removeEventListener('abort', stop);
    }
  } };
}
