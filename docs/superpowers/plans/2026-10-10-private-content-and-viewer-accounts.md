# 私密内容、普通用户与严格媒体鉴权实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在保持管理员职责和匿名公开浏览不变的前提下，加入普通用户认证、电影与整剧私密状态、后台用户管理，以及覆盖媒体直链的严格访问控制。

**架构：** 管理员和普通用户使用独立表、Cookie 与中间件；目录查询根据可选普通用户会话决定是否包含私密内容。所有 `/media/*` 请求先由 Axum 根据受控存储键、媒体所有权、内容状态和会话授权，再由 Caddy 继续提供静态文件与 Range 传输。

**技术栈：** Rust、Axum、SeaORM、PostgreSQL、React、TypeScript、Vite、Caddy、Docker Compose、Vitest、Node Test Runner、Playwright。

**设计依据：** `docs/superpowers/specs/2026-10-10-private-content-and-viewer-accounts-design.md`

---

## 文件结构

### 后端与数据库

- 创建 `backend/migration/src/m20261010_000006_private_content_and_viewers.rs`：新增普通用户、普通用户会话和内容私密字段及索引。
- 创建 `backend/src/entities/viewer_user.rs`、`backend/src/entities/viewer_session.rs`：普通用户 SeaORM 实体。
- 创建 `backend/src/viewer_auth/{mod.rs,model.rs,session.rs,routes.rs}`：普通用户登录、会话、退出与自助改密。
- 创建 `backend/src/admin_users/{mod.rs,dto.rs,service.rs,routes.rs}`：管理员用户列表、创建、改密和删除。
- 创建 `backend/src/media/authorization.rs`：媒体存储键解析、所有权查询和访问判定。
- 修改 `backend/src/entities/{mod.rs,movie.rs,series.rs}`：注册新实体和 `is_private`。
- 修改 `backend/src/{app.rs,lib.rs}`：挂载新增领域路由。
- 修改 `backend/src/auth/{routes.rs,session.rs}`：管理员 Cookie 扩展到 `/` 并兼容清除旧路径 Cookie。
- 修改 `backend/src/catalog/{dto.rs,query.rs,routes.rs}`：可选普通用户会话和公开/私密查询。
- 修改 `backend/src/admin_content/{dto.rs,query.rs}`：访问范围筛选与列表字段。
- 修改 `backend/src/movies/{dto.rs,routes.rs,service.rs,repository.rs}`、`backend/src/series/{dto.rs,routes.rs,service.rs,repository.rs}`：创建、详情和独立私密切换。
- 修改 `backend/src/admin_export/{dto.rs,query.rs}`：电影和剧集导出 `is_private`。
- 修改 `backend/src/media/mod.rs`：注册媒体授权模块。

### 后端测试

- 修改 `backend/tests/migration_test.rs`：新表、字段、约束、默认值和回滚。
- 创建 `backend/tests/viewer_auth_test.rs`：普通用户认证、改密和会话撤销。
- 创建 `backend/tests/admin_users_test.rs`：用户管理 API、重名、并发和删除。
- 创建 `backend/tests/media_authorization_test.rs`：四种媒体所有权和三种身份矩阵。
- 修改 `backend/tests/{catalog_test.rs,admin_content_test.rs,movies_test.rs,series_test.rs,admin_export_test.rs,auth_test.rs}`：私密字段、查询和 Cookie 行为。

### API 客户端和前端

- 修改 `frontend/packages/api-client/src/{types.ts,http.ts,admin.ts,public.ts,index.ts}`：新增私密字段、普通用户认证和用户管理函数。
- 修改 `frontend/packages/api-client/src/{admin.test.ts,http.test.ts}`：请求路径、CSRF 和序列化契约。
- 创建 `frontend/admin-web/src/users/{UserPage.tsx,UserPage.test.tsx,UserDialog.tsx}`：已确认用户管理页面。
- 创建 `frontend/admin-web/src/content/PrivacySelector.tsx`：电影和整剧共用访问范围控件。
- 修改 `frontend/admin-web/src/app/{App.tsx,App.test.tsx}`：新增用户管理导航。
- 修改 `frontend/admin-web/src/content/{ActionButtons.tsx,ContentFilters.tsx,ContentPage.tsx,ContentTable.tsx,ContentPage.test.tsx}`：访问范围筛选、状态和直接切换。
- 修改 `frontend/admin-web/src/movies/{MovieEditor.tsx,MovieEditor.test.tsx}`、`frontend/admin-web/src/series/{SeriesEditor.tsx,SeriesEditor.test.tsx}`：创建与整剧私密选择。
- 创建 `frontend/public-web/src/auth/{ViewerLoginDialog.tsx,ViewerPasswordDialog.tsx}`：普通用户登录和改密。
- 修改 `frontend/public-web/src/app/App.tsx`、`frontend/public-web/src/catalog/{CatalogPage.tsx,CatalogGrid.tsx}`、详情组件和测试：会话状态、私密标签与重新加载。
- 修改 `frontend/admin-web/src/styles.css`、`frontend/public-web/src/styles.css`：复用已确认 Demo 的布局与状态样式。

