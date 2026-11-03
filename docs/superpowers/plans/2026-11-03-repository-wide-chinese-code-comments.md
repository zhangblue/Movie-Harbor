# 全仓库中文代码注释实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为除 `demo/` 外的全仓库代码补充中文注释，使每个命名函数、方法、组件、Hook 和类型都说明职责与调用时机，并为关键调用点说明调用原因和结果用途。

**架构：** 变更按后端运行代码、媒体解析、后端测试与迁移、前端共享与公开站、管理后台、MCP、根工具与测试七个边界分批实施。代码文件只允许新增、翻译或修正注释；唯一非注释内容是 `AGENTS.md` 的长期约束。最终使用函数清单、类型清单、差异审计和现有完整测试共同验证覆盖率与零行为变化。

**技术栈：** Rust、Axum、SeaORM、React、TypeScript、JavaScript、Node.js、Vite、Vitest、Playwright、Docker Compose。

---

## 文件结构与覆盖边界

本计划覆盖以下已跟踪代码：

- `AGENTS.md`：新增长期中文注释规范。
- `backend/src/**/*.rs`：后端运行代码、实体、DTO、路由、服务和模块声明。
- `backend/migration/src/**/*.rs`：SeaORM 迁移入口、升级和回滚。
- `backend/tests/**/*.rs`：后端集成测试及测试辅助函数。
- `frontend/public-web/**/*.{ts,tsx}`、`frontend/admin-web/**/*.{ts,tsx}`、`frontend/packages/**/*.{ts,tsx}`：前端运行代码、组件、Hook、配置、类型和测试。
- `mcp/src/**/*.{ts,d.ts}`、`mcp/tests/**/*.ts`、`mcp/install.sh`：MCP 运行代码、类型、安装脚本和测试。
- `tools/**/*.{mjs,d.ts,d.mts,sh}`：导入、转换、打包和 HTTP 工具。
- `tests/**/*.{mjs,ts}`、`playwright.config.ts`：根契约测试、E2E 和 Playwright 配置。

明确排除：

- `demo/**`：用户明确要求不修改。
- `.superpowers/brainstorm/**`：历史设计伴侣生成物，不是生产代码或测试入口。
- `package-lock.json`、`mcp/package-lock.json`、`Cargo.lock`：格式不支持注释，且不包含函数或类型声明。
- 图片、视频、PID、状态文件和其他非代码制品。

生成的 TypeScript 声明文件属于覆盖范围；重新生成可能覆盖人工注释，必须在文件级中文注释中明确这一风险。

## 通用实施规则

每个任务都遵循以下规则，不得省略：

1. 每个命名函数、Rust 方法、React 组件和 Hook 的相邻位置添加中文注释，同时说明功能与调用时机。
2. 简单函数也要注释；不能仅因函数只有一行而跳过。
3. 类型、接口、结构体、枚举、DTO 和测试用例说明用途、数据边界或验证场景。
4. 关键调用点解释为什么此时调用，以及成功结果或失败如何影响后续流程。
5. 极短匿名回调可由外层关键调用注释覆盖；承担异步副作用、业务分支或错误恢复的匿名回调必须单独说明。
6. 保留必要的英文代码标识和协议名，但注释主体使用中文。
7. 不修改函数签名、表达式、导入、格式、断言、配置值或行为。
8. 每批完成后执行只注释差异审计，并由独立审查者对照完整函数清单检查遗漏。

全局 Rust 函数与类型清单命令：

```bash
rg -n '^\s*(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+[A-Za-z_][A-Za-z0-9_]*|^\s*(pub(\([^)]*\))?\s+)?(struct|enum|trait|type)\s+[A-Za-z_][A-Za-z0-9_]*' backend -g '*.rs'
```

全局 TypeScript/JavaScript 函数、组件、Hook 与类型候选清单命令：

