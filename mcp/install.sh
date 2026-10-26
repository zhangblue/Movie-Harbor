#!/bin/sh
set -eu

umask 077

fail() {
  printf '%s\n' "安装失败：$*" >&2
  exit 1
}

script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || fail "无法定位安装脚本"
repo_root=$(CDPATH= cd -P "$script_dir/.." && pwd) || fail "无法定位 Movie Harbor 仓库"

for required_file in \
  "$repo_root/.env.example" \
  "$repo_root/docker-compose.yml" \
  "$script_dir/package.json" \
  "$script_dir/package-lock.json" \
  "$script_dir/src/server.ts"
do
  [ -f "$required_file" ] && [ ! -L "$required_file" ] || fail "当前目录不是完整且安全的 Movie Harbor 仓库"
done

for command_name in node npm codex ffmpeg ffprobe
do
  command -v "$command_name" >/dev/null 2>&1 || fail "缺少必需命令：$command_name"
done

printf '%s\n' '正在安装锁定依赖并构建 Movie Harbor MCP…'
npm ci --prefix "$script_dir" || fail "npm ci 失败，未修改 Codex 注册"
npm run build --prefix "$script_dir" || fail "MCP 构建失败，未修改 Codex 注册"
entry="$script_dir/dist/server.js"
[ -f "$entry" ] && [ ! -L "$entry" ] || fail "构建未生成安全的 dist/server.js"

