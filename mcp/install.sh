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
base_url=${MOVIE_HARBOR_MCP_BASE_URL:-http://127.0.0.1:8080/}
allowed_roots=${MOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON:-'["/Users/zhangdi/Downloads"]'}
request_timeout=${MOVIE_HARBOR_MCP_REQUEST_TIMEOUT_MS:-1800000}

existing_count=$(node -e '
const {spawnSync}=require("node:child_process");
const result=spawnSync("codex",["mcp","list","--json"],{encoding:"utf8",maxBuffer:16*1024*1024});
try{if(result.error||result.status!==0)throw new Error();const value=JSON.parse(result.stdout);if(!Array.isArray(value))throw new Error();const matches=value.filter(item=>item&&item.name==="movie-harbor");if(matches.length>1)throw new Error();process.stdout.write(String(matches.length));}catch{console.error("无法安全读取或解析 Codex MCP 列表");process.exit(1);}
') || fail "无法安全读取 Codex MCP 列表"

verified_config_file=
rollback_snapshot=
case "$existing_count" in
  0) ;;
  1)
    if [ -e "$config_base" ] || [ -L "$config_base" ]; then
      [ -d "$config_base" ] && [ ! -L "$config_base" ] || fail "已有同名 MCP 的配置目录不安全"
      verified_config_dir=$(CDPATH= cd -P "$config_base" && pwd) || fail "无法读取已有 MCP 配置目录"
      verified_config_file="$verified_config_dir/config.env"
    else
      verified_config_file="$config_base/config.env"
    fi
    rollback_snapshot=$(node -e '
const {spawnSync}=require("node:child_process");const [entry,config]=process.argv.slice(1);
const result=spawnSync("codex",["mcp","get","movie-harbor","--json"],{encoding:"utf8",maxBuffer:1024*1024});
try{
  if(result.error||result.status!==0)throw new Error();
  const item=JSON.parse(result.stdout),transport=item&&item.transport,env=transport&&transport.env;
  const exactKeys=(value,allowed)=>value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
  const clean=value=>typeof value==="string"&&!/[\0\r\n]/.test(value);
  const validEnv=value=>value&&typeof value==="object"&&!Array.isArray(value)&&Object.entries(value).every(([key,item])=>key.length>0&&!/[=\0\r\n]/.test(key)&&typeof item==="string"&&!/\0/.test(item));
  if(!exactKeys(item,["name","enabled","disabled_reason","transport","startup_timeout_sec","tool_timeout_sec","enabled_tools","disabled_tools","auth_status"])||
     item.name!=="movie-harbor"||item.enabled!==true||
     (item.disabled_reason!==undefined&&item.disabled_reason!==null)||
     (item.startup_timeout_sec!==undefined&&item.startup_timeout_sec!==null)||
     (item.tool_timeout_sec!==undefined&&item.tool_timeout_sec!==null)||
     (item.enabled_tools!==undefined&&item.enabled_tools!==null)||
     (item.disabled_tools!==undefined&&item.disabled_tools!==null)||
     !exactKeys(transport,["type","command","args","env","env_vars","cwd"])||
     transport.type!=="stdio"||transport.command!=="node"||!clean(transport.command)||
     !Array.isArray(transport.args)||transport.args.length!==1||transport.args[0]!==entry||!clean(transport.args[0])||
     !validEnv(env)||env.MOVIE_HARBOR_MCP_CONFIG!==config||!clean(env.MOVIE_HARBOR_MCP_CONFIG)||
     (transport.env_vars!==undefined&&(!Array.isArray(transport.env_vars)||transport.env_vars.length!==0))||
     (transport.cwd!==undefined&&transport.cwd!==null))throw new Error();
  process.stdout.write(Buffer.from(JSON.stringify({command:transport.command,args:transport.args,env}),"utf8").toString("base64"));
}catch{console.error("同名 movie-harbor MCP 不属于当前仓库，或包含无法无损恢复的配置，拒绝覆盖");process.exit(1);}
' "$entry" "$verified_config_file") || fail "已有同名 MCP 无法安全更新"
    # Keep only the already-validated, CLI-reconstructible fields in memory.
    # The registration JSON itself may contain sensitive data and is never logged or written to disk.
    ;;
  *) fail "Codex MCP 列表包含异常的同名条目" ;;