```bash
rg -n '^\s*(export\s+)?(default\s+)?(async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*|^\s*(export\s+)?(const|let)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(async\s+)?(\([^;]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>|^\s*(export\s+)?(interface|type|class|enum)\s+[A-Za-z_$][A-Za-z0-9_$]*' frontend mcp tools tests playwright.config.ts -g '*.{ts,tsx,js,mjs,d.ts,mts}'
```

全局测试入口候选清单命令：

```bash
rg -n '^\s*(#\[tokio::test\]|#\[test\])|\b(test|it|describe)\s*\(' backend frontend mcp tests -g '*.{rs,ts,tsx,js,mjs}'
```

## 基线状态

- `cargo build --workspace`：通过。
- `cargo test --workspace --lib`：44 项通过，0 失败。
- `npm test --workspaces`：351 项通过，0 失败。
- `docker compose -f docker-compose.test.yml up -d postgres`：本机 Docker daemon 未运行，无法连接 `/Users/zhangdi/.orbstack/run/docker.sock`。最终任务必须重新尝试，数据库测试未通过前不得宣称完整交付。

### 任务 1：固化 AGENTS.md 注释规范并建立覆盖基线

**文件：**
- 修改：`AGENTS.md`
- 审核：`docs/superpowers/specs/2026-11-03-repository-wide-chinese-code-comments-design.md`

- [ ] **步骤 1：记录未注释函数和类型基线**

运行通用清单命令，将输出保存为 worktree 外的临时审计资料，不提交文件：

```bash
mkdir -p /tmp/movie-harbor-comment-audit
rg -n '^\s*(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+[A-Za-z_][A-Za-z0-9_]*|^\s*(pub(\([^)]*\))?\s+)?(struct|enum|trait|type)\s+[A-Za-z_][A-Za-z0-9_]*' backend -g '*.rs' > /tmp/movie-harbor-comment-audit/rust-symbols.txt
rg -n '^\s*(export\s+)?(default\s+)?(async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*|^\s*(export\s+)?(const|let)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(async\s+)?(\([^;]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>|^\s*(export\s+)?(interface|type|class|enum)\s+[A-Za-z_$][A-Za-z0-9_$]*' frontend mcp tools tests playwright.config.ts -g '*.{ts,tsx,js,mjs,d.ts,mts}' > /tmp/movie-harbor-comment-audit/web-symbols.txt
```

预期：两个清单均非空，成为后续逐条覆盖依据。

- [ ] **步骤 2：在开发工作流中加入强制约束**

在 `AGENTS.md` 的“开发工作流”中加入一组中文条目，明确：

```markdown
- 新增或修改代码时必须同步维护中文注释；每个命名函数、方法、React 组件和 Hook 都要说明功能与调用时机，简单函数也不得省略。
- 关键函数调用点必须说明为什么在当前阶段调用，以及调用结果或失败如何影响后续流程；禁止只复述函数名。
- 类型、接口、结构体、枚举、DTO、测试、迁移、生成代码和纯类型声明同样需要中文说明；行为变化时必须同步更新相关注释。
```

- [ ] **步骤 3：验证文档约束**

运行：

```bash
node --test tests/documentation.test.mjs
git diff --check
```

预期：文档测试通过，差异无空白错误。

- [ ] **步骤 4：提交**

```bash
git add AGENTS.md
git commit -m "docs: require Chinese code comments"
```

### 任务 2：后端基础、认证、目录与管理运行代码

**文件：**
- 修改：`backend/src/app.rs`、`backend/src/main.rs`、`backend/src/lib.rs`、`backend/src/config.rs`、`backend/src/error.rs`、`backend/src/content.rs`、`backend/src/route_params.rs`
- 修改：`backend/src/auth/**/*.rs`、`backend/src/viewer_auth/**/*.rs`、`backend/src/admin_users/**/*.rs`
- 修改：`backend/src/admin_content/**/*.rs`、`backend/src/admin_export/**/*.rs`、`backend/src/catalog/**/*.rs`、`backend/src/genres/**/*.rs`
- 修改：`backend/src/entities/**/*.rs`

