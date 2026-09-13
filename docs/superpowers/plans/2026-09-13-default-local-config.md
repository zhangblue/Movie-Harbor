# Movie Harbor 本机默认配置一致性实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。Task 1 和 Task 2 必须由两个不同的全新子代理按顺序执行；Task 1 完成验证、审查和独立提交后，才可创建执行 Task 2 的新子代理，不得复用 Task 1 的代理。

**目标：** 把仓库开箱默认场景统一为 `http://localhost:8080`、`COOKIE_SECURE=false` 和 50 GiB 单文件上传上限，同时保留后端现有来源校验与正式 HTTPS 安全边界。

**架构：** 根 `.env.example`、生产 Compose 和半离线 Compose 向后端传入同一组三项字符串默认值；Node 契约测试同时锁定示例文件、生产回退表达式、真实 Compose 解析结果、显式环境覆盖和离线模板。后端代码及上传行为保持不变，README 单独解释本机默认与正式 HTTPS 部署的边界。

**技术栈：** Docker Compose v2、Node.js 内置测试运行器、Node.js 标准库、Rust/Cargo 配置单元测试、Markdown。

---

## 执行编排与边界

- 使用 `superpowers:subagent-driven-development` 执行；先创建只负责 Task 1 的全新子代理，集成者读取其 RED/GREEN 输出并审查提交，再创建另一个只负责 Task 2 的全新子代理。
- Task 1 只修改配置、半离线模板和相应 Node 测试；Task 2 只修改 `README.md`。两个提交的文件集合必须互不重叠。
- 不修改 `backend/src/config.rs` 或其他后端行为；后端现有单元测试只作为回归验证运行。
- 不增加公网或局域网明文 HTTP 支持，不增加其他发布平台，不改变上传 MIME、流式写入、临时文件、替换、删除或恢复行为。
- 两个实现 Task 各自形成可测试、可审查的独立提交；文末最终集成核验不是第三个实现 Task，不修改文件、不产生额外提交。

## 文件结构

- 修改 `.env.example`：显式声明三项本机默认值，继续保留必须替换的密码和代理秘密占位值。
- 修改 `docker-compose.yml`：让 API 服务的三项环境变量具有与示例一致的 Compose 回退，同时保留显式环境覆盖。
- 修改 `tools/offline-package.mjs`：让 `renderCompose` 输出与生产 Compose 一致的三项回退，不改变镜像、平台、归档和包内安全说明。
- 修改 `tests/compose-storage.test.mjs`：解析根示例、锁定生产回退表达式，并用真实 `docker compose config --format json` 验证最终值和显式覆盖；保留存储挂载契约。
- 修改 `tests/offline-package.test.mjs`：锁定 `renderCompose("test-v1")` 中的精确回退字符串；保留镜像白名单、归档白名单、秘密排除和 HTTPS 指引测试。
- 修改 `README.md`：说明默认 localhost HTTP、正式 HTTPS 配置和 50 GiB 单文件上限。

### 任务 1：统一配置默认值并建立契约测试

**执行者：** 为本 Task 创建一个全新子代理；该代理不得修改 `README.md`，完成本 Task 的提交后结束。

**文件：**
- 修改：`.env.example:9-12`
- 修改：`docker-compose.yml:53-57`
- 修改：`tools/offline-package.mjs:244-248`
- 测试：`tests/compose-storage.test.mjs:1-59`
- 测试：`tests/offline-package.test.mjs:355-451`

- [ ] **步骤 1：先把生产配置契约改成新期望，不改任何配置或模板**

在 `tests/compose-storage.test.mjs` 增加根示例解析、生产回退文本和真实 Compose 最终环境断言。读取配置文件时保留字符串类型，避免把 `false` 或大整数错误地转成布尔值/JavaScript `number`：