esac

# Only after Codex ownership is proven may this installer touch private configuration.
mkdir -p "$config_base" || fail "无法创建 MCP 配置目录"
[ -d "$config_base" ] && [ ! -L "$config_base" ] || fail "MCP 配置目录不能是符号链接"
chmod 700 "$config_base" || fail "无法保护 MCP 配置目录"
config_dir=$(CDPATH= cd -P "$config_base" && pwd) || fail "无法读取 MCP 配置目录"
config_file="$config_dir/config.env"
credentials_file="$config_dir/credentials.env"
if [ "$existing_count" = 1 ] && [ "$config_file" != "$verified_config_file" ]; then
  fail "MCP 配置目录在归属验证后发生变化"
fi

generated_input=${MOVIE_HARBOR_MCP_GENERATED_ROOT:-$config_dir/generated}
generated_root=$(node -e '
const fs=require("node:fs"),path=require("node:path");const input=process.argv[1];
try{
  if(!path.isAbsolute(input)||/[\0\r\n]/.test(input))throw new Error();
  try{const info=fs.lstatSync(input);if(!info.isDirectory()||info.isSymbolicLink())throw new Error();process.stdout.write(fs.realpathSync(input));}
  catch(error){if(!error||error.code!=="ENOENT")throw error;const parent=path.dirname(input),name=path.basename(input),info=fs.lstatSync(parent);if(!name||name==="."||name===".."||!info.isDirectory()||info.isSymbolicLink())throw new Error();process.stdout.write(path.join(fs.realpathSync(parent),name));}
}catch{console.error("生成目录必须使用真实且已存在的普通父目录");process.exit(1);}
' "$generated_input") || fail "生成目录配置不安全"

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
const fs=require("node:fs"),pathModule=require("node:path"),crypto=require("node:crypto");
const [path,credentials,base,rootsText,generated,timeout]=process.argv.slice(1),temporary=pathModule.join(pathModule.dirname(path),`.${pathModule.basename(path)}.${crypto.randomUUID()}.tmp`);
for(const value of [path,credentials,base,rootsText,generated,timeout]) if(/[\0\r\n]/.test(value)) throw new Error("配置包含非法换行或 NUL");
let url; try { url=new URL(base); } catch { throw new Error("Movie Harbor 地址无效"); }
if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.pathname!=="/"||url.search||url.hash) throw new Error("Movie Harbor 地址必须是无凭据、路径、查询和片段的 HTTP(S) 根地址");
const roots=JSON.parse(rootsText);
if(!Array.isArray(roots)||roots.length===0||!roots.every(root=>typeof root==="string"&&pathModule.isAbsolute(root)&&!/[\0\r\n]/.test(root))) throw new Error("允许目录必须是非空绝对路径 JSON 数组");
for(const root of roots) if(!fs.statSync(root).isDirectory()) throw new Error("允许目录不存在或不是目录");
if(!pathModule.isAbsolute(generated)||!/^\d+$/.test(timeout)||!Number.isSafeInteger(Number(timeout))||Number(timeout)<=0) throw new Error("生成目录或超时配置无效");
const content=[`MOVIE_HARBOR_BASE_URL=${url.origin}/`,`MOVIE_HARBOR_MCP_CREDENTIALS=${credentials}`,`MOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON=${JSON.stringify(roots)}`,`MOVIE_HARBOR_MCP_GENERATED_ROOT=${generated}`,`MOVIE_HARBOR_MCP_REQUEST_TIMEOUT_MS=${timeout}`,""].join("\n");
try { const info=fs.lstatSync(path); if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o7777)!==0o600) throw new Error("配置文件不安全"); }
catch(error) { if(error&&error.code!=="ENOENT") throw error; }
let fd,created=false;
try {
  fd=fs.openSync(temporary,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);created=true;
  fs.writeFileSync(fd,content);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  fs.renameSync(temporary,path);created=false;
  const directory=fs.openSync(pathModule.dirname(path),fs.constants.O_RDONLY);try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
} finally {
  if(fd!==undefined)fs.closeSync(fd);
  if(created)try{fs.unlinkSync(temporary);}catch(error){if(!error||error.code!=="ENOENT")throw error;}
}
' "$config_file" "$credentials_file" "$base_url" "$allowed_roots" "$generated_root" "$request_timeout" || fail "无法安全写入 MCP 配置"

