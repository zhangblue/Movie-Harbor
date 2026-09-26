# README 文档拆分实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将根 README 收敛为 Movie Harbor 的工程介绍与文档导航，把操作说明拆分为 5 份主题指南，并新增一份可追溯到当前迁移实现的数据库表设计指南。

**架构：** `README.md` 只负责项目定位、能力概览、范围和导航；`docs/guides/` 按部署、半离线发布、内容迁移、媒体与备份、开发、数据库结构分别承载详细说明。文档契约测试负责检查入口链接、指南回链和关键数据库对象，现有部署边界测试改为读取部署指南。

**技术栈：** Markdown、Node.js 内置测试、Rust/SeaORM/PostgreSQL 迁移源码。

---

## 文件结构

- 修改：`README.md`，保留工程介绍、范围和文档导航。
- 创建：`docs/guides/deployment.md`，记录生产部署、访问模式、环境变量、代理信任、上传格式和容量。
- 创建：`docs/guides/offline-package.md`，记录半离线包构建、校验、部署和升级。
- 创建：`docs/guides/content-transfer.md`，记录管理媒体路径、JSON 导出与可恢复导入。
- 创建：`docs/guides/media-and-backup.md`，记录媒体安全、所有权、迁移 v5 和一致备份恢复。
- 创建：`docs/guides/development.md`，记录开发环境、自动化验收、UI Demo 和目录结构。
- 创建：`docs/guides/database-schema.md`，记录当前数据库对象、字段、约束、索引、触发器和关系。
- 创建：`tests/documentation.test.mjs`，检查文档入口、回链与数据库结构说明的最低契约。
- 修改：`tests/compose-storage.test.mjs`，让部署边界断言读取新的部署指南。

### 任务 1：记录当前数据库表设计

**文件：**

- 创建：`tests/documentation.test.mjs`
- 创建：`docs/guides/database-schema.md`

- [ ] **步骤 1：编写失败的数据库文档契约测试**

创建 `tests/documentation.test.mjs`，读取数据库指南，并要求 11 张当前表、v5 所有权触发器和已移除的 `file_cleanup_job` 都有明确说明：

```javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("database guide describes the current migrated schema", () => {
  const guide = readFileSync(
    new URL("../docs/guides/database-schema.md", import.meta.url),
    "utf8",
  );
  const tables = [
    "admin_user",
    "admin_session",
    "genre",
    "media_asset",
    "movie",
    "series",
    "season",
    "episode",
    "movie_genre",
    "series_genre",
    "media_asset_ownership",
  ];

  for (const table of tables) {
    assert.match(guide, new RegExp(`\\b${table}\\b`));
  }
  assert.match(guide, /file_cleanup_job[^\n]*(移除|删除)/);
  assert.match(guide, /sync_movie_media_ownership/);
  assert.match(guide, /sync_series_media_ownership/);
  assert.match(guide, /sync_episode_media_ownership/);
  assert.match(guide, /唯一事实来源/);
});
```

- [ ] **步骤 2：运行测试并确认因指南不存在而失败**

运行：`node --test tests/documentation.test.mjs`

预期：FAIL，错误包含 `ENOENT` 和 `docs/guides/database-schema.md`。

- [ ] **步骤 3：编写数据库表设计指南**

创建 `docs/guides/database-schema.md`，并包含以下结构：

```markdown
# 数据库表设计

[返回项目 README](../../README.md)

> 本文描述当前迁移全部执行后的数据库结构；`backend/migration/src/` 是唯一事实来源。

## 关系概览
## 认证与会话
### `admin_user`
### `admin_session`
## 内容与题材
### `genre`
### `movie`
### `series`
### `season`
### `episode`
### `movie_genre`
### `series_genre`
## 媒体
### `media_asset`
### `media_asset_ownership`
## 索引与查询优化
## 所有权触发器
## 迁移后的变化
```

逐表使用字段表格记录字段、PostgreSQL 类型、是否为空、默认值与约束；根据 `m20260911_000001_core_schema.rs` 到 `m20260912_000005_media_ownership.rs` 的最终结果说明：

- `episode.synopsis` 已由 v4 删除。
- `file_cleanup_job` 已由 v5 删除，不属于当前结构。
- `media_asset_ownership` 由 v5 新增，通过 3 组同步函数和 6 个触发器维护。
- `movie`、`series`、`episode` 的状态、版本和发布时间字段含义一致，但 `season` 没有独立生命周期。
- 题材关联表使用复合主键；季号和集号使用作用域内唯一约束。
- 公共目录和搜索索引包含部分 B-tree 索引及 `pg_trgm` GIN 索引。

- [ ] **步骤 4：运行数据库文档测试**

运行：`node --test tests/documentation.test.mjs`

预期：PASS，1 个测试通过。

- [ ] **步骤 5：检查排版与提交**

运行：`git diff --check -- docs/guides/database-schema.md tests/documentation.test.mjs`

预期：退出码为 0。

```bash
git add docs/guides/database-schema.md tests/documentation.test.mjs
git commit -m "docs: 记录当前数据库表设计"
```

### 任务 2：拆分 README 并建立文档导航

**文件：**

- 修改：`README.md`
- 创建：`docs/guides/deployment.md`
- 创建：`docs/guides/offline-package.md`
- 创建：`docs/guides/content-transfer.md`
- 创建：`docs/guides/media-and-backup.md`
- 创建：`docs/guides/development.md`
- 修改：`tests/documentation.test.mjs`
- 修改：`tests/compose-storage.test.mjs`