```javascript
import { readFileSync } from "node:fs";

const expectedDefaults = {
  PUBLIC_ORIGIN: "http://localhost:8080",
  COOKIE_SECURE: "false",
  MAX_UPLOAD_BYTES: "53687091200",
};

function parseEnvExample() {
  return Object.fromEntries(
    readFileSync(path.join(projectRoot, ".env.example"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

test("declares the local deployment defaults in the root environment example", () => {
  const example = parseEnvExample();
  for (const [name, value] of Object.entries(expectedDefaults)) {
    assert.equal(example[name], value);
  }
});

test("production Compose owns the same fallback expressions", () => {
  const source = readFileSync(path.join(projectRoot, "docker-compose.yml"), "utf8");
  assert.match(source, /PUBLIC_ORIGIN: \$\{PUBLIC_ORIGIN:-http:\/\/localhost:8080\}/);
  assert.match(source, /COOKIE_SECURE: \$\{COOKIE_SECURE:-false\}/);
  assert.match(source, /MAX_UPLOAD_BYTES: \$\{MAX_UPLOAD_BYTES:-53687091200\}/);
});

test("production Compose resolves the local defaults for the API", () => {
  const environment = composeConfig().services.api.environment;
  for (const [name, value] of Object.entries(expectedDefaults)) {
    assert.equal(environment[name], value);
  }
});

test("explicit environment values override the production defaults", () => {
  const environment = composeConfig({
    PUBLIC_ORIGIN: "https://media.example.com",
    COOKIE_SECURE: "true",
    MAX_UPLOAD_BYTES: "1073741824",
  }).services.api.environment;
  assert.equal(environment.PUBLIC_ORIGIN, "https://media.example.com");
  assert.equal(environment.COOKIE_SECURE, "true");
  assert.equal(environment.MAX_UPLOAD_BYTES, "1073741824");
});
```

在 `tests/offline-package.test.mjs` 的生产拓扑深比较中改成新期望，并增加一个聚焦测试，直接检查离线模板保留 Compose 回退表达式而不是提前解析值：

```javascript
test("renders the same local configuration fallbacks in the offline Compose", () => {
  const environment = JSON.parse(renderCompose(VERSION)).services.api.environment;
  assert.deepEqual(
    {
      PUBLIC_ORIGIN: environment.PUBLIC_ORIGIN,
      COOKIE_SECURE: environment.COOKIE_SECURE,
      MAX_UPLOAD_BYTES: environment.MAX_UPLOAD_BYTES,
    },
    {
      PUBLIC_ORIGIN: "${PUBLIC_ORIGIN:-http://localhost:8080}",
      COOKIE_SECURE: "${COOKIE_SECURE:-false}",
      MAX_UPLOAD_BYTES: "${MAX_UPLOAD_BYTES:-53687091200}",
    },
  );
});
```

同步把现有 `compose.services.api` 深比较中的三项期望改为上述精确字符串；其他服务、镜像、挂载、健康检查和 `renderBundleReadme` 断言一字不动。

- [ ] **步骤 2：运行 RED，确认失败只来自旧默认值**

运行：

```bash
node --test tests/compose-storage.test.mjs tests/offline-package.test.mjs
```

预期：命令退出码为 1；新增/更新断言报告当前根示例实际为 `https://media.example.com`、`true`、`5368709120`，生产 Compose 回退仍为必填来源、`true`、`5368709120`，离线模板仍为相同旧表达式。现有宿主机挂载、三自研镜像、归档白名单、秘密排除和 HTTPS 指引测试继续通过；若失败来自 Docker 不可用、JavaScript 语法或其他无关契约，先修正测试环境或测试本身，不得进入 GREEN。

把该次命令及上述预期差异保留在子代理交付说明中，作为可复现 RED 证据。

- [ ] **步骤 3：写入最少配置与模板实现**

把 `.env.example` 的三项显式值改为：

```dotenv
PUBLIC_ORIGIN=http://localhost:8080
COOKIE_SECURE=false
MAX_UPLOAD_BYTES=53687091200
```

把 `docker-compose.yml` 的 API 环境改为：

```yaml
      COOKIE_SECURE: ${COOKIE_SECURE:-false}
      PUBLIC_ORIGIN: ${PUBLIC_ORIGIN:-http://localhost:8080}
      MAX_UPLOAD_BYTES: ${MAX_UPLOAD_BYTES:-53687091200}
```

把 `tools/offline-package.mjs` 的 `renderCompose` API 环境改为：

```javascript
COOKIE_SECURE: "${COOKIE_SECURE:-false}",
PUBLIC_ORIGIN: "${PUBLIC_ORIGIN:-http://localhost:8080}",
MAX_UPLOAD_BYTES: "${MAX_UPLOAD_BYTES:-53687091200}",
```

不要改 `renderBundleReadme`、`backend/src/config.rs`、上传策略、镜像列表、`linux/arm64` 限制、归档结构或秘密字段。

- [ ] **步骤 4：运行 GREEN 和后端安全边界验证**

运行：

