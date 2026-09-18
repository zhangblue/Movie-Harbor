# Rust 中文行注释实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 `backend/src/**/*.rs` 的生产 Rust 代码补充准确、克制的中文行注释，同时把现有英文行注释统一转换为中文，并保持所有运行行为不变。

**架构：** 按业务边界分批阅读完整函数后添加 `//` 注释；每批只解释业务约束、事务并发、安全边界和关键技术取舍，不为简单语句制造噪声。每个提交都通过“仅注释差异”审计和 Rust 编译检查，最后运行完整 Rust 测试与全局注释审查。

**技术栈：** Rust 2024、Axum 0.8、SeaORM 1.1、Tokio、PostgreSQL、Cargo。

---

## 全局约束

- 基线提交固定为 `9bfb72c`；所有 `backend/src/` 差异必须只增删 `//` 行注释。
- 不修改 `backend/tests/`、`backend/migration/`、接口、类型、SQL、控制流、常量或格式结构。
- 不新增 `///`、`//!`、块注释或 TODO。
- 注释必须使用中文；`CSRF`、`Argon2`、`RepeatableRead`、`sync_all`、类型名和代码标识可保留原文。
- 现有英文行注释必须逐条转换，不能只在旁边追加中文而保留英文原文。
- 非简单函数优先在入口或关键分支前用 1–3 行说明“为什么”和“如何保证”；简单 DTO、显然的字段映射、导入和普通赋值不机械注释。
- `backend/src/` 内的 `#[cfg(test)]` 模块不新增覆盖性注释，但其中现有英文行注释仍须转换。

每个任务结束时运行以下差异审计；输出必须为空：

```bash
git diff --unified=0 9bfb72c -- backend/src \
  | awk '
      /^(---|\+\+\+)/ { next }
      /^[+-]/ {
        line = substr($0, 2)
        if (line !~ /^[[:space:]]*\/\//) print
      }
    '
```

该命令保证被修改的 Rust 源码行都是 `//` 注释；它不能判断注释是否准确，因此每个任务仍须人工对照完整函数上下文审查。

## 文件结构

- 修改 `backend/src/{app,config,content,lib,main,route_params}.rs`：应用组装、配置安全边界和公共生命周期规则。
- 修改 `backend/src/auth/*.rs`：管理员初始化、密码计算、会话、CSRF 与并发登录限流。
- 修改 `backend/src/{admin_content,admin_export,catalog,genres}/*.rs`：管理列表、导出一致快照、公开目录和题材事务。
- 修改 `backend/src/{movies,series}/*.rs`：电影、剧集、季和单集的生命周期、乐观锁与删除事务。
- 修改 `backend/src/media/{mod,path,routes,removal,upload}.rs`：媒体 API、受控路径、上传替换和同步删除。
- 修改 `backend/src/media/storage.rs`：基于目录能力的安全文件存储、持久标记和崩溃恢复。
- 修改 `backend/src/media/validation.rs`：图片、MP4/H.264/HEVC、WebM/EBML 的结构校验和资源边界。
- 审核 `backend/src/entities/*.rs`、各 `dto.rs`、`mod.rs` 与 `error.rs`：仅在存在非显然领域语义时补充，不要求每个文件产生差异。

### 任务 1：应用、配置与公共内容规则

**文件：**
- 修改：`backend/src/app.rs`
- 修改：`backend/src/config.rs`
- 修改：`backend/src/content.rs`
- 修改：`backend/src/route_params.rs`
- 审核：`backend/src/lib.rs`
- 审核：`backend/src/main.rs`
- 审核：`backend/src/error.rs`

- [ ] **步骤 1：阅读完整函数并标记非显然边界**

逐个阅读上述文件，确认注释落点：

- `app::build`：说明路由共享同一数据库、认证状态和媒体存储实例，以及 `DefaultBodyLimit::disable` 只把上传大小控制交给流式策略，不代表无限制上传。
- `Config::from_lookup`、`database_url`、`parse_video_mime_types`、`parse_origin`：说明配置互斥、URL 编码、浏览器可播放白名单、非回环部署必须使用安全 Cookie 的原因。
- `Patch<T>::deserialize`：说明缺失字段与显式 `null` 的三态区别。
- `parse_unique_uuids`：说明去重为何是关联表原子替换的前置条件。
- `ensure_transition`、`apply_target_state`：说明后端统一维护生命周期状态机、幂等目标和时间戳。
- `parse_uuid`：说明调用方传入领域错误以保留各路由的错误语义。

`lib.rs`、`main.rs` 和 `error.rs` 若没有非显然逻辑，保持不变。

