# 宿主机数据目录映射实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将生产 Compose 的 PostgreSQL 与媒体数据改为可配置的宿主机绑定目录，并为默认值、共享关系和只读边界建立回归测试。

**架构：** Compose 通过 `DATABASE_HOST_DIR` 和 `MEDIA_HOST_DIR` 接受宿主机路径，未配置时分别解析到项目内的 `./data/postgres` 与 `./data/media`。PostgreSQL 独占数据库路径；`media-init` 和 API 读写同一媒体路径，Caddy 只读同一路径。Node 测试执行真实的 `docker compose config --format json`，断言最终解析配置而非文本实现细节。

**技术栈：** Docker Compose v2、Node.js 内置测试运行器、Git ignore 规则。

---

## 文件结构

- 创建：`tests/compose-storage.test.mjs`，验证 Compose 解析后的宿主机存储挂载契约。
- 修改：`docker-compose.yml`，将两个命名卷替换为 bind mount。
- 修改：`.env.example`，公开两个可覆盖的宿主机目录变量。
- 修改：`.gitignore`，阻止默认 `data/` 目录进入版本库。

### 任务 1：宿主机数据库和媒体绑定挂载

**文件：**
- 创建：`tests/compose-storage.test.mjs`
- 修改：`docker-compose.yml:1-110`
- 修改：`.env.example:1-12`
- 修改：`.gitignore:1-14`

- [ ] **步骤 1：编写失败的 Compose 存储契约测试**

```javascript
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function composeConfig(environment = {}) {
  return JSON.parse(
    execFileSync(
      "docker",
      ["compose", "--env-file", ".env.example", "config", "--format", "json"],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, ...environment },
      },
    ),
  );
}

function mountAt(config, service, target) {
  return config.services[service].volumes.find((mount) => mount.target === target);
}

test("defaults PostgreSQL storage to a host data directory", () => {
  const config = composeConfig();
  const mount = mountAt(config, "postgres", "/var/lib/postgresql/data");

  assert.equal(mount.type, "bind");
  assert.equal(mount.source, path.join(projectRoot, "data/postgres"));
});

test("shares one writable media directory with read-only serving", () => {
  const config = composeConfig();
  const expected = path.join(projectRoot, "data/media");

  assert.equal(mountAt(config, "media-init", "/media").source, expected);
  assert.equal(mountAt(config, "api", "/media").source, expected);
  assert.equal(mountAt(config, "caddy", "/srv/media").source, expected);
  assert.equal(mountAt(config, "caddy", "/srv/media").read_only, true);
});

test("host storage directories can be overridden", () => {
  const config = composeConfig({
    DATABASE_HOST_DIR: "/tmp/movie-harbor-db-override",
    MEDIA_HOST_DIR: "/tmp/movie-harbor-media-override",
  });

  assert.equal(
    mountAt(config, "postgres", "/var/lib/postgresql/data").source,
    "/tmp/movie-harbor-db-override",
  );
  assert.equal(
    mountAt(config, "api", "/media").source,
    "/tmp/movie-harbor-media-override",
  );
});
```

- [ ] **步骤 2：运行测试并确认因仍使用命名卷而失败**

运行：`node --test tests/compose-storage.test.mjs`

预期：FAIL；第一个断言显示实际挂载类型为 `volume`，不是 `bind`。

- [ ] **步骤 3：实现最小 Compose 和配置变更**

在 `.env.example` 增加：

```dotenv
DATABASE_HOST_DIR=./data/postgres
MEDIA_HOST_DIR=./data/media
```

将 PostgreSQL 挂载改为：

```yaml
    volumes:
      - type: bind
        source: ${DATABASE_HOST_DIR:-./data/postgres}
        target: /var/lib/postgresql/data
        bind:
          create_host_path: true
```

将 `media-init` 和 `api` 的媒体挂载分别改为同结构的 `type: bind`、`source: ${MEDIA_HOST_DIR:-./data/media}`、目标 `/media`，并允许创建宿主机目录。将 Caddy 的媒体挂载目标改为 `/srv/media`，增加 `read_only: true`。删除顶层 `database_data` 和 `media_data` 声明。

在 `.gitignore` 增加：

```gitignore
/data/
```

- [ ] **步骤 4：运行存储契约测试并确认通过**

运行：`node --test tests/compose-storage.test.mjs`

预期：3 项测试全部 PASS。

- [ ] **步骤 5：执行回归验证**

运行：

```bash
docker compose --env-file .env.example config --quiet
node --test
git diff --check
```

预期：全部退出码为 0；Node 顶层测试包含新建的 3 项 Compose 存储测试。

- [ ] **步骤 6：提交交付物**

```bash
git add tests/compose-storage.test.mjs docker-compose.yml .env.example .gitignore docs/superpowers/plans/2026-09-12-host-data-bind-mounts-implementation.md
git commit -m "feat: bind application data to host directories"
```