### 部署、导入和文档

- 修改 `Caddyfile`：为合法 `/media/poster/*` 和 `/media/video/*` 加入前置鉴权。
- 修改 `tools/content-import/{schema.mjs,importer.mjs}` 及对应测试：兼容缺失字段并恢复 `is_private`。
- 修改 `tests/e2e/{helpers.ts,public.spec.ts,admin.spec.ts,playback.spec.ts,export.spec.ts,import.spec.ts}`：跨服务验收。
- 修改 `docs/guides/{database-schema.md,deployment.md,content-transfer.md}`、`AGENTS.md`：同步最终架构和运维约束。

---

### 任务 1：数据库迁移与实体

**文件：**
- 创建：`backend/migration/src/m20261010_000006_private_content_and_viewers.rs`
- 修改：`backend/migration/src/lib.rs`
- 创建：`backend/src/entities/viewer_user.rs`
- 创建：`backend/src/entities/viewer_session.rs`
- 修改：`backend/src/entities/mod.rs`
- 修改：`backend/src/entities/movie.rs`
- 修改：`backend/src/entities/series.rs`
- 测试：`backend/tests/migration_test.rs`

- [ ] **步骤 1：编写失败的迁移测试**

新增从第五次迁移升级到最新版本的测试，断言现有内容默认为公开、季和单集没有私密列，并验证普通用户名归一化唯一和会话级联删除：

```rust
let db = TestDatabase::at_migration("private_upgrade", Some(5)).await;
db.execute_unprepared("INSERT INTO movie (id, name) VALUES ('10000000-0000-0000-0000-000000000001', 'Existing')").await.unwrap();
Migrator::up(&db, None).await.unwrap();
let row = db.query_one(Statement::from_string(DatabaseBackend::Postgres,
    "SELECT is_private FROM movie WHERE name = 'Existing'".into())).await.unwrap().unwrap();
assert!(!row.try_get::<bool>("", "is_private").unwrap());
```

再插入 `Summer` 与 `summer` 的归一化用户名，断言第二次插入违反唯一约束；删除用户后断言 `viewer_session` 归零。

