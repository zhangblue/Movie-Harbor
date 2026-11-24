import { MovieHarborClientError } from './error-mapper.js';
import { serializeIdentity } from './media-inspector.js';
import { inspectAllowedFile } from './path-policy.js';

// 预检结果描述可序列化的文件身份，供海报和视频写入前进行同一套复验。
type MediaFileIdentity = ReturnType<typeof serializeIdentity>;

// 媒体预检通过后重新检查允许目录和文件身份，发生变化时阻止后续上传。
export async function inspectUnchangedMediaFile(path: string, roots: string[], expected: MediaFileIdentity) {
  const file = await inspectAllowedFile(path, roots);
  const current = serializeIdentity(file);
  for (const field of ['dev', 'ino', 'size', 'mtime_ms'] as const) {
    if (current[field] !== expected[field]) throw new MovieHarborClientError('file_changed');
  }
  return file;
}