- [ ] **步骤 1：逐文件建立函数、类型和关键调用清单**

运行：

```bash
rg -n '^\s*(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+|^\s*(pub(\([^)]*\))?\s+)?(struct|enum|trait|type)\s+' backend/src/{auth,viewer_auth,admin_users,admin_content,admin_export,catalog,genres,entities} backend/src/{app.rs,main.rs,lib.rs,config.rs,error.rs,content.rs,route_params.rs}
```

预期：清单覆盖模块入口、路由、服务、DTO、实体和辅助函数。

- [ ] **步骤 2：为每个函数和类型补充中文说明**

注释必须说明功能与调用时机。例如：

```rust
// 构建共享应用状态；服务启动完成配置校验和恢复后，由 main 在绑定监听端口前调用。
pub fn build(...) -> Router { ... }
```

简单映射函数也必须说明使用位置；纯模块声明文件说明该模块由哪个路由或服务聚合。

- [ ] **步骤 3：注释关键调用点**

重点覆盖：启动顺序、管理员和普通用户认证、密码验证、会话撤销、授权、事务快照、目录可见性、管理导出、题材关联和配置解析。注释应位于调用前，例如：

```rust
// 在返回登录成功前重新锁定用户行，确认阻塞线程中的密码校验期间密码版本未发生变化。
let user = repository::find_locked(...).await?;
```

- [ ] **步骤 4：验证仅注释差异与 Rust 编译**

```bash
git diff --unified=0 HEAD^ -- backend/src | awk '/^\+\+\+|^---/ {next} /^[+-]/ && $0 !~ /^[+-][[:space:]]*\/\// {print; bad=1} END {exit bad}'
cargo fmt --all -- --check
cargo check --workspace
git diff --check
```

预期：除注释外无源码变化，格式、编译和差异检查通过。

- [ ] **步骤 5：提交**

```bash
git add backend/src
git commit -m "docs: explain backend functions and calls"
```

### 任务 3：电影、剧集与媒体运行代码

**文件：**
- 修改：`backend/src/movies/**/*.rs`、`backend/src/series/**/*.rs`
- 修改：`backend/src/media/mod.rs`、`backend/src/media/path.rs`、`backend/src/media/routes.rs`、`backend/src/media/removal.rs`、`backend/src/media/upload.rs`、`backend/src/media/authorization.rs`、`backend/src/media/staged_poster.rs`

- [ ] **步骤 1：列出所有函数、方法和类型**

```bash
rg -n '^\s*(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+|^\s*(pub(\([^)]*\))?\s+)?(struct|enum|trait|type)\s+' backend/src/{movies,series,media} -g '*.rs' -g '!storage.rs' -g '!validation.rs'
```

- [ ] **步骤 2：补齐职责与调用时机注释**

覆盖路由、DTO、仓储、服务、媒体授权、海报暂存、上传替换和删除恢复；简单构造器、解析器和映射函数也必须注释。

- [ ] **步骤 3：补齐关键调用点注释**

重点解释事务加锁顺序、乐观锁、生命周期状态机、媒体独占、授权结果、文件暂存、数据库提交前后恢复责任和启动恢复入口。

- [ ] **步骤 4：验证并提交**

```bash
cargo fmt --all -- --check
cargo check --workspace
git diff --check
git add backend/src/movies backend/src/series backend/src/media
git commit -m "docs: explain content and media call flows"
```

### 任务 4：媒体存储与格式解析器

**文件：**
- 修改：`backend/src/media/storage.rs`
- 修改：`backend/src/media/validation.rs`

- [ ] **步骤 1：完整读取两个文件并导出符号清单**

```bash
rg -n '^\s*(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+|^\s*(pub(\([^)]*\))?\s+)?(struct|enum|trait|type)\s+' backend/src/media/{storage.rs,validation.rs}
```

