# 自托管电影与剧集媒体库实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 构建一个由两套 React 前端、Axum API、SeaORM/PostgreSQL 和本地媒体卷组成的可自托管电影与剧集媒体库。

**架构：** 使用纵向功能切片推进：每个任务同时交付必要的数据库、后端 API、前端或部署变更，并在独立测试循环后提交。公开站与管理后台是两个独立 Vite 应用，通过同源 `/api` 通信；Axum 使用共享 `AppState`，SeaORM 管理 PostgreSQL 数据，Tokio 负责异步文件 I/O。

**技术栈：** React 19、Vite 8、TypeScript 6；Rust 2024、Axum 0.8、Tokio 1、SeaORM 1.1、PostgreSQL；Node 内置测试/Vitest、Rust `cargo test`、Playwright 端到端测试、Docker Compose。

---

## 文件结构

### 根目录

- `Cargo.toml`：Rust workspace，包含 API 与迁移 crate。
- `package.json`：npm workspace 和跨前端脚本。
- `docker-compose.yml`：PostgreSQL、API、公开站、管理后台和 Caddy 编排。
- `.env.example`：数据库、管理员初始化、媒体目录和会话配置示例。
- `Caddyfile`：同源 `/`、`/admin`、`/api`、`/media` 路由。
- `tests/e2e/`：跨服务端到端测试。

### 后端

- `backend/Cargo.toml`：Axum 服务依赖。
- `backend/src/main.rs`：进程入口、迁移、监听和优雅关闭。
- `backend/src/app.rs`：`Router` 和 `AppState` 组装。
- `backend/src/config.rs`：环境配置解析与校验。
- `backend/src/error.rs`：统一 API 错误映射。
- `backend/src/auth/`：管理员初始化、密码、会话、CSRF 和登录限流。
- `backend/src/genres/`：题材命令、查询和路由。
- `backend/src/media/`：流式上传、存储键、原子替换和清理任务。
- `backend/src/movies/`：电影模型、生命周期和 API。
- `backend/src/series/`：剧集、季、单集模型、生命周期和 API。
- `backend/src/catalog/`：公开目录、搜索和详情 API。
- `backend/src/entities/`：SeaORM entities 与关系。
- `backend/tests/`：路由、数据库、生命周期和存储集成测试。
- `backend/migration/`：SeaORM migration crate 与顺序迁移。

### 前端共享包

- `frontend/packages/api-client/`：公开/管理 API 类型、请求封装和错误类型。
- `frontend/packages/ui/`：经 Demo 验证的主题 token、按钮、输入框、海报卡片、对话框和通知组件。

### 公开站

- `frontend/public-web/src/app/`：路由与应用壳。
- `frontend/public-web/src/catalog/`：首页筛选、搜索和海报网格。
- `frontend/public-web/src/details/`：电影与剧集详情。
- `frontend/public-web/src/player/`：播放器、选集与本地进度。

### 管理后台

- `frontend/admin-web/src/auth/`：登录和管理员菜单。
- `frontend/admin-web/src/content/`：内容列表、查询和状态操作。
- `frontend/admin-web/src/movies/`：电影草稿编辑器。
- `frontend/admin-web/src/series/`：剧集、季和单集编辑器。
- `frontend/admin-web/src/genres/`：题材配置。
- `frontend/admin-web/src/settings/`：系统只读信息和密码修改。

## 实施约定

- 每个行为先写失败测试并确认失败原因，再写最少实现。
- 后端单元测试使用 SeaORM `MockDatabase`；涉及约束、事务和迁移的测试使用真实 PostgreSQL。
- API 路由测试使用 `Router::oneshot`，不启动随机端口。
- 前端逻辑使用 Vitest 与 Testing Library；关键跨应用流程使用 Playwright。
- 每个任务完成全部测试后单独提交；不要把相邻任务揉成一个提交。

### 任务 1：初始化工作区并交付健康检查

