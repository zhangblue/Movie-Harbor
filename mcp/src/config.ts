import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

export interface McpConfig {
  baseUrl: URL;
  apiKey: string;
  allowedRoots: string[];
  generatedRoot: string;
  requestTimeoutMs: number;
}

function absolutePath(value: string | undefined, field: string): string {
  if (!value || !isAbsolute(value)) throw new Error(`${field} 必须是绝对路径`);
  return value;
}

async function readEnv(path: string, privateFile: boolean): Promise<Map<string, string>> {
  // O_NOFOLLOW rejects symlinks; O_NONBLOCK lets stat reject FIFOs without waiting for a writer.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw new Error('配置必须是可读取的普通文件，不能使用符号链接');
  });
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('配置必须是普通文件');
    if (privateFile && (info.mode & 0o7777) !== 0o600) {
      throw new Error('凭据文件权限必须精确为 0600');
    }
    const entries = new Map<string, string>();
    for (const line of (await file.readFile('utf8')).split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 1) throw new Error('配置格式必须为 KEY=VALUE');
      const key = line.slice(0, separator).trim();
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error('配置字段名称无效');
      entries.set(key, line.slice(separator + 1));
    }
    return entries;
  } finally {
    await file.close();
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error('配置的目录必须是目录');
  return canonical;
}

export async function loadConfig(env: NodeJS.ProcessEnv): Promise<McpConfig> {
  const configPath = absolutePath(env.MOVIE_HARBOR_MCP_CONFIG, 'MOVIE_HARBOR_MCP_CONFIG');
  try {
    const config = await readEnv(configPath, false);
    let baseUrl: URL;
    try {
      baseUrl = new URL(config.get('MOVIE_HARBOR_BASE_URL') ?? '');
      if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password
        || baseUrl.href.includes('?') || baseUrl.href.includes('#') || baseUrl.pathname !== '/') throw new Error();
      baseUrl = new URL(`${baseUrl.origin}/`);
    } catch {
      throw new Error('MOVIE_HARBOR_BASE_URL 必须是无凭据、路径、查询和片段的 HTTP(S) 地址');
    }
    const credentialPath = absolutePath(config.get('MOVIE_HARBOR_MCP_CREDENTIALS'), 'MOVIE_HARBOR_MCP_CREDENTIALS');
    const credentials = await readEnv(credentialPath, true);
    const apiKey = credentials.get('MOVIE_HARBOR_MCP_API_KEY');
    if (!apiKey?.startsWith('mhmcp_') || apiKey.length <= 6) {
      throw new Error('MOVIE_HARBOR_MCP_API_KEY 必须以 mhmcp_ 开头且后缀非空');
    }
    let roots: unknown;
    try {
      roots = JSON.parse(config.get('MOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON') ?? '');
    } catch {
      throw new Error('MOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON 必须是绝对路径字符串数组');
    }
    if (!Array.isArray(roots) || !roots.every(root => typeof root === 'string' && isAbsolute(root))) {
      throw new Error('MOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON 必须是绝对路径字符串数组');
    }
    const allowedRoots = await Promise.all(roots.map(root => canonicalDirectory(root as string)));
    const generatedPath = absolutePath(
      config.get('MOVIE_HARBOR_MCP_GENERATED_ROOT') ?? join(dirname(configPath), 'generated'),
      'MOVIE_HARBOR_MCP_GENERATED_ROOT',
    );
    let generatedRoot: string;
    try {
      generatedRoot = await canonicalDirectory(generatedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      generatedRoot = join(await canonicalDirectory(dirname(generatedPath)), basename(generatedPath));
    }
    const timeout = config.get('MOVIE_HARBOR_MCP_REQUEST_TIMEOUT_MS') ?? '1800000';
    const requestTimeoutMs = Number(timeout);
    if (!/^\d+$/.test(timeout) || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error('MOVIE_HARBOR_MCP_REQUEST_TIMEOUT_MS 必须是正安全整数');
    }
    return { baseUrl, apiKey, allowedRoots, generatedRoot, requestTimeoutMs };
  } catch (error) {
    // Native filesystem errors contain paths; do not expose configuration values.
    if ((error as NodeJS.ErrnoException).code) throw new Error('配置目录不存在或不可读取');
    throw error;
  }
}