逐个核对关联的 `impl` 方法，不仅检查顶层函数。

- [ ] **步骤 2：补齐所有简单和复杂函数注释**

存储文件覆盖初始化、流式写入、提升、目录同步、隔离、清单恢复、文件身份和语法校验。解析文件覆盖元数据、PNG、JPEG、WebP、MP4、H.264、HEVC 和 WebM/EBML 的每个命名解析函数。

- [ ] **步骤 3：补齐关键调用说明**

只在真实安全边界前说明 `sync_all`、`renameat`、`openat`、`O_NOFOLLOW`、哈希、边界/计数上限、panic 捕获和解码器复核的调用原因，不能扩大实现保证。

- [ ] **步骤 4：验证并提交**

```bash
git diff --unified=0 HEAD^ -- backend/src/media/{storage.rs,validation.rs}
cargo fmt --all -- --check
cargo check --workspace
git diff --check
git add backend/src/media/storage.rs backend/src/media/validation.rs
git commit -m "docs: document media storage and parsers"
```

### 任务 5：后端迁移与测试代码

**文件：**
- 修改：`backend/migration/src/**/*.rs`
- 修改：`backend/tests/**/*.rs`

- [ ] **步骤 1：列出迁移、测试和辅助函数**

```bash
rg -n '^\s*(pub(\([^)]*\))?\s+)?(async\s+)?fn\s+|^\s*(#\[tokio::test\]|#\[test\])|^\s*(pub(\([^)]*\))?\s+)?(struct|enum|trait|type)\s+' backend/migration/src backend/tests -g '*.rs'
```

- [ ] **步骤 2：注释迁移与测试**

每个 `up`、`down` 和迁移辅助函数说明由迁移器在升级或回滚何时调用及影响。每个测试函数说明验证目标和触发场景；每个测试辅助函数、fixture 和类型说明使用阶段。

- [ ] **步骤 3：注释关键测试调用点**

重点说明并发屏障、故障注入、事务提交/回滚、文件身份替换、真实数据库 schema 隔离以及断言前的状态准备调用。

- [ ] **步骤 4：验证并提交**

```bash
cargo fmt --all -- --check
cargo test --workspace --lib
git diff --check
git add backend/migration/src backend/tests
git commit -m "docs: explain migrations and backend tests"
```

### 任务 6：前端共享包与公开站

**文件：**
- 修改：`frontend/packages/api-client/**/*.{ts,tsx}`
- 修改：`frontend/packages/ui/**/*.{ts,tsx}`
- 修改：`frontend/public-web/**/*.{ts,tsx}`

- [ ] **步骤 1：列出函数、组件、Hook 和类型**

```bash
rg -n '^\s*(export\s+)?(default\s+)?(async\s+)?function\s+|^\s*(export\s+)?(const|let)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(async\s+)?(\([^;]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>|^\s*(export\s+)?(interface|type|class|enum)\s+' frontend/packages frontend/public-web -g '*.{ts,tsx}'
```

- [ ] **步骤 2：注释所有函数、组件、Hook 与类型**

简单格式化、排序、分页、状态读取和事件处理函数也要说明职责与调用时机。组件说明由哪一级页面或布局渲染；Hook 说明在什么生命周期或请求阶段调用。

- [ ] **步骤 3：注释关键调用点**

重点说明 API 请求、认证恢复、播放进度持久化、媒体播放、分页跳转、错误状态转换和共享 UI 回调。

- [ ] **步骤 4：验证并提交**

```bash
npm test --workspace @movie-harbor/api-client
npm test --workspace @movie-harbor/ui
npm test --workspace @movie-harbor/public-web
npm run build --workspace @movie-harbor/api-client
npm run build --workspace @movie-harbor/ui
npm run build --workspace @movie-harbor/public-web
git diff --check
git add frontend/packages frontend/public-web
git commit -m "docs: explain shared and public frontend code"
```