**文件：**
- 创建：`Cargo.toml`
- 创建：`backend/Cargo.toml`
- 创建：`backend/src/main.rs`
- 创建：`backend/src/app.rs`
- 创建：`backend/src/config.rs`
- 创建：`backend/src/error.rs`
- 创建：`backend/tests/health_test.rs`
- 创建：`package.json`
- 创建：`frontend/public-web/package.json`
- 创建：`frontend/admin-web/package.json`
- 创建：`frontend/packages/api-client/package.json`
- 创建：`frontend/packages/ui/package.json`
- 创建：各 Vite 应用的 `index.html`、`vite.config.ts`、`tsconfig.json`、`src/main.tsx`

- [x] **步骤 1：初始化 Git 并保护本地文件**

运行：`git init`

创建 `.gitignore`，至少包含 `node_modules/`、`target/`、`.env`、前端构建目录和本地媒体目录；保留 `demo/`、规格与计划文档。

- [x] **步骤 2：编写失败的健康检查路由测试**

```rust
#[tokio::test]
async fn health_returns_ok() {
    let response = movie_harbor_api::app::test_router()
        .oneshot(Request::builder().uri("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}
```

运行：`cargo test -p movie-harbor-api --test health_test`

预期：FAIL，`movie_harbor_api::app::test_router` 尚不存在。

- [x] **步骤 3：创建最小 Axum 应用与严格配置解析**

实现 `GET /api/health` 返回 `{"status":"ok"}`；`Config::from_env` 明确读取监听地址、数据库 URL、媒体目录、Cookie 安全开关和上传限制，不给生产密码提供默认值。

- [x] **步骤 4：创建两套独立 Vite React TypeScript 应用**

公开站与管理后台分别拥有入口、构建脚本和严格 TypeScript 配置；共享包只导出空的稳定入口，不复制 Demo 的原生 DOM 代码。

- [x] **步骤 5：验证工作区**

运行：`cargo test --workspace`

运行：`npm install`

运行：`npm run build --workspaces`

预期：Rust 测试通过，两套前端均能完成 TypeScript 检查与 Vite 构建。

- [x] **步骤 6：提交**

```bash
git add -A
git commit -m "chore: initialize media library workspace"
```

### 任务 2：建立数据库迁移与实体关系

**文件：**
- 创建：`backend/migration/Cargo.toml`
- 创建：`backend/migration/src/lib.rs`
- 创建：`backend/migration/src/m20260911_000001_core_schema.rs`
- 创建：`backend/src/entities/{admin_user,admin_session,genre,media_asset,movie,series,season,episode,movie_genre,series_genre,file_cleanup_job}.rs`
- 创建：`backend/src/entities/mod.rs`
- 创建：`backend/tests/migration_test.rs`
- 创建：`docker-compose.test.yml`

- [x] **步骤 1：编写失败的真实数据库迁移测试**

测试迁移后存在 11 张业务表，并验证：电影名称不能为空、季序号在剧集内唯一、集序号在季内唯一、题材名称唯一、状态只接受 `draft/published/archived`。

运行：`docker compose -f docker-compose.test.yml up -d postgres`

运行：`TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test cargo test -p movie-harbor-api --test migration_test`

预期：FAIL，迁移 crate 或业务表尚不存在。

- [x] **步骤 2：实现核心迁移**

使用 UUID 主键；电影、剧集和单集包含 `status`、`version`、`published_at`、`archived_at`、时间戳；季只含 `series_id` 和 `number`；关联表使用复合唯一键；媒体资源保存 `storage_key`、`original_name`、`mime_type`、`byte_size` 和用途。

- [x] **步骤 3：实现 SeaORM entity 与关系**

明确电影/题材和剧集/题材多对多关系、剧集/季/集级联关系、媒体资源外键和清理任务关系；不使用无约束的字符串多态外键。

- [x] **步骤 4：验证迁移可逆性与实体编译**

运行迁移 `up → down → up`，再运行：`cargo test --workspace`

预期：迁移测试通过，entity 关系编译通过。

- [x] **步骤 5：提交**

```bash
git add backend/migration backend/src/entities backend/tests/migration_test.rs docker-compose.test.yml
git commit -m "feat: add media catalog database schema"
```

### 任务 3：管理员初始化、登录、会话和密码修改

