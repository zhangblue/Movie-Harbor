import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { finished } from 'node:stream/promises';

// 按媒体元数据构造 multipart 边界、请求头和固定前后缀，供流式上传使用。
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
// 向请求写入一块数据并处理背压、关闭和错误，供上传各段顺序写入。
export function writeChunk(request, chunk) {
  // 写入分块时等待完成或关闭，供调用方顺序控制上传与背压。
  return new Promise((resolve, reject) => {
    if (request.destroyed || request.writableEnded) return reject(new Error('request closed'));
    // 写入结束或失败时移除事件监听，避免残留监听器。
    function cleanup() { request.off('close', closed); request.off('error', failed); }
    // 请求关闭时终止当前写入或文件读取，防止上传流继续运行。
    function closed() { cleanup(); reject(new Error('request closed')); }
    // 请求写入出错时清理监听器并拒绝等待。
    function failed(error) { cleanup(); reject(error); }
    request.once('close', closed);
    request.once('error', failed);
    try {
      // 写入回调区分成功和失败，保留必要监听器接收随后发出的错误。
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

// 创建带长度的流式 multipart 正文，供客户端上传本地媒体而不整文件载入内存。
export function createMultipartFileBody({ localPath, fileName, mimeType, byteSize, field }) {
  const { headers, prefix, suffix } = multipartParts({ fileName, mimeType, byteSize, field });
  // 上传时依次写入边界和文件流，完成或失败后清理监听器与资源。
  return { headers, async writeTo(request, { createStream = createReadStream, onStream, onProgress, signal } = {}) {
    let file;
    const completion = finished(request, { cleanup: true, readable: false });
    // Observe early close/error even while waiting on the file source.
    // 提前观察请求完成错误，防止等待文件期间出现未处理拒绝；最终仍等待 completion。
    completion.catch(() => {});
    // 取消上传时同时销毁文件和请求流，避免继续读写。
    function stop() { file?.destroy(); request.destroy(); }
    // 请求关闭时终止当前写入或文件读取，防止上传流继续运行。
    function closed() { file?.destroy(); }
    request.once('close', closed);
    signal?.addEventListener('abort', stop, { once: true });
    try {
      if (signal?.aborted) throw new Error('upload aborted');
      // 先写 multipart 头再打开源文件，确保流式正文顺序正确。
      await writeChunk(request, prefix);
      file = createStream(localPath);
      onStream?.(file);
      if (signal?.aborted || request.destroyed) { file.destroy(); throw new Error('upload aborted'); }
      let sent = 0;
      for await (const chunk of file) {
        sent += chunk.length;
        if (sent > byteSize) throw new Error('file size changed');
        await writeChunk(request, chunk);
        // 每块成功写入后通知进度，供调用方刷新上传空闲超时。
        onProgress?.(sent, byteSize);
      }
      if (sent !== byteSize) throw new Error('file size changed');
      // 确认文件大小未变化后写结束边界，才允许完成请求。
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
