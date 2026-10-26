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
  '这是 Movie Harbor 本机原子入库服务。创建电影或剧集前必须由用户提供并验证海报；没有海报不得创建。',
  '新内容固定创建为私密草稿，不改变公开范围。',
  '转换确认、入库或替换确认、发布确认是三个相互独立的确认，不能互相推断。',
  '目标已有视频时只能使用 replace 工具并明确说明替换。上传或替换完成后禁止自动发布。',
  '电视剧应先单独发布单集；仅在用户再次确认后才单独发布仍为草稿的父剧集。',
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