- [ ] **步骤 2：添加中文行注释并转换现有英文注释**

使用类似以下粒度的注释，内容须与实际实现一致：

```rust
// 禁用 Axum 的整包默认上限，由流式上传策略按分块累计字节数，避免大视频进入内存。
```

```rust
// Patch 保留“未提交、显式清空、设置新值”三种状态，避免部分更新误删已有字段。
```

`config.rs` 测试模块中现有以 `Catches ...` 开头的英文注释全部转换为中文，但不新增测试说明。

- [ ] **步骤 3：验证仅注释差异与编译**

运行全局差异审计，预期无输出。随后运行：

```bash
cargo fmt --all -- --check
cargo check -p movie-harbor-api
git diff --check
```

- [ ] **步骤 4：提交**

```bash
git add backend/src/app.rs backend/src/config.rs backend/src/content.rs backend/src/route_params.rs backend/src/lib.rs backend/src/main.rs backend/src/error.rs
git commit -m "docs: explain Rust application and content rules"
```

### 任务 2：认证、会话与登录限流

**文件：**
- 修改：`backend/src/auth/mod.rs`
- 修改：`backend/src/auth/csrf.rs`
- 修改：`backend/src/auth/password.rs`
- 修改：`backend/src/auth/rate_limit.rs`
- 修改：`backend/src/auth/routes.rs`
- 修改：`backend/src/auth/session.rs`
- 审核：`backend/src/auth/model.rs`

- [ ] **步骤 1：按安全不变量确定注释位置**

必须覆盖：

- `initialize`：事务和管理员表锁如何保证并发启动只创建一个管理员；已有管理员时为什么忽略环境初始凭据。
- `csrf::{digest,token,matches,same_origin}`：会话令牌与 CSRF 令牌的域分离、摘要存储、常量时间比较和严格同源判断。
- `password::{hash_limited,verify_limited}`：Argon2 放入阻塞线程池以及信号量限制 CPU 密集任务并发的原因。
- `RateLimiter`、`LoginLimit`、`LoginAdmission`、`Window`：IP 与账号双预算、请求入场前预扣、取消仍计费、完成时不重复计费、Drop 释放并发槽位。
- `login`：未知账号仍执行 Argon2、数据库外验证后再次锁行确认哈希未变化，避免枚举和竞态登录。
- `change_password`：当前密码校验、版本重检与全会话撤销的一致性。
- `session::{create,authenticate,authorize_write}`：数据库只存令牌摘要、过期清理、Cookie/CSRF/Origin 三层写请求校验。

- [ ] **步骤 2：添加中文行注释并翻译全部英文行注释**

把当前认证模块中的英文注释转换为中文，包括 `rate_limit.rs`、`routes.rs`、`mod.rs` 和 `csrf.rs`。新增注释应采用如下表达方式：

```rust
// 在任何数据库或 Argon2 await 前预扣一次尝试；即使请求被取消，也不能借此绕过 IP 预算。
```

```rust
// 未知账号同样执行一次 Argon2 校验，使失败路径不因账号是否存在而出现明显时差。
```

- [ ] **步骤 3：验证认证模块未发生行为变化**

运行全局差异审计，预期无输出。随后运行：

```bash
cargo fmt --all -- --check
cargo check -p movie-harbor-api
git diff --check
```

- [ ] **步骤 4：提交**

```bash
git add backend/src/auth
git commit -m "docs: explain Rust authentication safeguards"
```

### 任务 3：管理查询、导出、公开目录与题材

**文件：**
- 修改：`backend/src/admin_content/query.rs`
- 审核：`backend/src/admin_content/dto.rs`
- 审核：`backend/src/admin_content/routes.rs`
- 修改：`backend/src/admin_export/query.rs`
- 修改：`backend/src/admin_export/routes.rs`
- 审核：`backend/src/admin_export/dto.rs`
- 修改：`backend/src/catalog/query.rs`
- 修改：`backend/src/catalog/dto.rs`
- 审核：`backend/src/catalog/routes.rs`
- 修改：`backend/src/genres/service.rs`
- 审核：`backend/src/genres/dto.rs`
- 审核：`backend/src/genres/routes.rs`
- 审核：四个目录中的 `mod.rs`

- [ ] **步骤 1：明确查询与事务注释主题**

必须覆盖：