### 任务 7：管理后台

**文件：**
- 修改：`frontend/admin-web/**/*.{ts,tsx}`

- [ ] **步骤 1：列出全部函数、组件、Hook 和类型**

```bash
rg -n '^\s*(export\s+)?(default\s+)?(async\s+)?function\s+|^\s*(export\s+)?(const|let)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(async\s+)?(\([^;]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>|^\s*(export\s+)?(interface|type|class|enum)\s+' frontend/admin-web -g '*.{ts,tsx}'
```

- [ ] **步骤 2：逐函数添加中文注释**

覆盖入口、认证、内容列表、电影编辑、剧集/季/单集编辑、题材管理、用户管理、上传组件、测试 server 和 XHR 辅助。每个测试用例回调由紧邻注释说明验证场景。

- [ ] **步骤 3：注释关键调用点**

重点说明认证过期恢复、草稿/发布/归档转换、上传进度、媒体替换、版本冲突、导出、删除确认和层级保存顺序。

- [ ] **步骤 4：验证并提交**

```bash
npm test --workspace @movie-harbor/admin-web
npm run build --workspace @movie-harbor/admin-web
git diff --check
git add frontend/admin-web
git commit -m "docs: explain admin frontend code"
```

### 任务 8：MCP 运行代码、生成声明与测试

**文件：**
- 修改：`mcp/src/**/*.ts`
- 修改：`mcp/src/**/*.d.ts`
- 修改：`mcp/tests/**/*.ts`
- 修改：`mcp/install.sh`

- [ ] **步骤 1：列出 MCP 函数、类型、工具和测试**

```bash
rg -n '^\s*(export\s+)?(default\s+)?(async\s+)?function\s+|^\s*(export\s+)?(const|let)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(async\s+)?(\([^;]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>|^\s*(export\s+)?(interface|type|class|enum)\s+|\b(test|it|describe)\s*\(' mcp -g '*.{ts,d.ts}'
```

- [ ] **步骤 2：注释运行代码与声明**

覆盖服务器启动、配置、schema、Movie Harbor 客户端、路径策略、流式上传、媒体检查、视频转换、生成文件和全部工具注册/执行函数。`video-conversion.d.ts` 增加文件级说明，指出重新生成可能覆盖注释。

- [ ] **步骤 3：注释测试和关键调用点**

每个测试与辅助函数说明场景；关键调用说明认证摘要、路径限制、上传流、转换子进程、API 错误映射和工具结果组装。

- [ ] **步骤 4：验证并提交**

```bash
npm test --prefix mcp
npm run build --prefix mcp
sh -n mcp/install.sh
git diff --check
git add mcp
git commit -m "docs: explain MCP functions and tests"
```

### 任务 9：根工具、声明、契约测试与 E2E

**文件：**
- 修改：`tools/**/*.{mjs,d.ts,d.mts,sh}`
- 修改：`tests/**/*.{mjs,ts}`
- 修改：`playwright.config.ts`

- [ ] **步骤 1：列出函数、类型和测试入口**

```bash
rg -n '^\s*(export\s+)?(default\s+)?(async\s+)?function\s+|^\s*(export\s+)?(const|let)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(async\s+)?(\([^;]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>|^\s*(export\s+)?(interface|type|class|enum)\s+|\b(test|it|describe)\s*\(' tools tests playwright.config.ts -g '*.{ts,mjs,d.ts,d.mts}'
```

- [ ] **步骤 2：注释工具与声明**

覆盖内容导入、媒体路径、进度持久化、HTTP multipart、视频探测/计划/执行、离线打包和 CLI 入口。生成声明文件增加覆盖风险说明；Shell 函数说明由脚本哪个阶段调用。

- [ ] **步骤 3：注释契约与 E2E 测试**

每个测试、fixture、启动器和辅助函数说明验证或调用场景。关键调用说明子进程启动、Compose 隔离、浏览器登录、上传、导入、断言轮询和安全清理。