**文件：**
- 创建：`backend/src/auth/{mod,model,password,session,csrf,rate_limit,routes}.rs`
- 创建：`backend/tests/auth_test.rs`
- 修改：`backend/src/app.rs`
- 修改：`backend/src/main.rs`
- 修改：`backend/src/entities/admin_user.rs`
- 修改：`backend/src/entities/admin_session.rs`

- [x] **步骤 1：编写失败的认证集成测试**

覆盖：空库按环境配置创建唯一管理员；重启不覆盖已有密码；正确密码登录并设置 `HttpOnly`/`SameSite=Lax` Cookie；错误密码不泄露账号是否存在；修改密码撤销全部会话；第 6 次连续失败返回 `429`，15 分钟窗口后恢复。

运行：`cargo test -p movie-harbor-api --test auth_test`

预期：FAIL，认证路由尚未注册。

- [x] **步骤 2：实现初始化和密码服务**

使用 Argon2id 与每个密码独立盐值；启动时只在管理员表为空时消费 `ADMIN_NAME` 和 `ADMIN_INITIAL_PASSWORD`，否则忽略两项初始化值。

- [x] **步骤 3：实现不透明会话和 CSRF**

Cookie 只保存随机会话令牌；数据库保存 SHA-256 令牌摘要、CSRF 令牌摘要和过期时间。`GET /api/admin/session` 返回管理员显示名称与本会话 CSRF token；所有管理写请求必须带 `X-CSRF-Token`。

- [x] **步骤 4：实现路由和限流**

实现登录、退出、读取会话、修改密码；限流键使用规范化客户端地址与账号名称摘要，不记录明文密码或 Cookie。

- [x] **步骤 5：验证并提交**

运行：`cargo test -p movie-harbor-api --test auth_test`

运行：`cargo test --workspace`

```bash
git add backend/src/auth backend/src/app.rs backend/src/main.rs backend/tests/auth_test.rs
git commit -m "feat: add single administrator authentication"
```

### 任务 4：题材预置和管理

**文件：**
- 创建：`backend/migration/src/m20260911_000002_seed_genres.rs`
- 创建：`backend/src/genres/{mod,service,routes,dto}.rs`
- 创建：`backend/tests/genres_test.rs`
- 修改：`backend/migration/src/lib.rs`
- 修改：`backend/src/app.rs`

- [x] **步骤 1：编写失败测试**

覆盖默认题材写入、按排序返回、新增、改名、排序、停用；被引用题材删除返回 `409`；停用题材保留在既有内容上但不能新关联。

运行：`cargo test -p movie-harbor-api --test genres_test`

预期：FAIL，题材管理 API 不存在。

- [x] **步骤 2：实现迁移和事务服务**

默认写入剧情、喜剧、动作、科幻、恐怖、悬疑、犯罪、冒险、奇幻、家庭、纪录片、动画；重排操作一次提交全部新位置并拒绝重复序号。

- [x] **步骤 3：实现管理 API**

提供列表、创建、更新、停用和删除端点；写路由统一经过管理员会话与 CSRF 中间件。

- [x] **步骤 4：验证并提交**

运行：`cargo test --workspace`

```bash
git add backend/migration backend/src/genres backend/tests/genres_test.rs backend/src/app.rs
git commit -m "feat: add configurable genre presets"
```

### 任务 5：本地媒体存储与安全上传

**文件：**
- 创建：`backend/src/media/{mod,storage,upload,validation,cleanup,routes}.rs`
- 创建：`backend/tests/media_upload_test.rs`
- 创建：`backend/tests/media_cleanup_test.rs`
- 修改：`backend/src/app.rs`
- 修改：`backend/src/config.rs`

- [x] **步骤 1：编写失败的存储集成测试**

使用临时媒体根目录覆盖：分块写入不把整个文件载入内存；路径键由系统生成；拒绝路径穿越、伪造 MIME、超限文件和不支持格式；替换失败保留旧文件；成功替换后旧文件进入清理任务。

运行：`cargo test -p movie-harbor-api --test media_upload_test --test media_cleanup_test`

预期：FAIL，`LocalMediaStorage` 尚不存在。

- [x] **步骤 2：实现 Tokio 流式临时写入**

逐块读取 Axum multipart field，写入媒体根目录内的 `.incoming`；同步计算字节数与摘要；调用 `sync_all` 后再原子重命名到按资源 ID 分层的正式路径。