- 管理内容列表：电影和剧集统一投影、参数化筛选、稳定排序，以及总数和当前页共用 `RepeatableRead` 快照。
- 全量导出：只读可重复读事务为何同时包住父内容、题材、单集和媒体；题材批量查询如何避免 N+1；已停用但仍关联的题材为什么继续导出；受控媒体键如何失败关闭。
- 公开目录：只选择有效发布内容、转义 LIKE 通配符、列表和详情的快照一致性、剧集父级与单集双重可见性、题材批量组装。
- 题材服务：创建/改名的唯一性映射、重排事务中的全量位置校验、停用题材保留旧关联、删除前引用检查、`ensure_associable` 锁住题材行避免检查后状态变化。

- [ ] **步骤 2：添加中文行注释**

注释示例：

```rust
// 总数与当前页必须来自同一 RepeatableRead 快照，避免并发发布导致页码和条目不一致。
```

```rust
// 批量读取全部父级题材并按系统顺序归组，既避免 N+1，也保留已停用的历史关联。
```

```rust
// 对 `%`、`_` 和转义符本身进行转义，使管理员输入始终按普通文本匹配。
```

简单路由转发、DTO 字段和 `mod.rs` 无需为了产生差异而加注释。

- [ ] **步骤 3：验证查询模块**

运行全局差异审计，预期无输出。随后运行：

```bash
cargo fmt --all -- --check
cargo check -p movie-harbor-api
git diff --check
```

- [ ] **步骤 4：提交**

```bash
git add backend/src/admin_content backend/src/admin_export backend/src/catalog backend/src/genres
git commit -m "docs: explain Rust query and genre invariants"
```

### 任务 4：电影、剧集、季与单集生命周期

**文件：**
- 修改：`backend/src/movies/repository.rs`
- 修改：`backend/src/movies/service.rs`
- 审核：`backend/src/movies/dto.rs`
- 审核：`backend/src/movies/routes.rs`
- 审核：`backend/src/movies/mod.rs`
- 修改：`backend/src/series/repository.rs`
- 修改：`backend/src/series/service.rs`
- 审核：`backend/src/series/dto.rs`
- 审核：`backend/src/series/routes.rs`
- 审核：`backend/src/series/mod.rs`

- [ ] **步骤 1：标记领域状态与并发边界**

电影部分必须解释：

- `find_locked` 与 `persist` 如何结合行锁和 `version` 防止盲目覆盖。
- 草稿更新为何在同一事务内校验题材、替换关联并递增版本。
- 发布校验为何要求受控且可访问的视频，而海报允许为空。
- 状态转换如何保持幂等并由公共状态机更新时间戳。
- 删除为何先暂存媒体、再提交数据库，失败时恢复，提交后同步完成文件删除。

剧集部分必须解释：

- 所有层级写入遵循 `series -> season -> episode` 的全局锁顺序。
- 已发布剧集自身只读但允许新增草稿下级；有已发布单集时季不可改号或删除。
- 单集变更为何同时校验单集版本并递增父剧集版本。
- 父级和子级状态独立，但公开可见性要求两级同时发布。
- 删除季、单集和整剧时如何锁定、暂存媒体、提交事务及失败恢复。
- 发布剧集和发布单集各自的媒体与层级最低要求。

- [ ] **步骤 2：添加中文行注释并转换现有英文注释**

`series/service.rs` 中关于层级锁顺序的现有英文注释必须转换。新增注释示例：

```rust
// 所有层级写操作统一按 series -> season -> episode 加锁，删除和状态转换共享顺序以避免死锁。
```

```rust
// 数据库提交前只暂存文件；事务失败可恢复，提交成功后才执行不可逆的物理删除。
```

- [ ] **步骤 3：验证领域模块**

运行全局差异审计，预期无输出。随后运行：

```bash
cargo fmt --all -- --check
cargo check -p movie-harbor-api
git diff --check
```

- [ ] **步骤 4：提交**

```bash
git add backend/src/movies backend/src/series
git commit -m "docs: explain Rust content lifecycle rules"
```

### 任务 5：媒体 API、受控路径、上传替换与同步删除

**文件：**
- 修改：`backend/src/media/mod.rs`
- 修改：`backend/src/media/path.rs`
- 修改：`backend/src/media/routes.rs`
- 修改：`backend/src/media/removal.rs`
- 修改：`backend/src/media/upload.rs`

- [ ] **步骤 1：梳理跨数据库与文件系统的状态机**

必须覆盖：

