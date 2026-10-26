import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export interface CheckedFile {
  requestedPath: string;
  realPath: string;
  identity: { dev: bigint; ino: bigint; size: number; mtimeMs: number };
}

export async function inspectAllowedFile(path: string, roots: string[]): Promise<CheckedFile> {
  const realPath = await realpath(path);
  const allowedRoots = await Promise.all(roots.map(root => realpath(root)));
  const allowed = allowedRoots.some(root => {
    const relativePath = relative(root, realPath);
    return !isAbsolute(relativePath) && relativePath.split(sep)[0] !== '..';
  });
  if (!allowed) throw new Error('文件不在允许目录内');
  const info = await stat(realPath, { bigint: true });
  if (!info.isFile()) throw new Error('路径必须指向普通文件');
  return {
    requestedPath: path,
    realPath,
    identity: { dev: info.dev, ino: info.ino, size: Number(info.size), mtimeMs: Number(info.mtimeNs) / 1_000_000 },
  };
}

export async function revalidateAllowedFile(file: CheckedFile, roots: string[]): Promise<void> {
  let current: CheckedFile;
  try {
    current = await inspectAllowedFile(file.requestedPath, roots);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code) throw new Error('文件已经变化或不可读取');
    throw error;
  }
  const previous = file.identity;
  const next = current.identity;
  if (current.realPath !== file.realPath || previous.dev !== next.dev || previous.ino !== next.ino
    || previous.size !== next.size || previous.mtimeMs !== next.mtimeMs) {
    throw new Error('文件已经变化，请重新检查');
  }
}