```bash
docker compose --env-file .env.example config --quiet
node --test tests/compose-storage.test.mjs tests/offline-package.test.mjs
node --check tools/offline-package.mjs
cargo test -p movie-harbor-api config::tests::loopback_development_can_disable_secure_cookies -- --exact
cargo test -p movie-harbor-api config::tests::insecure_cookies_are_rejected_for_non_loopback_public_origins -- --exact
git diff --check
```

预期：全部命令退出码为 0；两个 Node 文件全部 PASS；后端精确单测各报告 1 项通过，证明现有校验继续接受 localhost/环回 HTTP 配合 `COOKIE_SECURE=false`，并继续拒绝普通域名、局域网 IP、`0.0.0.0` 和公网 IPv6 配合不安全 Cookie。精确端口 `8080` 和 50 GiB 字节值由根示例、真实生产 Compose 解析与离线模板断言共同验证，后端逻辑没有修改。

- [ ] **步骤 5：执行 Task 1 事实一致性检查**

运行：

```bash
rg -n 'PUBLIC_ORIGIN|COOKIE_SECURE|MAX_UPLOAD_BYTES' .env.example docker-compose.yml tools/offline-package.mjs tests/compose-storage.test.mjs tests/offline-package.test.mjs
rg -n --pcre2 '5368709120(?!0)|\$\{COOKIE_SECURE:-true\}|PUBLIC_ORIGIN:\s*["\x27]?\$\{PUBLIC_ORIGIN:\?' .env.example docker-compose.yml tools/offline-package.mjs tests/compose-storage.test.mjs tests/offline-package.test.mjs
git status --short
```

预期：第一条命令中所有目标默认值都收敛为字符串 `http://localhost:8080`、`false`、`53687091200`，仅显式覆盖测试保留 `https://media.example.com`、`true` 和较小的测试容量；第二条命令无输出；状态只包含本 Task 列出的五个文件，不含 README 或后端文件。

- [ ] **步骤 6：独立提交 Task 1**

```bash
git add .env.example docker-compose.yml tools/offline-package.mjs tests/compose-storage.test.mjs tests/offline-package.test.mjs
git commit -m "fix: 统一本机部署默认配置"
```

预期：提交成功；`git show --stat --oneline HEAD` 只列出上述五个文件。集成者审查 RED/GREEN 证据与文件范围后，结束该子代理，再创建 Task 2 的全新子代理。

### 任务 2：更新 README 的本机默认值与正式部署说明

**执行者：** Task 1 已审查并提交后，为本 Task 创建另一个全新子代理；该代理只允许修改 `README.md`。

**文件：**
- 修改：`README.md:52-69`
- 修改：`README.md:97-109`
- 修改：`README.md:115-120`

- [ ] **步骤 1：核对 Task 1 已提交且 README 是唯一允许修改的文件**

运行：

```bash
git status --short
git show --stat --oneline HEAD
rg -n 'http://服务器地址:8080|http://localhost:8080|PUBLIC_ORIGIN|COOKIE_SECURE|5 GiB|50 GiB|5368709120|53687091200' README.md
```

预期：工作树干净；HEAD 是 Task 1 的独立提交；README 仍包含旧的“服务器地址”默认入口和“5 GiB”，这只是文档基线，不修改配置、工具或测试。

- [ ] **步骤 2：只修改 README 中的三处说明**

把生产部署入口说明改为明确的本机默认，并说明端口/主机变化必须同步更新来源：