- [ ] **步骤 2：运行迁移测试并确认失败**

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test migration_test private
```

预期：FAIL，原因是第六次迁移、`is_private` 或普通用户表尚不存在。

- [ ] **步骤 3：实现第六次迁移**

迁移使用 PostgreSQL 约束一次完成：

```sql
ALTER TABLE movie ADD COLUMN is_private boolean NOT NULL DEFAULT false;
ALTER TABLE series ADD COLUMN is_private boolean NOT NULL DEFAULT false;
CREATE TABLE viewer_user (
  id uuid PRIMARY KEY,
  username text NOT NULL CHECK (length(btrim(username)) > 0),
  normalized_username text NOT NULL UNIQUE CHECK (length(normalized_username) > 0),
  password_hash text NOT NULL,
  last_login_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE viewer_session (
  id uuid PRIMARY KEY,
  viewer_user_id uuid NOT NULL REFERENCES viewer_user(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX viewer_session_user_idx ON viewer_session(viewer_user_id);
CREATE INDEX viewer_session_expiry_idx ON viewer_session(expires_at);
CREATE INDEX movie_public_catalog_idx ON movie (published_at DESC, id) WHERE status = 'published' AND is_private = false;
CREATE INDEX series_public_catalog_idx ON series (published_at DESC, id) WHERE status = 'published' AND is_private = false;
```

`down` 必须按相反顺序删除新增索引、表和字段。

- [ ] **步骤 4：实现 SeaORM 实体并注册迁移**

`viewer_user::Model` 包含迁移中的全部字段；`viewer_session::Relation` 以 `on_delete = "Cascade"` 关联用户。电影和剧集实体各增加：

```rust
pub is_private: bool,
```

- [ ] **步骤 5：运行迁移与实体相关测试**

运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test migration_test
cargo check --manifest-path backend/Cargo.toml --all-targets
```

预期：全部 PASS。

- [ ] **步骤 6：提交**

```bash
git add backend/migration backend/src/entities backend/tests/migration_test.rs
git commit -m "feat: add private content and viewer schema"
```

### 任务 2：普通用户认证与自助改密

**文件：**
- 创建：`backend/src/viewer_auth/mod.rs`
- 创建：`backend/src/viewer_auth/model.rs`
- 创建：`backend/src/viewer_auth/session.rs`
- 创建：`backend/src/viewer_auth/routes.rs`
- 修改：`backend/src/lib.rs`
- 修改：`backend/src/app.rs`
- 修改：`backend/src/auth/session.rs`
- 修改：`backend/src/auth/routes.rs`
- 测试：`backend/tests/viewer_auth_test.rs`
- 测试：`backend/tests/auth_test.rs`

- [ ] **步骤 1：编写失败的普通用户认证测试**

用真实 PostgreSQL 和 `Router::oneshot` 覆盖登录、会话读取、退出、自助改密和双会话撤销：

```rust
let login = post_json(&app, "/api/viewer/login", json!({"username":"summer","password":"viewer-password"}), None, None).await;
assert_eq!(login.status(), StatusCode::OK);
let cookie = response_cookie(&login, "mh_viewer_session");
let session = get(&app, "/api/viewer/session", Some(&cookie)).await;
assert_eq!(body(session).await["username"], "Summer");
```

测试未知用户名和错误密码返回相同 `401`，改密必须带当前密码、同源 Origin 和 CSRF；成功后两个旧 Cookie 都失效且旧密码不能登录。

- [ ] **步骤 2：增加管理员 Cookie 路径回归测试并确认失败**

在 `auth_test.rs` 断言管理员登录 Cookie 包含 `Path=/`，退出和改密同时发送清理 `/` 与 `/api/admin` 的 Cookie。运行：

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test viewer_auth_test --test auth_test cookie
```

预期：FAIL，普通用户路由不存在且管理员 Cookie 仍为 `/api/admin`。

- [ ] **步骤 3：实现普通用户会话模块**

复用 `auth::password`、`auth::csrf`、`AuthState::limits` 和密码工作信号量，但使用独立 Cookie：

```rust
pub const COOKIE_NAME: &str = "mh_viewer_session";
pub fn cookie(token: &str, secure: bool, clear: bool) -> String {
    format!("{COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",
        if clear { 0 } else { SESSION_SECONDS },
        if secure { "; Secure" } else { "" })
}
```

`authenticate_optional` 只在 Cookie 缺失时返回 `Ok(None)`；格式错误、过期或未知 Cookie 也返回 `Ok(None)`，不能授予私密权限。受保护的 `/api/viewer/session` 和写路由使用严格 `authenticate` 并返回 `401`。

- [ ] **步骤 4：实现登录、退出、会话和自助改密路由**

登录按 `normalized_username = input.username.trim().to_lowercase()` 查询，未知账号使用固定的有效 Argon2 摘要执行等成本校验。成功登录在事务锁内重读用户并更新 `last_login_at`、创建会话。

改密流程固定为：事务外校验当前密码与计算新摘要，事务内锁用户、重新验证当前会话和旧摘要、更新密码与版本、删除全部 `viewer_session`、提交后清理 Cookie。

- [ ] **步骤 5：调整管理员 Cookie 路径并兼容旧 Cookie 清理**

管理员新 Cookie 改为 `Path=/`。登录只设置新 Cookie；退出和改密响应追加两条 `Set-Cookie`，分别清理 `/` 和旧 `/api/admin` 路径。Cookie 名仍为 `mh_session`，公共目录代码不得读取它。

- [ ] **步骤 6：运行认证测试**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test viewer_auth_test --test auth_test
```

预期：全部 PASS，且无明文令牌或密码进入响应与数据库。

- [ ] **步骤 7：提交**

```bash
git add backend/src/viewer_auth backend/src/auth backend/src/app.rs backend/src/lib.rs backend/tests/viewer_auth_test.rs backend/tests/auth_test.rs
git commit -m "feat: add viewer authentication"
```

### 任务 3：管理员用户管理 API

**文件：**
- 创建：`backend/src/admin_users/mod.rs`
- 创建：`backend/src/admin_users/dto.rs`
- 创建：`backend/src/admin_users/service.rs`
- 创建：`backend/src/admin_users/routes.rs`
- 修改：`backend/src/lib.rs`
- 修改：`backend/src/app.rs`
- 测试：`backend/tests/admin_users_test.rs`

- [ ] **步骤 1：编写失败的管理员用户管理测试**

测试分页搜索、概览、创建、大小写重名、修改密码、版本冲突、会话撤销和删除：

```rust
let created = admin_json(&app, "POST", "/api/admin/users",
    json!({"username":"Summer","password":"viewer-password"}), &admin).await;
assert_eq!(created.status(), StatusCode::CREATED);
assert_eq!(body(created).await["username"], "Summer");
let duplicate = admin_json(&app, "POST", "/api/admin/users",
    json!({"username":" summer ","password":"another-password"}), &admin).await;
assert_eq!(duplicate.status(), StatusCode::CONFLICT);
```

明确断言不存在 `PATCH /api/admin/users/{id}` 修改用户名的能力。

- [ ] **步骤 2：运行测试并确认失败**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test admin_users_test
```

预期：FAIL，管理路由尚未注册。

- [ ] **步骤 3：实现 DTO、分页查询和概览**

`GET /api/admin/users?q=&page=&size=20` 返回：

```rust
pub struct ViewerUserPage {
    pub page: u64,
    pub size: u64,
    pub total: u64,
    pub items: Vec<ViewerUserSummary>,
    pub summary: ViewerUserOverview,
}
```

`ViewerUserSummary` 包含 `id`、`username`、`version`、`created_at`、`last_login_at`、`has_active_session`，不包含密码摘要。搜索使用转义后的绑定参数，列表固定 20 条并采用 `created_at DESC, id ASC` 稳定排序。

- [ ] **步骤 4：实现创建、管理员改密和删除事务**

创建前规范化用户名，事务内依赖唯一约束兜底；冲突返回 `409`。管理员改密与删除请求均提交 `version`：

```rust
pub struct AdminPasswordRequest { pub version: i64, pub new_password: String }
pub struct DeleteViewerRequest { pub version: i64 }
```

改密在锁内校验版本、更新摘要和版本、删除全部会话。删除在锁内校验版本后删除用户，外键级联会话。两者都使用现有管理中间件和 CSRF。

- [ ] **步骤 5：运行测试并提交**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test admin_users_test
git add backend/src/admin_users backend/src/app.rs backend/src/lib.rs backend/tests/admin_users_test.rs
git commit -m "feat: add admin viewer management api"
```

### 任务 4：内容私密字段、管理查询与导出

**文件：**
- 修改：`backend/src/movies/{dto.rs,routes.rs,service.rs,repository.rs}`
- 修改：`backend/src/series/{dto.rs,routes.rs,service.rs,repository.rs}`
- 修改：`backend/src/admin_content/{dto.rs,query.rs}`
- 修改：`backend/src/admin_export/{dto.rs,query.rs}`
- 测试：`backend/tests/{movies_test.rs,series_test.rs,admin_content_test.rs,admin_export_test.rs}`

- [ ] **步骤 1：编写失败的电影和剧集私密状态测试**

创建接口接收 `is_private`，默认值由客户端显式提交；详情响应始终包含该字段。新增独立路由：

```text
PUT /api/admin/movies/{id}/privacy
PUT /api/admin/series/{id}/privacy
```

请求为 `{"version": 3, "is_private": true}`。分别对草稿、已发布和已归档内容测试切换成功、版本增加和旧版本 `409`；断言季和单集 DTO 没有该字段。

- [ ] **步骤 2：编写失败的统一列表和导出测试**

在管理内容测试中断言 `privacy=private` 只返回私密电影和剧集，条目包含 `is_private`。在导出测试中断言电影和剧集包含布尔值，单集不包含：

```rust
assert_eq!(payload["movies"][0]["is_private"], true);
assert!(payload["series"][0]["episodes"][0].get("is_private").is_none());
```

- [ ] **步骤 3：运行目标测试并确认失败**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test movies_test --test series_test --test admin_content_test --test admin_export_test private
```

预期：FAIL，DTO、查询和切换路由尚未实现。

- [ ] **步骤 4：实现创建、响应和独立切换**

`CreateMovieRequest`、`CreateSeriesRequest` 增加 `is_private: bool`；`MovieResponse`、`SeriesResponse` 增加 `is_private`。私密切换不调用生命周期转换，只执行带版本条件的更新：

```rust
UPDATE movie SET is_private = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP
WHERE id = $2 AND version = $3
RETURNING *;
```

仓储层区分不存在和版本冲突，响应沿用领域错误语义。

- [ ] **步骤 5：实现管理筛选和导出字段**

`AdminContentRequest` 增加 `privacy=public|private`，SQL 的电影与剧集分支都绑定同一可空布尔参数。`AdminContentItem`、`ExportMovie`、`ExportSeries` 增加 `is_private`，导出查询从一致快照读取。

- [ ] **步骤 6：运行测试并提交**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test movies_test --test series_test --test admin_content_test --test admin_export_test
git add backend/src/movies backend/src/series backend/src/admin_content backend/src/admin_export backend/tests
git commit -m "feat: manage private movies and series"
```

### 任务 5：内容导入向后兼容

**文件：**
- 修改：`tools/content-import/schema.mjs`
- 修改：`tools/content-import/importer.mjs`
- 测试：`tests/content-import-schema.test.mjs`
- 测试：`tests/content-import-importer.test.mjs`

- [ ] **步骤 1：编写失败的旧格式和新格式测试**

旧文件没有 `is_private` 时解析为 `false`；新文件必须接受布尔值并拒绝字符串或 `null`：

```javascript
assert.equal(source.movies[0].isPrivate, false);
assert.equal(source.series[0].isPrivate, true);
await assert.rejects(loadFixture({ movies: [{ ...movie, is_private: "true" }] }), /is_private must be a boolean/);
```

导入器测试断言创建请求携带访问范围，恢复导入时也校验目标私密状态。

- [ ] **步骤 2：运行测试并确认失败**

```bash
node --test tests/content-import-schema.test.mjs tests/content-import-importer.test.mjs
```

预期：FAIL，解析结果和请求缺少私密字段。

- [ ] **步骤 3：实现兼容解析与导入**

增加只对该字段允许缺失的解析器：

```javascript
function optionalBoolean(source, name, context, fallback = false) {
  if (!Object.hasOwn(source, name)) return fallback;
  if (typeof source[name] !== "boolean") throw new Error(`${context}.${name} must be a boolean`);
  return source[name];
}
```

电影和剧集创建请求发送 `{ name, is_private: item.isPrivate }`。恢复目标若 `is_private` 与进度源不一致则按内容已变化返回冲突，不能静默改写。

- [ ] **步骤 4：运行测试并提交**

```bash
node --test tests/content-import-schema.test.mjs tests/content-import-importer.test.mjs
git add tools/content-import tests/content-import-schema.test.mjs tests/content-import-importer.test.mjs
git commit -m "feat: preserve privacy in content transfer"
```

### 任务 6：公开目录的可选普通用户会话

**文件：**
- 修改：`backend/src/catalog/dto.rs`
- 修改：`backend/src/catalog/query.rs`
- 修改：`backend/src/catalog/routes.rs`
- 测试：`backend/tests/catalog_test.rs`

- [ ] **步骤 1：编写失败的匿名与登录可见性测试**

同一数据库插入已发布公开、已发布私密、草稿私密电影和剧集。匿名目录/搜索只看到公开项；普通用户 Cookie 能看到两类已发布内容；管理员 Cookie 不改变公开目录。匿名请求私密详情为 `404`，普通用户为 `200`。

```rust
assert_eq!(json_body(get(&app, "/api/catalog?q=Private", None).await)["total"], 0);
assert_eq!(json_body(get(&app, "/api/catalog?q=Private", Some(&viewer_cookie)).await)["total"], 2);
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test catalog_test private
```

预期：FAIL，当前查询无 `is_private` 条件和可选会话。

- [ ] **步骤 3：让目录查询接收可见性参数**

将 `list`、`movie`、`series` 增加 `include_private: bool`，每个电影和剧集 SQL 分支增加：

```sql
AND ($visibility::boolean OR movie.is_private = false)
```

`CatalogCard`、`MovieDetail`、`SeriesDetail` 增加 `is_private`，用于已登录页面标签。题材查询仍只接收当前可见页的 ID。

- [ ] **步骤 4：在路由解析可选普通用户会话**

目录路由状态改为同时持有数据库与普通用户会话验证所需状态。每个请求调用 `viewer_auth::session::authenticate_optional`，仅 `Some(session)` 时传入 `include_private=true`。响应统一添加：

```text
Cache-Control: private, no-store
Vary: Cookie
```

- [ ] **步骤 5：运行测试并提交**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test catalog_test
git add backend/src/catalog backend/tests/catalog_test.rs
git commit -m "feat: filter private catalog by viewer session"
```

### 任务 7：严格媒体授权与 Caddy 前置鉴权

**文件：**
- 创建：`backend/src/media/authorization.rs`
- 修改：`backend/src/media/mod.rs`
- 修改：`backend/src/media/routes.rs`
- 修改：`backend/src/app.rs`
- 修改：`Caddyfile`
- 测试：`backend/tests/media_authorization_test.rs`
- 测试：`tests/e2e/playback.spec.ts`

- [ ] **步骤 1：编写失败的媒体授权矩阵测试**

为公开电影海报/视频、私密电影海报/视频、私密剧集海报、私密剧集已发布单集视频、草稿单集视频和无归属资产建立 fixture。向授权路由传入 `X-Forwarded-Uri`，验证匿名、普通用户和管理员三种 Cookie：

```rust
let denied = authorize(&app, "/media/video/ab/private.mp4", None).await;
assert_eq!(denied.status(), StatusCode::NOT_FOUND);
let allowed = authorize(&app, "/media/video/ab/private.mp4", Some(&viewer_cookie)).await;
assert_eq!(allowed.status(), StatusCode::NO_CONTENT);
```

加入路径穿越、`.incoming`、`.quarantine`、用途不匹配和无所有者测试。

- [ ] **步骤 2：运行后端测试并确认失败**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test media_authorization_test
```

预期：FAIL，授权端点不存在。

- [ ] **步骤 3：实现受控存储键到所有者的授权查询**

授权端点只接受 Caddy 提供的原始 URI，将其转换为现有 `controlled_storage_key` 可验证的键。SQL 通过 `media_asset_ownership` 的唯一所有者类型连接电影、剧集或单集父链，返回最小判定数据：父状态、父私密值和单集状态。

判定顺序为：管理员有效会话允许；否则资源必须有效发布，公开资源允许匿名，私密资源还要求普通用户有效会话。所有拒绝统一返回 `404`，允许返回 `204`，响应 `Cache-Control: private, no-store`。

- [ ] **步骤 4：配置 Caddy `forward_auth`**

在合法媒体 matcher 内、`file_server` 之前增加：

```caddyfile
forward_auth api:3000 {
    uri /api/media/authorize
    header_up X-Forwarded-Uri {uri}
    header_up X-Movie-Harbor-Proxy-Token {$TRUST_PROXY_SECRET}
}
```

保留 `/media/.incoming/*`、`/media/.quarantine/*` 和其他路径的现有 `404` 边界。授权成功后仍由 `root * /srv` 和 `file_server` 发送文件。

- [ ] **步骤 5：增加跨服务直链与 Range 测试**

在 `playback.spec.ts` 创建公开和私密电影/剧集媒体，断言匿名私密 URL 为 `404`、登录后为 `200/206`、退出后再次为 `404`，并验证 `Range: bytes=0-1` 返回正确两字节。

- [ ] **步骤 6：运行后端和 E2E 目标测试并提交**

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --manifest-path backend/Cargo.toml --test media_authorization_test
npm run test:e2e
git add backend/src/media backend/src/app.rs backend/tests/media_authorization_test.rs Caddyfile tests/e2e/playback.spec.ts
git commit -m "feat: authorize media before static delivery"
```

### 任务 8：共享 API 客户端

**文件：**
- 修改：`frontend/packages/api-client/src/types.ts`
- 修改：`frontend/packages/api-client/src/http.ts`
- 修改：`frontend/packages/api-client/src/admin.ts`
- 修改：`frontend/packages/api-client/src/public.ts`
- 修改：`frontend/packages/api-client/src/index.ts`
- 测试：`frontend/packages/api-client/src/admin.test.ts`
- 测试：`frontend/packages/api-client/src/http.test.ts`

- [ ] **步骤 1：编写失败的客户端契约测试**

覆盖普通用户登录/会话/退出/改密，管理员用户 CRUD，内容访问范围筛选与切换，以及创建电影/剧集提交 `is_private`。断言普通用户不复用管理路由：

```typescript
await viewerLogin({ username: "Summer", password: "viewer-password" });
expect(requests[0].url).toBe("/api/viewer/login");
await setMoviePrivacy("movie-1", 3, true);
expect(requests[1].json).toEqual({ version: 3, is_private: true });
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
npm test -w @movie-harbor/api-client
```

预期：FAIL，类型和函数尚不存在。

- [ ] **步骤 3：增加显式类型和 API 函数**

定义 `ViewerSessionResponse`、`ViewerUserPage`、`ViewerUserSummary`、`PrivacyRequest`，并给电影、剧集、公共卡片和详情增加 `is_private: boolean`。`AdminContentListQuery` 增加 `privacy`。

`viewerLogin` 成功后读取 `/api/viewer/session` 或使用登录响应中的 CSRF；`viewerLogout` 和 `changeViewerPassword` 清理客户端 CSRF。`http.ts` 将安全写请求判定扩展为 `/api/admin/*` 或 `/api/viewer/*`，同一前端 bundle 内只会存在一种当前会话。

- [ ] **步骤 4：运行测试、类型检查并提交**

```bash
npm test -w @movie-harbor/api-client
npm run build -w @movie-harbor/api-client
git add frontend/packages/api-client
git commit -m "feat: expose viewer and privacy api clients"
```

### 任务 9：管理后台访问范围 UI

**文件：**
- 创建：`frontend/admin-web/src/content/PrivacySelector.tsx`
- 修改：`frontend/admin-web/src/content/{ActionButtons.tsx,ContentFilters.tsx,ContentPage.tsx,ContentTable.tsx,ContentPage.test.tsx}`
- 修改：`frontend/admin-web/src/movies/{MovieEditor.tsx,MovieEditor.test.tsx}`
- 修改：`frontend/admin-web/src/series/{SeriesEditor.tsx,SeriesEditor.test.tsx}`
- 修改：`frontend/admin-web/src/styles.css`

- [ ] **步骤 1：编写失败的内容列表测试**

断言“访问范围”筛选进入请求，表格显示公开/私密，所有生命周期状态都出现目标状态按钮；点击后发送版本并刷新：

```typescript
await user.click(screen.getByRole("button", { name: "设为私密" }));
expect(requests.at(-1)).toMatchObject({ url: "/api/admin/movies/movie-1/privacy", method: "PUT", body: { version: 4, is_private: true } });
```

- [ ] **步骤 2：编写失败的新建电影和剧集测试**

电影与剧集创建页默认选中公开，选择私密后创建请求携带 `is_private: true`。剧集测试断言“访问范围”只出现一次，季和单集区域没有独立开关。

- [ ] **步骤 3：运行测试并确认失败**

```bash
npm test -w @movie-harbor/admin-web -- ContentPage MovieEditor SeriesEditor
```

预期：FAIL，列表和编辑器没有私密控件。

- [ ] **步骤 4：实现列表、筛选和直接切换**

`ContentAction` 增加 `privacy`，按钮文案由当前值决定。切换期间禁用当前列表写操作；成功后增加列表 `revision`，`401` 退出管理员会话，`409` 提示重新加载。筛选值使用 `"all" | "public" | "private"`。

- [ ] **步骤 5：实现共享访问范围选择器**

`PrivacySelector` 接收 `value: boolean`、`onChange`、`disabled` 和 `series`；电影私密说明为“仅登录后的普通用户可查看”，剧集说明为“整个剧集及所有季、单集仅登录后可见”。只在父编辑器渲染。

- [ ] **步骤 6：运行测试、构建并提交**

```bash
npm test -w @movie-harbor/admin-web
npm run build -w @movie-harbor/admin-web
git add frontend/admin-web
git commit -m "feat: manage content privacy in admin ui"
```

### 任务 10：管理后台普通用户页面

**文件：**
- 创建：`frontend/admin-web/src/users/UserPage.tsx`
- 创建：`frontend/admin-web/src/users/UserDialog.tsx`
- 创建：`frontend/admin-web/src/users/UserPage.test.tsx`
- 修改：`frontend/admin-web/src/app/App.tsx`
- 修改：`frontend/admin-web/src/app/App.test.tsx`
- 修改：`frontend/admin-web/src/styles.css`

- [ ] **步骤 1：编写失败的页面测试**

测试导航、概览、搜索、分页、添加、大小写重名提示、修改密码会话说明和删除确认。明确断言页面中没有“修改用户名”或“重置密码”：

```typescript
expect(screen.queryByRole("button", { name: "修改用户名" })).not.toBeInTheDocument();
expect(screen.queryByRole("button", { name: "重置密码" })).not.toBeInTheDocument();
await user.click(screen.getByRole("button", { name: "修改密码" }));
expect(screen.getByText(/现有的登录会话会立即失效/)).toBeInTheDocument();
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
npm test -w @movie-harbor/admin-web -- UserPage App
```

预期：FAIL，导航和用户页面尚不存在。

- [ ] **步骤 3：实现已确认 Demo 的组件结构**

`UserPage` 持有筛选、页码、请求状态和当前对话框操作。创建表单收集不可变用户名和初始密码；修改密码对话框只读显示用户名并收集新密码；删除对话框明确不可撤销与会话失效。所有写操作提交最新 `version`，成功后刷新列表和概览。

`App.tsx` 在侧边栏加入“用户管理”，会话过期复用现有 `onExpired`。不加入管理员创建或角色控件。

- [ ] **步骤 4：实现响应式样式并运行测试**

复用 Demo 的概览卡片、表格、私密色和移动端横向导航；窄屏隐藏次要时间列但保留“修改密码”和“删除”。运行：

```bash
npm test -w @movie-harbor/admin-web
npm run build -w @movie-harbor/admin-web
```

预期：全部 PASS。

- [ ] **步骤 5：提交**

```bash
git add frontend/admin-web/src/users frontend/admin-web/src/app frontend/admin-web/src/styles.css
git commit -m "feat: add admin viewer management page"
```

### 任务 11：公开站登录、改密和私密标识

**文件：**
- 创建：`frontend/public-web/src/auth/ViewerLoginDialog.tsx`
- 创建：`frontend/public-web/src/auth/ViewerPasswordDialog.tsx`
- 修改：`frontend/public-web/src/app/App.tsx`
- 修改：`frontend/public-web/src/catalog/CatalogPage.tsx`
- 修改：`frontend/public-web/src/catalog/CatalogGrid.tsx`
- 修改：`frontend/public-web/src/details/{MovieDetails.tsx,SeriesDetails.tsx}`
- 修改：`frontend/public-web/src/player/PlayerPage.tsx`
- 修改：`frontend/public-web/src/styles.css`
- 测试：`frontend/public-web/src/catalog/CatalogPage.test.tsx`
- 测试：`frontend/public-web/src/details/Details.test.tsx`
- 测试：`frontend/public-web/src/player/PlayerPage.test.tsx`
- 创建：`frontend/public-web/src/auth/ViewerAuth.test.tsx`

- [ ] **步骤 1：编写失败的公开站认证测试**

初始加载请求 `/api/viewer/session`；`401` 仍显示匿名目录而不是全页错误。登录按钮打开对话框，成功后刷新当前目录；退出和改密后再次加载公开目录。登录错误统一显示“用户名或密码错误”。

- [ ] **步骤 2：编写失败的私密标识和失效会话测试**

已登录目录卡片和详情对 `is_private=true` 显示“私密”；匿名 fixture 不显示该标识。目录或详情遇到普通用户会话失效时清理身份，但保留公开站可用性并重新发起匿名请求。

- [ ] **步骤 3：运行测试并确认失败**

```bash
npm test -w @movie-harbor/public-web
```

预期：FAIL，普通用户状态和登录 UI 尚不存在。

- [ ] **步骤 4：实现顶层普通用户状态机**

`App` 管理 `loading | anonymous | authenticated | error`，但普通用户会话网络错误只影响登录区域，不阻断匿名目录。头部未登录显示“登录”，登录后显示用户名、修改密码和退出登录。身份改变时增加目录请求 `revision` 并关闭任何已打开的私密详情或播放器。

- [ ] **步骤 5：实现登录和改密对话框**

登录表单收集用户名和密码；改密表单收集当前密码和新密码。改密成功提示“密码已修改，请重新登录”，清理客户端 CSRF 并进入匿名状态。公开站不提供修改用户名或注册入口。

- [ ] **步骤 6：实现私密标签与请求刷新**

目录卡片、电影详情和剧集详情根据 `is_private` 显示一致标签。`usePublicRequest` 接受身份修订值作为重新请求边界，避免登录后复用匿名结果或退出后保留私密结果。

- [ ] **步骤 7：运行测试、构建并提交**

```bash
npm test -w @movie-harbor/public-web
npm run build -w @movie-harbor/public-web
git add frontend/public-web
git commit -m "feat: add viewer login to public site"
```

### 任务 12：端到端验收、文档同步与完整验证

**文件：**
- 修改：`tests/e2e/helpers.ts`
- 修改：`tests/e2e/public.spec.ts`
- 修改：`tests/e2e/admin.spec.ts`
- 修改：`tests/e2e/playback.spec.ts`
- 修改：`tests/e2e/export.spec.ts`
- 修改：`tests/e2e/import.spec.ts`
- 修改：`docs/guides/database-schema.md`
- 修改：`docs/guides/deployment.md`
- 修改：`docs/guides/content-transfer.md`
- 修改：`AGENTS.md`

- [ ] **步骤 1：扩展 E2E 管理辅助类**

`AdminApi` 增加用户创建、改密、删除、内容私密切换；新增 `ViewerApi` 保存 `mh_viewer_session` Cookie 和 CSRF。所有 helper 只使用当前隔离 E2E Origin，不接触生产默认数据目录。

- [ ] **步骤 2：编写跨服务失败测试**

至少覆盖：

```typescript
test("anonymous users cannot discover or fetch private content while viewers can", async ({ request }) => { /* 创建、发布、匿名/登录断言 */ });
test("privacy switches immediately revoke anonymous media access", async ({ request }) => { /* Range 与 404/206 */ });
test("admin password change revokes every viewer session", async ({ request }) => { /* 双会话 */ });
test("series privacy protects poster and every published episode", async ({ request }) => { /* 父级继承 */ });
```

导出/导入 E2E 断言公开与私密电影、剧集往返保持 `is_private`，旧 fixture 缺失字段仍导入为公开。

- [ ] **步骤 3：运行 E2E 并修复集成差异**

```bash
npm run test:e2e
```

预期：新增和既有 Playwright 测试全部 PASS。只修复测试暴露的真实跨服务问题，不放宽安全断言。

- [ ] **步骤 4：同步数据库、部署和传输文档**

`database-schema.md` 记录 `viewer_user`、`viewer_session`、`is_private`、索引、外键和级联删除。`deployment.md` 解释 Caddy 每次媒体请求前置鉴权、管理员 Cookie 路径变化和私密媒体不进入共享缓存。`content-transfer.md` 记录 `is_private` 字段和旧文件默认公开。

`AGENTS.md` 增加本规格和计划链接，并把“发布后的媒体 URL 是公开地址”更新为“媒体 URL 由内容状态、访问范围和会话实时授权”。

- [ ] **步骤 5：运行完整验证矩阵**

```bash
docker compose -f docker-compose.test.yml up -d postgres
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
npm test --workspaces
npm run build --workspaces
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
npm run test:e2e
git diff --check
```

预期：所有命令退出码为 0；不得用局部测试结果替代这组最终输出。

- [ ] **步骤 6：审查最终差异和安全边界**

逐项确认：普通用户无管理能力、管理员 Cookie 不使公开目录包含私密内容、季和单集没有私密字段、所有媒体文件先鉴权、路径异常为 `404`、密码修改撤销全部目标会话、文档未包含真实凭据或生产数据路径。

- [ ] **步骤 7：提交最终集成**

```bash
git add tests/e2e docs/guides AGENTS.md
git commit -m "test: verify private content access end to end"
```