verify_registration() {
  node -e '
const {spawnSync}=require("node:child_process");const [entry,config]=process.argv.slice(1);
const result=spawnSync("codex",["mcp","get","movie-harbor","--json"],{encoding:"utf8",maxBuffer:1024*1024});
try{if(result.error||result.status!==0)throw new Error();const item=JSON.parse(result.stdout),transport=item&&item.transport,env=transport&&transport.env;if(item.name!=="movie-harbor"||item.enabled!==true||!transport||transport.type!=="stdio"||transport.command!=="node"||!Array.isArray(transport.args)||transport.args.length!==1||transport.args[0]!==entry||!env||Object.keys(env).length!==1||env.MOVIE_HARBOR_MCP_CONFIG!==config)throw new Error();}catch{console.error("Codex MCP 注册验证失败");process.exit(1);}
' "$entry" "$config_file"
}

new_snapshot=$(node -e 'const [entry,config]=process.argv.slice(1);process.stdout.write(Buffer.from(JSON.stringify({command:"node",args:[entry],env:{MOVIE_HARBOR_MCP_CONFIG:config}}),"utf8").toString("base64"));' "$entry" "$config_file") || fail "无法准备 MCP 注册事务"

cleanup_registration() {
  expected_snapshot=$1
  printf '%s' "$expected_snapshot" | node -e '
const fs=require("node:fs"),{spawnSync}=require("node:child_process"),expected=JSON.parse(Buffer.from(fs.readFileSync(0,"utf8"),"base64").toString("utf8")),options={encoding:"utf8",maxBuffer:1024*1024};
const run=args=>spawnSync("codex",args,options);
const exactKeys=(value,allowed)=>value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
const sameMap=(left,right)=>exactKeys(left,Object.keys(right))&&Object.keys(left).length===Object.keys(right).length&&Object.entries(right).every(([key,value])=>left[key]===value);
const isOwned=item=>{const transport=item&&item.transport;return exactKeys(item,["name","enabled","disabled_reason","transport","startup_timeout_sec","tool_timeout_sec","enabled_tools","disabled_tools","auth_status"])&&item.name==="movie-harbor"&&item.enabled===true&&(item.disabled_reason===undefined||item.disabled_reason===null)&&(item.startup_timeout_sec===undefined||item.startup_timeout_sec===null)&&(item.tool_timeout_sec===undefined||item.tool_timeout_sec===null)&&(item.enabled_tools===undefined||item.enabled_tools===null)&&(item.disabled_tools===undefined||item.disabled_tools===null)&&exactKeys(transport,["type","command","args","env","env_vars","cwd"])&&transport.type==="stdio"&&transport.command===expected.command&&JSON.stringify(transport.args)===JSON.stringify(expected.args)&&sameMap(transport.env,expected.env)&&(transport.env_vars===undefined||(Array.isArray(transport.env_vars)&&transport.env_vars.length===0))&&(transport.cwd===undefined||transport.cwd===null);};
try{
  const current=run(["mcp","get","movie-harbor","--json"]);
  if(!current.error&&current.status===0){
    if(!isOwned(JSON.parse(current.stdout)))throw new Error();
    const removed=run(["mcp","remove","movie-harbor"]);if(removed.error||removed.status!==0)throw new Error();
  }
  const listed=run(["mcp","list","--json"]);if(listed.error||listed.status!==0)throw new Error();
  const items=JSON.parse(listed.stdout);if(!Array.isArray(items)||items.some(item=>item&&item.name==="movie-harbor"))throw new Error();
}catch{process.exit(1);}
'
}