- [x] **步骤 3：实现验证和替换事务**

海报允许 JPEG、PNG、WebP；视频允许配置的浏览器兼容 MIME。先落新文件，再在数据库事务中切换引用；提交成功后创建旧文件清理任务。任何失败都删除本次临时文件。

- [x] **步骤 4：实现清理执行器**

Tokio 定时任务只处理数据库中明确登记的清理键；使用规范化路径再次验证目标位于媒体根目录内；成功后删除任务，失败则增加尝试次数并保存错误摘要。

- [x] **步骤 5：验证并提交**

运行：`cargo test --workspace`

```bash
git add backend/src/media backend/tests/media_upload_test.rs backend/tests/media_cleanup_test.rs backend/src/app.rs backend/src/config.rs
git commit -m "feat: add safe local media storage"
```

### 任务 6：电影草稿与生命周期

**文件：**
- 创建：`backend/src/movies/{mod,dto,repository,service,routes}.rs`
- 创建：`backend/tests/movies_test.rs`
- 修改：`backend/src/app.rs`

- [x] **步骤 1：编写失败的电影生命周期测试**

覆盖新建草稿、只在草稿编辑、发布最低要求、发布后只读、归档、原样再发布、归档转草稿、草稿/归档删除、已发布删除拒绝、`version` 冲突拒绝和重复状态请求幂等。

运行：`cargo test -p movie-harbor-api --test movies_test`

预期：FAIL，电影服务与路由不存在。

- [x] **步骤 2：实现 repository 与事务服务**

所有写入通过 `WHERE id = ? AND version = ?` 乐观锁；状态转换集中在一个显式状态机中；发布校验确认名称、海报和视频记录存在且正式文件可访问。

- [x] **步骤 3：实现管理 API**

提供电影列表、创建、详情、草稿更新、海报/视频关联、发布、归档、转草稿和永久删除；错误统一映射到 `400/401/403/404/409/422`。

- [x] **步骤 4：验证并提交**

运行：`cargo test --workspace`

```bash
git add backend/src/movies backend/tests/movies_test.rs backend/src/app.rs
git commit -m "feat: add movie lifecycle management"
```

### 任务 7：剧集、季、单集与组合生命周期

**文件：**
- 创建：`backend/src/series/{mod,dto,repository,service,routes}.rs`
- 创建：`backend/tests/series_test.rs`
- 修改：`backend/src/app.rs`

- [x] **步骤 1：编写失败的层级与状态测试**

覆盖：季只含序号；季序号与集序号作用域唯一；单集名称必填；剧集至少一个已发布单集才能发布；已发布剧集可新增季和草稿单集但自身只读；有已发布单集的季不可改号或删除；归档剧集隐藏子级但不改变单集状态。

运行：`cargo test -p movie-harbor-api --test series_test`

预期：FAIL，剧集服务不存在。

- [x] **步骤 2：实现层级命令与事务**

将创建季、改季序号、删除季、创建单集、更新单集和单集状态变更分别建模；父级删除在事务中级联记录并将独占媒体加入清理任务。

- [x] **步骤 3：实现管理 API**

提供剧集与单集的草稿、查询和状态端点；季只提供创建、改号和删除；请求返回当前 `version` 供前端提交乐观锁。

- [x] **步骤 4：验证并提交**

运行：`cargo test --workspace`

```bash
git add backend/src/series backend/tests/series_test.rs backend/src/app.rs
git commit -m "feat: add episodic content lifecycle"
```

### 任务 8：公开目录、搜索与详情 API

**文件：**
- 创建：`backend/src/catalog/{mod,dto,query,routes}.rs`
- 创建：`backend/tests/catalog_test.rs`
- 修改：`backend/src/app.rs`

- [ ] **步骤 1：编写失败的公开 API 测试**

覆盖“全部/电影/剧集”、名称或简介模糊搜索、发布时间倒序、分页、卡片前三个题材与总数、电影详情、剧集按季返回已发布单集；草稿、归档和已发布剧集下的未发布单集均表现为 `404` 或不出现在结果中。

运行：`cargo test -p movie-harbor-api --test catalog_test`