```markdown
默认本机入口是 `http://localhost:8080`。如果修改 `APP_PORT`，或实际使用其他主机名、IP、端口或协议访问，必须把 `PUBLIC_ORIGIN` 同步改为浏览器实际使用的完整来源。公开站位于 `/`，管理后台位于 `/admin/`，API 位于 `/api/`，媒体位于 `/media/`。PostgreSQL 不暴露宿主端口。
```

把安全说明改为同时陈述开箱值和正式边界：

```markdown
示例配置显式使用 `PUBLIC_ORIGIN=http://localhost:8080` 和 `COOKIE_SECURE=false`，只适用于通过 `localhost` 或环回地址进行本机 HTTP 访问；如果改用 `http://127.0.0.1:8080`，也必须把 `PUBLIC_ORIGIN` 改为该实际来源。使用域名、局域网地址或公网地址的正式部署必须配置实际的 `https://` 来源、设置 `COOKIE_SECURE=true`，并由部署者用域名、上游反向代理或自己的 TLS 终止层启用 HTTPS。不要在公网或局域网以明文 HTTP 提供管理后台。
```

在半离线部署命令注释中说明 localhost 默认可以直接使用，服务器地址或 HTTPS 入口必须显式调整 `PUBLIC_ORIGIN`、`COOKIE_SECURE` 和 `APP_PORT`；不要把包内 Caddy 描述成自带正式 TLS。

把容量说明改为：

```markdown
- `MAX_UPLOAD_BYTES` 是单文件上限，默认值为 50 GiB（`53687091200` 字节），不是媒体库总容量或推荐文件大小。规划磁盘时需同时预留正式媒体、上传临时文件和替换期间新旧文件的空间。
```

保留密码、管理员凭据、`TRUST_PROXY_SECRET`、宿主机目录、半离线联网和 `linux/arm64` 说明；不得修改其他文件。

- [ ] **步骤 3：执行 README 事实一致性和矛盾检查**

运行：

```bash
rg -n 'http://localhost:8080|PUBLIC_ORIGIN|COOKIE_SECURE=false|COOKIE_SECURE=true|50 GiB|53687091200|单文件上限|磁盘' README.md
rg -n --pcre2 'http://服务器地址:8080|5 GiB|5368709120(?!0)|公网[^\n]*COOKIE_SECURE=false|局域网[^\n]*COOKIE_SECURE=false' README.md
git diff --check
git status --short
```

预期：第一条命令能够同时定位本机默认、正式 HTTPS/Secure Cookie 和 50 GiB 单文件上限/磁盘规划说明；第二条命令无输出；`git diff --check` 退出码为 0；状态只有 `README.md`。

- [ ] **步骤 4：独立提交 Task 2**

```bash
git add README.md
git commit -m "docs: 更新本机默认配置说明"
```

预期：提交成功；`git show --stat --oneline HEAD` 只列出 `README.md`。

## 最终集成核验（不属于实现 Task）

两个子代理均已结束、两个独立提交均已审查后，由集成者执行以下只读/验证步骤，不修改文件、不创建第三个实现提交：

```bash
git status --short
git diff-tree --no-commit-id --name-only -r HEAD
git diff-tree --no-commit-id --name-only -r HEAD~1
docker compose --env-file .env.example config --quiet
node --test tests/compose-storage.test.mjs tests/offline-package.test.mjs
node --check tools/offline-package.mjs
cargo test -p movie-harbor-api config::tests::loopback_development_can_disable_secure_cookies -- --exact
cargo test -p movie-harbor-api config::tests::insecure_cookies_are_rejected_for_non_loopback_public_origins -- --exact
rg -n 'http://localhost:8080|COOKIE_SECURE|53687091200|50 GiB' .env.example docker-compose.yml tools/offline-package.mjs tests/compose-storage.test.mjs tests/offline-package.test.mjs README.md
rg -n --pcre2 '5368709120(?!0)|\$\{COOKIE_SECURE:-true\}|PUBLIC_ORIGIN:\s*["\x27]?\$\{PUBLIC_ORIGIN:\?|http://服务器地址:8080|5 GiB' .env.example docker-compose.yml tools/offline-package.mjs tests/compose-storage.test.mjs tests/offline-package.test.mjs README.md
git diff --check HEAD~2..HEAD
```

预期：工作树干净；HEAD 提交只含 `README.md`，HEAD~1 提交只含 Task 1 的五个文件；Compose、Node、语法、两个后端安全边界测试和 diff 检查全部退出码为 0；正向事实查询显示三项精确默认值在实现、测试和文档中一致；旧 5 GiB、旧 Secure Cookie 回退、必填来源回退及旧服务器地址默认描述查询无输出。

## 完成定义

- 根示例、生产 Compose 和半离线 Compose 对三项默认值只有一种解释，且显式环境覆盖仍生效。
- 后端继续要求直接运行时显式配置，并保持“环回 HTTP 可使用不安全 Cookie、非环回必须 Secure Cookie”的现有校验。
- README 将 50 GiB 明确限定为单文件上限，并保留临时文件和替换期间的磁盘容量规划提示。
- README 不把 localhost 默认扩大成公网或局域网明文 HTTP，不声称项目内 Caddy 自动提供正式 HTTPS。
- 半离线平台、联网、镜像、归档、秘密、数据目录和上传行为均未改变。
- Task 1 与 Task 2 由不同全新子代理顺序完成，各自独立提交且文件集合不重叠。