restore_registration() {
  printf '%s' "$rollback_snapshot" | node -e '
const fs=require("node:fs"),{spawnSync}=require("node:child_process"),snapshot=JSON.parse(Buffer.from(fs.readFileSync(0,"utf8"),"base64").toString("utf8"));
const args=["mcp","add","movie-harbor"];
for(const [key,value] of Object.entries(snapshot.env))args.push("--env",`${key}=${value}`);
args.push("--",snapshot.command,...snapshot.args);
const result=spawnSync("codex",args,{encoding:"utf8",maxBuffer:1024*1024});if(result.error||result.status!==0)process.exit(1);
'
}

verify_restored_registration() {
  printf '%s' "$rollback_snapshot" | node -e '
const fs=require("node:fs"),{spawnSync}=require("node:child_process"),snapshot=JSON.parse(Buffer.from(fs.readFileSync(0,"utf8"),"base64").toString("utf8"));
const result=spawnSync("codex",["mcp","get","movie-harbor","--json"],{encoding:"utf8",maxBuffer:1024*1024});
try{
  if(result.error||result.status!==0)throw new Error();const item=JSON.parse(result.stdout),transport=item&&item.transport;
  const exactKeys=(value,allowed)=>value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
  const sameMap=(left,right)=>exactKeys(left,Object.keys(right))&&Object.keys(left).length===Object.keys(right).length&&Object.entries(right).every(([key,value])=>left[key]===value);
  if(!exactKeys(item,["name","enabled","disabled_reason","transport","startup_timeout_sec","tool_timeout_sec","enabled_tools","disabled_tools","auth_status"])||item.name!=="movie-harbor"||item.enabled!==true||(item.disabled_reason!==undefined&&item.disabled_reason!==null)||(item.startup_timeout_sec!==undefined&&item.startup_timeout_sec!==null)||(item.tool_timeout_sec!==undefined&&item.tool_timeout_sec!==null)||(item.enabled_tools!==undefined&&item.enabled_tools!==null)||(item.disabled_tools!==undefined&&item.disabled_tools!==null)||!exactKeys(transport,["type","command","args","env","env_vars","cwd"])||transport.type!=="stdio"||transport.command!==snapshot.command||JSON.stringify(transport.args)!==JSON.stringify(snapshot.args)||!sameMap(transport.env,snapshot.env)||(transport.env_vars!==undefined&&(!Array.isArray(transport.env_vars)||transport.env_vars.length!==0))||(transport.cwd!==undefined&&transport.cwd!==null))throw new Error();
}catch{process.exit(1);}
'
}

rollback_after_failure() {
  original_error=$1
  cleanup_registration "$new_snapshot" || fail "严重错误：$original_error，且无法清理新的或残留的 MCP 注册"
  if [ "$existing_count" = 0 ]; then
    fail "$original_error；已清理未完成的 MCP 注册"
  fi
  if ! restore_registration; then
    cleanup_registration "$rollback_snapshot" >/dev/null 2>&1 || true
    fail "严重错误：$original_error，且回滚失败，旧 MCP 注册未能恢复"
  fi
  if ! verify_restored_registration; then
    cleanup_registration "$rollback_snapshot" >/dev/null 2>&1 || true
    fail "严重错误：$original_error，且回滚后的旧 MCP 注册验证失败"
  fi
  fail "$original_error；已回滚并恢复旧 MCP 注册"
}

if [ "$existing_count" = 1 ]; then
  codex mcp remove movie-harbor || fail "无法移除当前仓库的旧 MCP 注册"
fi

if ! codex mcp add movie-harbor --env "MOVIE_HARBOR_MCP_CONFIG=$config_file" -- node "$entry"; then
  rollback_after_failure "Codex MCP 注册失败"
fi
if ! verify_registration; then
  rollback_after_failure "Codex MCP 注册后验证失败"
fi

printf '%s\n' 'Movie Harbor MCP 已全局注册到 Codex。'
printf '%s\n' "请在 Movie Harbor 服务端设置 MCP_API_KEY_SHA256=$digest"
printf '%s\n' '然后由你自行重启 Movie Harbor，并在 Codex 桌面版 MCP 设置中重启 movie-harbor 服务。'