预期：FAIL，公开目录路由不存在。

- [ ] **步骤 2：实现只读查询**

对电影和剧集构造统一卡片 DTO；查询只选择公开字段，不返回存储键、后台状态或内部版本；媒体 URL 只使用 `/media/<受控键>`。

- [ ] **步骤 3：实现索引与查询计划检查**

为状态、发布时间、规范化名称和外键增加索引；使用测试数据执行 `EXPLAIN`，确认首页和搜索不进行无界关联扫描。

- [ ] **步骤 4：验证并提交**

运行：`cargo test --workspace`

```bash
git add backend/src/catalog backend/tests/catalog_test.rs backend/src/app.rs backend/migration
git commit -m "feat: add public catalog API"
```

### 任务 9：共享前端 API 客户端与视觉组件

**文件：**
- 创建：`frontend/packages/api-client/src/{index,http,public,admin,types}.ts`
- 创建：`frontend/packages/api-client/src/http.test.ts`
- 创建：`frontend/packages/ui/src/{index,theme.css,Button,Field,PosterCard,Dialog,Toast}.tsx`
- 创建：`frontend/packages/ui/src/Button.test.tsx`
- 创建：`frontend/packages/ui/src/Field.test.tsx`
- 创建：`frontend/packages/ui/src/PosterCard.test.tsx`
- 创建：`frontend/packages/ui/src/Dialog.test.tsx`
- 创建：`frontend/packages/ui/src/Toast.test.tsx`
- 修改：两个共享包的 `package.json` 和 `tsconfig.json`

- [ ] **步骤 1：编写失败测试**

测试 API 客户端同源 `/api`、JSON 错误解析、管理员写请求自动附带 CSRF header；测试按钮键盘焦点、风险样式、海报卡片最多三个题材并显示 `+N`。

运行：`npm test --workspace @movie-harbor/api-client --workspace @movie-harbor/ui`

预期：FAIL，共享实现尚不存在。

- [ ] **步骤 2：实现客户端与组件**

把 Demo 的深色 token 转为共享 CSS 变量；组件只负责展示和无障碍语义，不内置页面业务状态。

- [ ] **步骤 3：验证并提交**

运行：`npm test --workspaces`

运行：`npm run build --workspaces`

```bash
git add frontend/packages
git commit -m "feat: add shared frontend client and design system"
```

### 任务 10：实现公开站首页与详情

**文件：**
- 创建：`frontend/public-web/src/app/App.tsx`
- 创建：`frontend/public-web/src/catalog/{CatalogPage,CatalogToolbar,CatalogGrid}.tsx`
- 创建：`frontend/public-web/src/details/{MovieDetails,SeriesDetails}.tsx`
- 创建：`frontend/public-web/src/catalog/CatalogPage.test.tsx`
- 创建：`frontend/public-web/src/details/Details.test.tsx`
- 创建：`frontend/public-web/src/styles.css`
- 修改：`frontend/public-web/src/main.tsx`

- [ ] **步骤 1：编写失败的首页行为测试**

渲染已知 API fixture，验证默认混合列表、电影/剧集切换、短搜索框、无结果状态、五列网格类名、名称/形态/年份/题材和点击进入详情。

运行：`npm test --workspace @movie-harbor/public-web`

预期：FAIL，页面组件不存在。

- [ ] **步骤 2：实现首页和响应式样式**

逐项迁移已审核 Demo：桌面五列、深色背景、左侧品牌、右侧内容切换与短搜索框、无题材/年份/排序筛选；移动端逐级降为四、三、两列。

- [ ] **步骤 3：实现详情页面**

电影详情显示播放入口；剧集详情按季序号分组，只显示公开单集及管理员输入的集名称；不可见内容统一展示公开 404 页面。

- [ ] **步骤 4：验证并提交**

运行：`npm test --workspace @movie-harbor/public-web`

运行：`npm run build --workspace @movie-harbor/public-web`

```bash
git add frontend/public-web
git commit -m "feat: build public catalog and details"
```

### 任务 11：实现管理后台认证、壳与内容列表