- [ ] **步骤 4：运行聚焦验证**

```bash
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
node --check tools/import-content.mjs
node --check tools/convert-video.mjs
node --check tools/offline-package.mjs
sh -n tools/build-offline-package.sh
git diff --check
```

- [ ] **步骤 5：提交**

```bash
git add tools tests playwright.config.ts
git commit -m "docs: explain tools and end-to-end tests"
```

### 任务 10：全仓库覆盖审计与完整验证

**文件：**
- 审核：除 `demo/**` 和明确非代码制品外的所有已跟踪代码
- 修正：前述任务遗漏的注释

- [ ] **步骤 1：确认排除目录没有差异**

```bash
git diff --exit-code main...HEAD -- demo
```

预期：无输出，退出码 0。

- [ ] **步骤 2：逐条回查函数、组件、Hook、类型和测试清单**

重新运行通用清单命令，将输出与 `/tmp/movie-harbor-comment-audit/` 基线逐条核对。每个命中项上方或同一声明处必须有中文职责和调用时机说明；对正则未覆盖的 `impl` 方法、对象方法、类方法和命名回调进行逐文件人工审计。

- [ ] **步骤 3：检查关键调用点覆盖**

按下列调用类别搜索并逐处审阅：

```bash
rg -n '\.(await|transaction|commit|rollback|execute|spawn|rename|sync_all|fetch|request|upload|publish|delete|remove)\b|Command::new|Router::new|createBrowserRouter|useEffect\(' backend frontend mcp tools tests -g '*.{rs,ts,tsx,mjs}'
```

预期：会改变状态、跨边界或承担恢复责任的调用均有中文原因和结果说明；普通 getter、纯计算和测试断言调用无需机械逐处重复。

- [ ] **步骤 4：验证只有注释和 AGENTS.md 规则发生变化**

对每个已改代码文件去除整行注释后，与 `main` 基线比较；多行块注释和 JSDoc 由审查者逐文件确认。运行：

```bash
git diff --stat main...HEAD
git diff --word-diff=plain main...HEAD -- . ':(exclude)AGENTS.md' ':(exclude)docs/superpowers/specs/**' ':(exclude)docs/superpowers/plans/**'
git diff --check
```

预期：代码差异只增加、翻译或修正注释，不含运行代码变化。

- [ ] **步骤 5：运行 Rust 完整验证**

```bash
docker compose -f docker-compose.test.yml up -d postgres
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
```

预期：Docker 可用，全部命令退出码 0。若 Docker daemon 仍未运行，停止交付并报告阻塞，不得用 `--no-run` 或单元测试代替数据库集成测试。

- [ ] **步骤 6：运行 Node、前端与 MCP 完整验证**

```bash
npm test --workspaces
npm run build --workspaces
npm test --prefix mcp
npm run build --prefix mcp
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
```

预期：全部退出码 0。

- [ ] **步骤 7：按跨服务风险运行 E2E**

虽然本次只改注释，覆盖了 E2E runner 和跨服务测试代码，因此运行：

```bash
npm run test:e2e
```

预期：Playwright 全部通过；runner 使用隔离 Compose 项目和数据目录。

- [ ] **步骤 8：最终审查与提交遗漏修正**

使用 superpowers:requesting-code-review 对照设计规格审查：

- `AGENTS.md` 约束完整；
- 每个简单或复杂命名函数都有职责与调用时机；
- 关键调用点说明原因和结果；
- 测试、迁移、生成声明和纯类型均覆盖；
- `demo/` 无变化；
- 注释准确、中文为主且没有行为差异；
- 完整验证证据来自最终 HEAD。

若审计产生修正：

```bash
git add AGENTS.md backend frontend mcp tools tests playwright.config.ts
git commit -m "docs: complete repository comment audit"
```

若没有修正，不创建空提交。