- `is_publishable_asset`：数据库记录、用途、受控键和物理文件可访问性共同构成“可发布”。
- `controlled_storage_key`：只接受系统生成的三段键并验证资源类型、分片和文件名，防止路径穿越或错误用途泄露。
- 上传路由：Multipart 只允许一个文件字段，元数据和总大小分别受限，错误映射保持稳定。
- `store_new_asset`、`prepare_attachment`、`commit_attachment`：流式写入与数据库登记之间的恢复标记、持有全局媒体变更锁的范围、提交后注册。
- `replace_before_commit`、`switch_reference`：按电影/剧集/季/单集顺序锁定归属对象，重检父子关系和版本，保证媒体槽位全局独占。
- `stage_old_asset`、`delete_old_asset`：旧文件在数据库切换前可恢复，提交后同步删除并区分 finalize 错误。
- `removal::{stage,finish_delete_transaction,recover}`：删除清单先持久化，事务回滚恢复文件，启动恢复只处理清单中明确登记的文件。

- [ ] **步骤 2：添加中文行注释并翻译英文注释**

`upload.rs` 中关于不可变祖先和全局锁顺序的英文注释必须转换。新增注释示例：

```rust
// 先持久化恢复标记再进入数据库写阶段，使“文件已提升但引用尚未提交”的中断可在启动时收敛。
```

```rust
// 受控键同时校验用途目录和系统文件名，公开 URL 与容器路径都不能接受任意相对路径。
```

- [ ] **步骤 3：验证媒体协调层**

运行全局差异审计，预期无输出。随后运行：

```bash
cargo fmt --all -- --check
cargo check -p movie-harbor-api
git diff --check
```

- [ ] **步骤 4：提交**

```bash
git add backend/src/media/mod.rs backend/src/media/path.rs backend/src/media/routes.rs backend/src/media/removal.rs backend/src/media/upload.rs
git commit -m "docs: explain Rust media mutation workflow"
```

### 任务 6：本地媒体存储与崩溃恢复

**文件：**
- 修改：`backend/src/media/storage.rs`

- [ ] **步骤 1：按存储状态机划分注释区域**

完整阅读 1,500 行文件，分别解释：

- `StoredFile` 和 `PendingCleanup` 的状态转换，以及 Drop 为何只做可恢复清理而不掩盖数据库结果。
- 初始化时创建并验证 `.incoming`、`.quarantine`，为何要求目录独占写权限和私有模式。
- `write_and_promote` 的流式累计、哈希、`sync_all`、内容校验、分层目录创建、原子重命名和目录同步顺序。
- 所有媒体修改共用 `mutations` 锁，避免上传、替换、删除和恢复交错破坏所有权判断。
- 删除操作清单的创建、逐文件暂存、恢复、完成和关闭；每次重命名后的目录同步为何是持久性边界。
- 启动恢复如何区分已发布清单、未发布残留、仍被数据库引用和已无引用的文件。
- 基于已打开目录描述符的相对操作、同名目录身份重检和 `O_NOFOLLOW` 如何抵抗符号链接替换竞态。
- 隔离区 claim 的随机名称、内容哈希和文件身份校验如何避免删除并发替换后的无关文件。
- 存储键、临时文件名、标记文件名和 SHA-256 的严格语法校验为何采用失败关闭。

- [ ] **步骤 2：转换现有英文注释并补充中文技术说明**

文件中所有现有英文注释必须转换，包括 unlink 失败保留标记、持久标记、目录替换攻击、同步临界区和隔离区无关文件保留。注释示例：

```rust
// 重命名成功不等于目录项已经持久化；同步父目录后，断电恢复才能可靠观察到新文件名。
```

```rust
// 后续删除始终相对已打开目录描述符执行，并在操作前重检目录身份，阻断路径解析期间的符号链接替换。
```

- [ ] **步骤 3：验证存储文件只有注释变化**

除全局差异审计外，单独运行：

```bash
git diff --unified=0 9bfb72c -- backend/src/media/storage.rs
cargo fmt --all -- --check
cargo check -p movie-harbor-api
git diff --check
```

人工确认每个增删行均为 `//`，且中文说明与相邻系统调用和错误路径一致。

- [ ] **步骤 4：提交**

```bash
git add backend/src/media/storage.rs
git commit -m "docs: explain Rust media storage recovery"
```

### 任务 7：媒体格式与编解码结构校验

**文件：**
- 修改：`backend/src/media/validation.rs`

- [ ] **步骤 1：按格式解析器确定注释主题**

必须覆盖：