**文件：**
- 创建：`frontend/admin-web/src/app/App.tsx`
- 创建：`frontend/admin-web/src/auth/{LoginPage,AccountMenu,ChangePasswordDialog}.tsx`
- 创建：`frontend/admin-web/src/content/{ContentPage,ContentFilters,ContentTable,ActionButtons}.tsx`
- 创建：相应 `*.test.tsx`
- 创建：`frontend/admin-web/src/styles.css`
- 修改：`frontend/admin-web/src/main.tsx`

- [ ] **步骤 1：编写失败测试**

覆盖未登录跳转、登录失败提示、右上角管理员名称下拉菜单、修改密码后返回登录、内容形态/状态下拉查询、紧凑名称框、海报列、状态对应按钮和操作列右对齐。

运行：`npm test --workspace @movie-harbor/admin-web`

预期：FAIL，后台壳和内容列表不存在。

- [ ] **步骤 2：实现认证壳和同源会话**

启动时读取 `/api/admin/session`；401 展示登录页；写请求使用会话返回的 CSRF token；账号菜单点击外部或按 Escape 关闭。

- [ ] **步骤 3：实现内容列表**

迁移审核通过的表格视觉，操作按钮右对齐并保持约 24–40px 右侧留白；不同状态只渲染服务端允许的动作；冲突响应提示刷新。

- [ ] **步骤 4：验证并提交**

运行：`npm test --workspace @movie-harbor/admin-web`

运行：`npm run build --workspace @movie-harbor/admin-web`

```bash
git add frontend/admin-web
git commit -m "feat: build admin authentication and content list"
```

### 任务 12：实现电影草稿编辑与媒体替换

**文件：**
- 创建：`frontend/admin-web/src/movies/{MovieEditor,PosterPicker,VideoPicker,PublishErrors}.tsx`
- 创建：`frontend/admin-web/src/movies/MovieEditor.test.tsx`
- 修改：`frontend/admin-web/src/app/App.tsx`

- [ ] **步骤 1：编写失败测试**

覆盖紧凑字段、海报即时预览、点击海报替换、取消文件选择不丢旧图、上传失败保留旧图、发布缺失项显示、非草稿页面全部只读。

运行：`npm test --workspace @movie-harbor/admin-web -- MovieEditor`

预期：FAIL，电影编辑器不存在。

- [ ] **步骤 2：实现草稿编辑器**

使用对象 URL 预览并在替换/卸载时释放；先保存字段和题材，再按受控上传协议关联海报和视频；提交携带 `version`。

- [ ] **步骤 3：接入生命周期操作和删除确认**

删除确认展示后端返回的影响数量并要求输入完整内容名称；归档、发布、转草稿成功后重新拉取详情。

- [ ] **步骤 4：验证并提交**

运行后台全部测试和构建后提交：

```bash
git add frontend/admin-web/src/movies frontend/admin-web/src/app/App.tsx
git commit -m "feat: add movie draft editor"
```

### 任务 13：实现剧集、季和单集编辑器

**文件：**
- 创建：`frontend/admin-web/src/series/{SeriesEditor,SeasonCard,EpisodeRow,SeriesPublishErrors}.tsx`
- 创建：`frontend/admin-web/src/series/SeriesEditor.test.tsx`
- 修改：`frontend/admin-web/src/app/App.tsx`

- [ ] **步骤 1：编写失败测试**

覆盖剧集基本信息、海报预览、季只显示序号、默认一季一集、单集名称必填、添加/删除季与单集、已发布剧集自身只读但可新增子级、有已发布单集时锁定季序号与删除按钮。

运行：`npm test --workspace @movie-harbor/admin-web -- SeriesEditor`

预期：FAIL，剧集编辑器不存在。

- [ ] **步骤 2：实现经审核的添加剧集页面**

迁移 `demo/?view=series-editor` 的两段式布局：基本信息、季与单集；每个单集独立保存为草稿并上传视频，不把整季序列化成一次大更新。

- [ ] **步骤 3：实现父子状态刷新**

发布或归档单集后重新读取剧集结构；父剧集归档时清除公开缓存；所有锁定状态以后端权限结果为准。

- [ ] **步骤 4：验证并提交**

运行后台全部测试和构建后提交：

```bash
git add frontend/admin-web/src/series frontend/admin-web/src/app/App.tsx
git commit -m "feat: add series and episode editor"
```