config_base=${MOVIE_HARBOR_MCP_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/movie-harbor-mcp}
case "$config_base" in
  /*) ;;
  *) fail "MCP 配置目录必须是绝对路径" ;;
esac
mkdir -p "$config_base" || fail "无法创建 MCP 配置目录"
[ -d "$config_base" ] && [ ! -L "$config_base" ] || fail "MCP 配置目录不能是符号链接"
chmod 700 "$config_base" || fail "无法保护 MCP 配置目录"
config_dir=$(CDPATH= cd -P "$config_base" && pwd) || fail "无法读取 MCP 配置目录"
config_file="$config_dir/config.env"
credentials_file="$config_dir/credentials.env"
generated_root=${MOVIE_HARBOR_MCP_GENERATED_ROOT:-$config_dir/generated}
base_url=${MOVIE_HARBOR_MCP_BASE_URL:-http://127.0.0.1:8080/}
allowed_roots=${MOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON:-'["/Users/zhangdi/Downloads"]'}
request_timeout=${MOVIE_HARBOR_MCP_REQUEST_TIMEOUT_MS:-1800000}

digest=$(node -e '
const fs=require("node:fs"),crypto=require("node:crypto");
const path=process.argv[1]; let key;
try {
  const info=fs.lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o7777)!==0o600) throw new Error("unsafe");
  const text=fs.readFileSync(path,"utf8");
  const match=/^MOVIE_HARBOR_MCP_API_KEY=([^\r\n]+)\r?\n?$/.exec(text);
  if(!match||!/^mhmcp_[A-Za-z0-9_-]{32,256}$/.test(match[1])) throw new Error("invalid");
  key=match[1];
} catch(error) {
  if(error&&error.code!=="ENOENT") { console.error("凭据文件不安全或格式无效"); process.exit(1); }
  key="mhmcp_"+crypto.randomBytes(32).toString("hex");
  let fd;
  try { fd=fs.openSync(path,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600); fs.writeFileSync(fd,`MOVIE_HARBOR_MCP_API_KEY=${key}\n`); fs.fsyncSync(fd); }
  finally { if(fd!==undefined) fs.closeSync(fd); }
}
process.stdout.write(crypto.createHash("sha256").update(key).digest("hex"));
' "$credentials_file") || fail "无法安全创建或读取 MCP 独立凭据"

node -e '
const fs=require("node:fs"),pathModule=require("node:path");
const [path,credentials,base,rootsText,generated,timeout]=process.argv.slice(1);
for(const value of [path,credentials,base,rootsText,generated,timeout]) if(/[\0\r\n]/.test(value)) throw new Error("配置包含非法换行或 NUL");
let url; try { url=new URL(base); } catch { throw new Error("Movie Harbor 地址无效"); }
if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.pathname!=="/"||url.search||url.hash) throw new Error("Movie Harbor 地址必须是无凭据、路径、查询和片段的 HTTP(S) 根地址");
const roots=JSON.parse(rootsText);
if(!Array.isArray(roots)||roots.length===0||!roots.every(root=>typeof root==="string"&&pathModule.isAbsolute(root)&&!/[\0\r\n]/.test(root))) throw new Error("允许目录必须是非空绝对路径 JSON 数组");
for(const root of roots) if(!fs.statSync(root).isDirectory()) throw new Error("允许目录不存在或不是目录");
if(!pathModule.isAbsolute(generated)||!/^\d+$/.test(timeout)||!Number.isSafeInteger(Number(timeout))||Number(timeout)<=0) throw new Error("生成目录或超时配置无效");
const content=[`MOVIE_HARBOR_BASE_URL=${url.origin}/`,`MOVIE_HARBOR_MCP_CREDENTIALS=${credentials}`,`MOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON=${JSON.stringify(roots)}`,`MOVIE_HARBOR_MCP_GENERATED_ROOT=${generated}`,`MOVIE_HARBOR_MCP_REQUEST_TIMEOUT_MS=${timeout}`,""].join("\n");
let exists=false;
try { const info=fs.lstatSync(path); exists=true; if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o7777)!==0o600) throw new Error("配置文件不安全"); }
catch(error) { if(error&&error.code!=="ENOENT") throw error; }
let fd;
try { fd=fs.openSync(path,(exists?fs.constants.O_TRUNC:fs.constants.O_CREAT|fs.constants.O_EXCL)|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600); fs.writeFileSync(fd,content); fs.fsyncSync(fd); }
finally { if(fd!==undefined) fs.closeSync(fd); }
' "$config_file" "$credentials_file" "$base_url" "$allowed_roots" "$generated_root" "$request_timeout" || fail "无法安全写入 MCP 配置"

existing_count=$(node -e '
const {spawnSync}=require("node:child_process");
const result=spawnSync("codex",["mcp","list","--json"],{encoding:"utf8",maxBuffer:16*1024*1024});
try{if(result.error||result.status!==0)throw new Error();const value=JSON.parse(result.stdout);if(!Array.isArray(value))throw new Error();const matches=value.filter(item=>item&&item.name==="movie-harbor");if(matches.length>1)throw new Error();process.stdout.write(String(matches.length));}catch{console.error("无法安全读取或解析 Codex MCP 列表");process.exit(1);}
') || fail "无法安全读取 Codex MCP 列表"

case "$existing_count" in
  0) ;;
  1)
    node -e '
const {spawnSync}=require("node:child_process");const [entry,config]=process.argv.slice(1);
const result=spawnSync("codex",["mcp","get","movie-harbor","--json"],{encoding:"utf8",maxBuffer:1024*1024});
try{if(result.error||result.status!==0)throw new Error();const item=JSON.parse(result.stdout),transport=item&&item.transport,env=transport&&transport.env;if(item.name!=="movie-harbor"||!transport||transport.type!=="stdio"||transport.command!=="node"||!Array.isArray(transport.args)||transport.args.length!==1||transport.args[0]!==entry||!env||env.MOVIE_HARBOR_MCP_CONFIG!==config)throw new Error();}catch{console.error("同名 movie-harbor MCP 不属于当前仓库，拒绝覆盖");process.exit(1);}
' "$entry" "$config_file" || fail "已有同名 MCP 无法安全更新"
    codex mcp remove movie-harbor || fail "无法移除当前仓库的旧 MCP 注册"
    ;;
  *) fail "Codex MCP 列表包含异常的同名条目" ;;
esac

codex mcp add movie-harbor --env "MOVIE_HARBOR_MCP_CONFIG=$config_file" -- node "$entry" || fail "Codex MCP 注册失败"
node -e '
const {spawnSync}=require("node:child_process");const [entry,config]=process.argv.slice(1);
const result=spawnSync("codex",["mcp","get","movie-harbor","--json"],{encoding:"utf8",maxBuffer:1024*1024});
try{if(result.error||result.status!==0)throw new Error();const item=JSON.parse(result.stdout),transport=item&&item.transport,env=transport&&transport.env;if(item.name!=="movie-harbor"||!transport||transport.type!=="stdio"||transport.command!=="node"||!Array.isArray(transport.args)||transport.args.length!==1||transport.args[0]!==entry||!env||env.MOVIE_HARBOR_MCP_CONFIG!==config)throw new Error();}catch{console.error("Codex MCP 注册验证失败");process.exit(1);}
' "$entry" "$config_file" || fail "Codex MCP 注册后验证失败"

printf '%s\n' 'Movie Harbor MCP 已全局注册到 Codex。'
printf '%s\n' "请在 Movie Harbor 服务端设置 MCP_API_KEY_SHA256=$digest"
printf '%s\n' '然后由你自行重启 Movie Harbor，并在 Codex 桌面版 MCP 设置中重启 movie-harbor 服务。'