- 元数据校验与内容校验为何分层，并且 MIME/扩展名匹配不能代替实际字节结构验证。
- PNG：签名、chunk 长度、CRC、IHDR/IDAT/IEND 顺序和解码器复核。
- JPEG：marker、segment 长度、扫描数据与熵编码区 marker 处理。
- WebP：RIFF 容器长度、VP8/VP8L/VP8X 必要 chunk 和解码器复核。
- MP4：递归 box 边界与深度/数量上限、track handler、sample table、chunk offset、`mdat` 范围和时长推导。
- H.264/AVCC：NAL 长度、SPS/PPS 完整性、高 Profile 扩展、解析前的尺寸和 slice-group 资源上限。
- HEVC/HVCC：VPS/SPS/PPS 完整性、NAL 类型一致性、保留位和长度前缀限制。
- WebM/EBML：可变长整数、元素深度/数量/长度上限、轨道类型和 Codec ID。
- 所有解析失败均返回拒绝而非 panic；上限用于防止恶意文件触发高内存或高 CPU 消耗。

- [ ] **步骤 2：添加克制的中文行注释并转换测试内英文注释**

只在解析阶段入口、非直观边界计算和安全上限前注释，不为每个字节读取加注释。示例：

```rust
// 先验证 box 完整落在父边界内，再递归解析；深度和数量上限用于约束恶意嵌套造成的资源消耗。
```

```rust
// 在交给 H.264 解析器前限制 SPS 尺寸和 PPS slice-group 参数，避免合法语法被放大成不可控分配。
```

`#[cfg(test)]` 中若存在英文行注释，只翻译原注释，不新增逐测试说明。

- [ ] **步骤 3：验证格式解析文件只有注释变化**

```bash
git diff --unified=0 9bfb72c -- backend/src/media/validation.rs
cargo fmt --all -- --check
cargo check -p movie-harbor-api
git diff --check
```

人工确认差异只含 `//`，并重点核对位运算、长度计算、容器边界与注释描述没有矛盾。

- [ ] **步骤 4：提交**

```bash
git add backend/src/media/validation.rs
git commit -m "docs: explain Rust media format validation"
```

### 任务 8：简单模块审计、全局一致性与完整验证

**文件：**
- 审核：`backend/src/entities/*.rs`
- 审核：`backend/src/**/dto.rs`
- 审核：`backend/src/**/mod.rs`
- 审核：`backend/src/**/*routes.rs`
- 审核：`backend/src/error.rs`
- 审核：`backend/src/lib.rs`
- 审核：`backend/src/main.rs`

- [ ] **步骤 1：审计未修改文件是否确实只含简单代码**

运行：

```bash
rg --files backend/src -g '*.rs' | sort
git diff --name-only 9bfb72c -- backend/src | sort
```

逐个核对未出现在差异中的文件。SeaORM 实体、纯 DTO、只声明模块的 `mod.rs` 和简单路由转发可保持无注释；若存在事务、安全、生命周期或非直观错误映射，则回到对应任务标准补充中文行注释。

- [ ] **步骤 2：审计原有英文注释全部完成转换**

先列出基线中的英文注释：

```bash
git grep -n -E '^[[:space:]]*//.*[A-Za-z]' 9bfb72c -- backend/src
```

逐条检查当前文件中的对应位置已经使用中文表达。允许中文注释中保留必要技术词，但不允许整句英文说明残留。再运行：

```bash
rg -n --pcre2 '^\s*//(?![/!])(?=[^\p{Han}\n]*[A-Za-z])[^\p{Han}\n]*$' backend/src -g '*.rs'
```

预期：没有纯英文 `//` 注释；若命中只包含代码标识的短标签，改写成完整中文说明或删除无价值标签。

- [ ] **步骤 3：审计注释质量和仅注释差异**

运行全局差异审计，预期无输出。随后逐文件阅读：

```bash
git diff --stat 9bfb72c -- backend/src
git diff --word-diff=plain 9bfb72c -- backend/src
```

确认：

- 注释解释原因、约束或机制，不复述语句。
- 没有超过必要长度的大段教程。
- 没有声称实现不存在的保证。
- 同一概念使用一致术语：草稿、已发布、已归档、受控存储键、一致快照、乐观锁、暂存、恢复、原子提升。

- [ ] **步骤 4：运行完整验证**

```bash
docker compose -f docker-compose.test.yml up -d postgres
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
git diff --check
```

预期：所有命令退出码为 0；Rust 测试 190 项通过；差异审计没有非注释源码行。

- [ ] **步骤 5：提交最终审计中补充的注释**

若步骤 1–3 产生了新注释：

```bash
git add backend/src
git commit -m "docs: complete Rust Chinese comment audit"
```

若没有新差异，不创建空提交。

- [ ] **步骤 6：请求最终代码审查**

使用 superpowers:requesting-code-review 对照已确认规格审查：覆盖范围、中文统一、业务与技术解释、注释准确性、注释密度、仅注释差异和完整验证证据。任何发现必须在合并前修复或明确裁定。