### 任务 14：播放器与浏览器本地进度

**文件：**
- 创建：`frontend/public-web/src/player/{PlayerPage,VideoPlayer,EpisodePicker,progressStore}.tsx`
- 创建：`frontend/public-web/src/player/progressStore.test.ts`
- 创建：`frontend/public-web/src/player/PlayerPage.test.tsx`
- 修改：`frontend/public-web/src/app/App.tsx`

- [ ] **步骤 1：编写失败测试**

覆盖按内容 ID 保存进度、节流写入、接近结尾时清除进度、继续/从头选择、剧集最近单集、上一集/下一集边界和本地数据损坏时回退为空。

运行：`npm test --workspace @movie-harbor/public-web -- player`

预期：FAIL，播放器与进度存储不存在。

- [ ] **步骤 2：实现播放器页面**

使用原生 `<video>`；不实现转码或外挂字幕；源地址直接使用 API 返回的公开 `/media` URL；对无法播放格式给出明确提示。

- [ ] **步骤 3：实现本地进度**

`localStorage` 使用带版本号的单一命名空间；每 5 秒及暂停/离开时保存；剩余不足 30 秒视为完成并移除续播点。

- [ ] **步骤 4：验证并提交**

运行公开站全部测试和构建后提交：

```bash
git add frontend/public-web/src/player frontend/public-web/src/app/App.tsx
git commit -m "feat: add playback and local progress"
```

### 任务 15：Docker Compose、同源代理和端到端验收

**文件：**
- 创建：`backend/Dockerfile`
- 创建：`frontend/public-web/Dockerfile`
- 创建：`frontend/admin-web/Dockerfile`
- 创建：`docker-compose.yml`
- 创建：`Caddyfile`
- 创建：`.env.example`
- 创建：`tests/e2e/{public.spec.ts,admin.spec.ts,series.spec.ts,playback.spec.ts}`
- 创建：`playwright.config.ts`
- 修改：`README.md`

- [ ] **步骤 1：编写失败的端到端测试**

测试空环境启动、管理员首次登录、题材、电影完整生命周期、剧集逐集发布、公开搜索与详情、归档立即隐藏、视频 Range 请求、重启持久化和密码环境变量不覆盖已有账号。

运行：`npm run test:e2e`

预期：FAIL，生产编排和完整应用尚未就绪。

- [ ] **步骤 2：实现容器与健康检查**

PostgreSQL 使用持久卷；API 等待数据库健康并自动运行迁移；公开站和后台使用独立静态容器；媒体卷同时挂载给 API 与 Caddy，其中 Caddy 只读。

- [ ] **步骤 3：实现同源路由**

`/api/*` 反向代理到 Axum，`/media/*` 从媒体卷提供并禁用目录浏览，`/admin/*` 回退到后台入口，其余路径回退到公开站入口；HTTPS 由部署者域名配置启用。

- [ ] **步骤 4：补充部署、备份与格式说明**

README 写明初始化变量只首次生效、媒体目录权限、支持格式、公开 URL 无防下载保证、数据库与媒体目录必须一起备份、Demo 启动方式和生产启动命令。

- [ ] **步骤 5：运行完整验证**

运行：`cargo fmt --all -- --check`

运行：`cargo clippy --workspace --all-targets -- -D warnings`

运行：`cargo test --workspace`

运行：`npm test --workspaces`

运行：`npm run build --workspaces`

运行：`docker compose up -d --build`

运行：`npm run test:e2e`

运行：`docker compose restart`

再次运行持久化相关端到端测试。预期所有命令退出码为 0，无测试失败或编译警告。

- [ ] **步骤 6：最终提交**

```bash
git add -A
git commit -m "feat: deliver self-hosted media library"
```

## 完成定义

- 规格第 1–15 节均由上述任务覆盖。
- `demo/` 保留为审核历史，不参与生产构建。
- 两套前端可独立构建，生产环境通过同一域名访问。
- 后端状态机、认证、上传、文件清理和公开可见性都有自动化测试。
- Docker Compose 从空卷启动、重启持久化和备份边界均经过端到端验证。
- 没有实现规格中的首版非目标。
