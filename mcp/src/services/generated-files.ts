import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { McpConfig } from '../config.js';
import { fileIdentity, type FileIdentity } from '../schemas/media.js';
import { inspectAllowedFile, revalidateAllowedFile, type CheckedFile } from './path-policy.js';
import { serializeIdentity } from './media-inspector.js';

const recordSchema = z.object({ path: z.string(), identity: fileIdentity, source: z.object({ path: z.string(), identity: fileIdentity }) });
const registrySchema = z.object({ version: z.literal(1), files: z.array(recordSchema) });
type Registry = z.infer<typeof registrySchema>;
const queues = new Map<string, Promise<unknown>>();
async function serialized<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(directory) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(directory, next);
  try { return await next; }
  finally { if (queues.get(directory) === next) queues.delete(directory); }
}
function inside(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix.split(sep)[0] !== '..';
}
export async function prepareGeneratedRoot(config: McpConfig): Promise<string> {
  const parent = await realpath(dirname(config.generatedRoot));
  const expected = join(parent, basename(config.generatedRoot));
  const roots = await Promise.all(config.allowedRoots.map(root => realpath(root)));
  if (!roots.some(root => inside(expected, root))) throw new Error('生成目录不在允许目录内');
  try { await mkdir(expected, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(expected);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(expected) !== expected) throw new Error('生成目录已经变化或不是普通目录');
  return expected;
}
async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('凭据目录必须是普通目录');
  await chmod(directory, 0o700);
}
async function readRegistry(directory: string): Promise<Registry> {
  let handle;
  try { handle = await open(join(directory, 'generated-files.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, files: [] }; throw new Error('无法读取生成文件记录'); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o7777) !== 0o600) throw new Error();
    return registrySchema.parse(JSON.parse(await handle.readFile('utf8')));
  } catch { throw new Error('生成文件记录损坏或权限不安全'); }
  finally { await handle.close(); }
}
async function writeRegistry(directory: string, registry: Registry) {
  const temporary = join(directory, `.generated-files.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(registry));
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(temporary, join(directory, 'generated-files.json'));
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
export async function recordGeneratedFile(path: string, source: CheckedFile, config: McpConfig, directory: string) {
  return serialized(directory, async () => {
    await revalidateAllowedFile(source, config.allowedRoots);
    await prepareGeneratedRoot(config);
    await privateDirectory(directory);
    const output = await inspectAllowedFile(path, [config.generatedRoot]);
    // Never register a hard link to the original as a disposable conversion output.
    if (output.identity.dev === source.identity.dev && output.identity.ino === source.identity.ino) throw new Error('生成文件不能是原视频');
    await chmod(output.realPath, 0o600);
    await revalidateAllowedFile(output, [config.generatedRoot]);
    const registry = await readRegistry(directory);
    if (registry.files.some(record => record.path === output.realPath)) throw new Error('生成文件已经登记');
    registry.files.push({ path: output.realPath, identity: serializeIdentity(output), source: { path: source.realPath, identity: serializeIdentity(source) } });
    await writeRegistry(directory, registry);
    return output;
  });
}
function sameIdentity(a: FileIdentity, b: FileIdentity) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtime_ms === b.mtime_ms;
}
export async function deleteGeneratedFile(path: string, config: McpConfig, directory: string): Promise<void> {
  return serialized(directory, async () => {
    await privateDirectory(directory);
    const registry = await readRegistry(directory);
    // Match the actual registered path, never an arbitrary alias or user source.
    const record = registry.files.find(record => record.path === path);
    if (!record) throw new Error('不是 MCP 生成文件');
    await prepareGeneratedRoot(config);
    const file = await inspectAllowedFile(path, [config.generatedRoot]);
    if (file.realPath !== record.path || !sameIdentity(serializeIdentity(file), record.identity)) throw new Error('生成文件身份已经变化，拒绝删除');
    await revalidateAllowedFile(file, [config.generatedRoot]);
    await unlink(file.realPath);
    registry.files = registry.files.filter(candidate => candidate !== record);
    await writeRegistry(directory, registry);
  });
}
