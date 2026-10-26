import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig, type McpConfig } from './config.js';
import { createMovieHarborClient, type MovieHarborClient } from './services/movie-harbor-client.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerGenreTools } from './tools/genres.js';
import { registerLocalMediaTools, type LocalMediaDependencies } from './tools/local-media.js';
import { registerMovieTools } from './tools/movies.js';
import { registerPublishingTools } from './tools/publishing.js';
import { registerSeriesTools } from './tools/series.js';
import { registerUploadTools } from './tools/uploads.js';

export interface Services extends LocalMediaDependencies { client: MovieHarborClient }

export function createServices(config: McpConfig): Services {
  return { config, credentialDirectory:config.credentialDirectory, client:createMovieHarborClient(config) };
}

const instructions = [
  '这是 Movie Harbor 本机原子入库服务。海报必须由用户提供并验证；不得联网下载海报。',
  '用户未提供名称、年份、简介、题材或单集名称时，Codex 必须联网查询可靠来源；冲突时让用户选择，不得虚构。',
  '创建和上传前必须展示完整入库计划、联网字段来源、文件路径、电影整数分钟、访问范围、转换与替换动作。',
  '访问范围未指定时默认公开；公开草稿在发布前仍不可访问。',
  '只有用户明确确认完整入库计划后，才可向入库写工具传 confirmed=true。计划、文件、版本或转换结果变化会使确认失效。',
  '转换确认、入库确认、发布确认相互独立。上传完成后禁止自动发布。',
  '目标已有视频时必须明确展示替换；电视剧先发布单集，父剧集需要再次单独确认发布。',
].join('\n');

export function buildServer(services: Services): McpServer {
  const server=new McpServer({name:'movie-harbor',version:'0.1.0'},{instructions});
  registerLocalMediaTools(server,services);
  registerCatalogTools(server,services.client);
  registerGenreTools(server,services.client);
  registerMovieTools(server,{client:services.client,allowedRoots:services.config.allowedRoots});
  registerSeriesTools(server,services.client);
  registerUploadTools(server,services);
  registerPublishingTools(server,services.client);
  return server;
}

export async function startStdio(env:NodeJS.ProcessEnv=process.env){
  const config=await loadConfig(env);
  const configPath=env.MOVIE_HARBOR_MCP_CONFIG;
  if(!configPath) throw new Error('缺少 MCP 配置');
  return serveStdio(()=>buildServer(createServices(config)),{
    onerror:()=>console.error('Movie Harbor MCP 协议连接失败'),
  });
}

const executed=process.argv[1]!==undefined&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(executed){
  void startStdio().catch(()=>{ console.error('Movie Harbor MCP 启动失败：请检查本机配置和文件权限'); process.exitCode=1; });
}