- [ ] **步骤 1：让部署边界测试指向新指南并确认失败**

将 `tests/compose-storage.test.mjs` 中读取根 README 的测试改名为 `deployment guide explains the local, trusted LAN, and HTTPS deployment boundaries`，并把读取路径改为：

```javascript
const deploymentGuide = readFileSync(
  path.join(projectRoot, "docs/guides/deployment.md"),
  "utf8",
);
```

保留原有 8 项安全边界断言，只把断言对象从 `readme` 改为 `deploymentGuide`。

运行：`node --test tests/compose-storage.test.mjs`

预期：FAIL，错误包含 `ENOENT` 和 `docs/guides/deployment.md`。

- [ ] **步骤 2：扩展入口与回链契约测试**

在 `tests/documentation.test.mjs` 增加测试，要求 README 链接 6 份指南，并要求每份指南都回链 `../../README.md`：

```javascript
test("README links every guide and every guide links back", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const guides = [
    "deployment.md",
    "offline-package.md",
    "content-transfer.md",
    "media-and-backup.md",
    "development.md",
    "database-schema.md",
  ];

  for (const name of guides) {
    assert.match(readme, new RegExp(`docs/guides/${name.replace(".", "\\.")}`));
    const guide = readFileSync(
      new URL(`../docs/guides/${name}`, import.meta.url),
      "utf8",
    );
    assert.match(guide, /\[返回项目 README\]\(\.\.\/\.\.\/README\.md\)/);
  }
});
```

运行：`node --test tests/documentation.test.mjs`

预期：FAIL，README 尚未包含指南入口，且 5 份迁移指南尚不存在。

- [ ] **步骤 3：迁移内容并重写 README**

按照已确认规格创建 5 份指南：

- `deployment.md` 接收原“生产部署”和“上传格式与容量”，保留全部命令、环境变量表和本机/可信局域网/HTTPS 安全边界。
- `offline-package.md` 接收原“半离线发布包”，保留双平台、联网依赖、构建、校验、目标机部署和升级说明。
- `content-transfer.md` 接收原“管理媒体路径与内容导出”及“从 JSON 导入内容”，保留可恢复导入和跨服务窗口警告。
- `media-and-backup.md` 接收原“媒体目录安全边界”“升级到数据库迁移 v5”和“一致备份与恢复”。
- `development.md` 接收原“开发与验收”“查看 UI Demo”和“目录结构”。

每份指南第一段后添加 `[返回项目 README](../../README.md)`。涉及数据目录和升级的指南应使用相对链接互相引用，不复制产生第二份事实来源。

重写 `README.md`，只保留下列二级章节：

```markdown
## 项目简介
## 当前状态
## 核心设计
## 技术栈
## 使用与运维文档
## 开发文档
## 产品设计与实现记录
## 首版不包含
```

“使用与运维文档”链接部署、半离线发布、内容迁移、媒体与备份；“开发文档”链接开发指南和数据库表设计；“产品设计与实现记录”保留原核心规格、主计划、协作约定和关键增量入口。

- [ ] **步骤 4：运行文档与部署契约测试**

运行：`node --test tests/documentation.test.mjs tests/compose-storage.test.mjs`

预期：全部测试通过；部署边界断言从新指南读取，6 份指南均可从 README 到达并回链。

- [ ] **步骤 5：验证内容没有丢失**

运行：

```bash
rg -n 'ALLOW_INSECURE_LAN_HTTP|TRUST_PROXY_SECRET|MAX_UPLOAD_BYTES|VIDEO_MIME_ALLOWLIST' docs/guides/deployment.md
rg -n 'linux/arm64|linux/amd64|postgres:17-alpine|caddy:2.10-alpine|alpine:3.22' docs/guides/offline-package.md
rg -n 'import:content|movie-harbor-import-progress|跨服务窗口|SKIP' docs/guides/content-transfer.md
rg -n '0700|10001|file_cleanup_job|pg_dump|一致备份' docs/guides/media-and-backup.md
rg -n 'cargo clippy|npm test --workspaces|test:e2e|E2E_KEEP|http.server' docs/guides/development.md
```

预期：每条命令均显示对应指南中的完整事实；README 中不再出现这些长篇操作说明。

- [ ] **步骤 6：运行项目级相关验证**

运行：`node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs`

运行：`git diff --check`

预期：Node 契约测试全部通过，Git 空白检查退出码为 0。

- [ ] **步骤 7：人工审查文档边界并提交**

检查：

- README 中没有生产命令、环境变量明细、备份命令或测试清理步骤。
- 原 README 的全部操作性段落在 5 份迁移指南中都有唯一归属。
- 6 份指南标题清晰，代码围栏闭合，相对链接可解析。
- 数据库指南与当前迁移的最终结构一致。

```bash
git add README.md docs/guides tests/documentation.test.mjs tests/compose-storage.test.mjs
git commit -m "docs: 拆分 README 使用指南"
```

## 完成定义

- 根 README 聚焦工程介绍、范围和导航。
- 6 份指南都可从 README 到达，并能返回 README。
- 原 README 中的部署、迁移、备份、发布与开发事实未丢失。
- 数据库指南覆盖当前 11 张表、索引、触发器和已被迁移移除的旧对象。
- 部署边界测试改读部署指南，文档契约和项目级 Node 测试通过。
- `git diff --check` 通过。
