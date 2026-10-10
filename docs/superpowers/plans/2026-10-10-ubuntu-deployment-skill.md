# Ubuntu 部署项目技能实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Movie Harbor 的 Ubuntu 半离线部署流程从根 `AGENTS.md` 迁移为按需发现的项目级技能，并移除所有旧的重复部署指令。

**架构：** `.agents/skills/deploy-movie-harbor-ubuntu/SKILL.md` 负责精确触发、授权边界和资料路由，`references/runbook.md` 承载完整线性流程，`agents/openai.yaml` 提供界面元数据。根协作指令不再保存具体部署步骤；Node 文档契约测试和技能校验器共同保护结构、链接与去重约束。

**技术栈：** Markdown、YAML、Node.js 内置测试运行器、Codex skill-creator 校验器、Git。

---

## 文件结构

- 创建：`.agents/skills/deploy-movie-harbor-ubuntu/SKILL.md` — 技能触发条件、权限边界和 runbook 路由。
- 创建：`.agents/skills/deploy-movie-harbor-ubuntu/references/runbook.md` — 完整部署、验收、失败与回滚流程。
- 创建：`.agents/skills/deploy-movie-harbor-ubuntu/agents/openai.yaml` — 项目技能界面元数据。
- 修改：`tests/documentation.test.mjs` — 验证项目技能文件、内部链接和 AGENTS 去重约束。
- 修改：`AGENTS.md` — 删除 Ubuntu 部署章节及旧设计/计划索引。
- 删除：`docs/superpowers/plans/2026-10-10-ubuntu-offline-deployment-runbook.md` — 删除以 AGENTS 为目标的旧实现计划。
- 保留：`docs/superpowers/specs/2026-10-10-ubuntu-deployment-skill-design.md` — 已确认的新设计依据。

### 任务 1：创建并验证项目级部署技能

**文件：**
- 创建：`.agents/skills/deploy-movie-harbor-ubuntu/SKILL.md`
- 创建：`.agents/skills/deploy-movie-harbor-ubuntu/references/runbook.md`
- 创建：`.agents/skills/deploy-movie-harbor-ubuntu/agents/openai.yaml`
- 修改：`tests/documentation.test.mjs`

- [ ] **步骤 1：运行无技能基线行为测试**

派遣一个不继承当前会话、且不提供技能内容的独立子代理，使用以下只读场景：

```text
你需要把 dist/offline/movie-harbor-offline-linux-amd64-1.6.tar.gz 部署到 SSH 主机 ubuntu 的现有 Movie Harbor 服务。只制定可执行步骤，不运行任何命令。说明如何处理 .env、数据库、媒体目录、服务验收和失败回滚。
```

记录其是否遗漏以下任一项目特定边界：固定部署目录、默认不备份媒体、`.env` 哈希保护、数据库恢复需重新授权、五个常驻服务与 `media-init` 的不同验收方式。预期：至少遗漏一项，证明项目技能提供了非显而易见的价值；不得让基线代理连接服务器。

- [ ] **步骤 2：编写失败的技能契约测试**

在 `tests/documentation.test.mjs` 增加：

```js
const agentsPath = path.join(projectRoot, "AGENTS.md");
const deploymentSkillPath = path.join(
  projectRoot,
  ".agents/skills/deploy-movie-harbor-ubuntu/SKILL.md",
);

test("project deployment skill has resolvable local references", () => {
  assert.ok(existsSync(deploymentSkillPath), "deployment skill is missing");
  const targets = localMarkdownTargets(deploymentSkillPath);
  assert.ok(targets.length > 0, "deployment skill must link its runbook");
  for (const target of targets) {
    assert.ok(existsSync(target), `deployment skill has a broken link to ${target}`);
  }
});
```

- [ ] **步骤 3：运行测试验证正确失败**

运行：

```bash
node --test tests/documentation.test.mjs
```

预期：新增测试失败，错误包含 `deployment skill is missing`；原 README 文档测试仍通过。

- [ ] **步骤 4：初始化最小技能结构**

运行当前环境中 skill-creator 自带的初始化器：

```bash
python3 /Users/zhangdi/.codex/skills/.system/skill-creator/scripts/init_skill.py deploy-movie-harbor-ubuntu --path .agents/skills --resources references --interface display_name="部署 Movie Harbor 到 Ubuntu" --interface short_description="安全执行 Movie Harbor 的 Ubuntu 半离线升级" --interface default_prompt='Use $deploy-movie-harbor-ubuntu to deploy the selected Movie Harbor offline package to the configured Ubuntu host.'
```

确认生成 `SKILL.md` 与 `agents/openai.yaml`，并删除初始化器产生的任何未使用占位内容。

- [ ] **步骤 5：编写技能入口**

将 `SKILL.md` 写为简洁、可发现的入口。Frontmatter 使用：

```yaml
---
name: deploy-movie-harbor-ubuntu
description: Use when deploying, upgrading, or recovering Movie Harbor on the project's configured Ubuntu host from a semi-offline Linux AMD64 release package.
---
```

正文必须：

- 将普通开发、仅构建发布包、仅解释部署原理排除在触发范围外。
- 要求执行前完整读取 `[references/runbook.md](references/runbook.md)` 以及项目的三个部署指南。
- 要求涉及 Docker Compose CLI 行为时按根 `AGENTS.md` 规则使用 Context7。
- 明确“加载技能不等于获得生产变更授权”，数据库恢复与媒体备份必须取得当次明确授权。
- 明确失败条件出现后停止，不自行扩大操作范围。

- [ ] **步骤 6：编写完整 runbook**

`references/runbook.md` 使用设计规格中的固定环境、11 步部署流程、失败边界和验收标准。必须明确：

- `ubuntu` 与 `/home/zhangdi/works/movie_harbor/serve`。
- `VERSION` 取自用户本次指定包，备份时间戳取服务器实际时间。
- `.env` 只记录 SHA-256 和配置项名，绝不显示、覆盖或把秘密写进输出。
- 数据库备份使用 PostgreSQL 自带工具并由 `pg_restore -l` 验证；升级前记录电影、剧集、季和单集数量。
- 默认不备份或改动媒体目录。
- 五个常驻服务必须 `healthy`；`media-init` 必须成功退出且退出码为 `0`。
- 不运行 `docker compose down -v`；数据库恢复前重新向用户请求明确授权。

- [ ] **步骤 7：校验技能并验证测试通过**

运行：

```bash
python3 /Users/zhangdi/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/deploy-movie-harbor-ubuntu
node --test tests/documentation.test.mjs
git diff --check
```

预期：技能校验成功；Node 测试 2 项通过、0 失败；无空白错误。

- [ ] **步骤 8：运行有技能的独立行为测试**

派遣新的无历史子代理，给出步骤 1 的同一只读场景，并明确要求使用 `.agents/skills/deploy-movie-harbor-ubuntu/SKILL.md`。预期输出必须覆盖步骤 1 列出的全部项目特定边界，且不得尝试连接服务器或泄露 `.env` 内容。若仍遗漏，依据实际失败收紧技能后重复测试。

- [ ] **步骤 9：Commit**

```bash
git add .agents/skills/deploy-movie-harbor-ubuntu tests/documentation.test.mjs
git commit -m "feat: add ubuntu deployment project skill"
```

### 任务 2：移除 AGENTS 中的重复部署规则

**文件：**
- 修改：`AGENTS.md`
- 修改：`tests/documentation.test.mjs`
- 删除：`docs/superpowers/plans/2026-10-10-ubuntu-offline-deployment-runbook.md`

- [ ] **步骤 1：编写失败的去重契约测试**

在 `tests/documentation.test.mjs` 增加：

```js
test("AGENTS delegates Ubuntu deployment details to the project skill", () => {
  const agents = readFileSync(agentsPath, "utf8");
  assert.ok(
    !agents.includes("## Ubuntu 半离线部署流程"),
    "AGENTS still duplicates the Ubuntu deployment runbook",
  );
  assert.ok(
    !agents.includes("2026-10-10-ubuntu-offline-deployment-runbook"),
    "AGENTS still links the superseded deployment documents",
  );
  assert.ok(
    !existsSync(
      path.join(
        projectRoot,
        "docs/superpowers/plans/2026-10-10-ubuntu-offline-deployment-runbook.md",
      ),
    ),
    "superseded AGENTS deployment plan still exists",
  );
});
```

- [ ] **步骤 2：运行测试验证正确失败**

运行：

```bash
node --test tests/documentation.test.mjs
```

预期：新增测试失败并报告 `AGENTS still duplicates the Ubuntu deployment runbook`；任务 1 的两个测试通过。

- [ ] **步骤 3：移除旧内容与旧计划**

在 `AGENTS.md`：

- 删除“媒体、部署与发布”索引中的旧设计与旧实现计划两行。
- 删除从 `## Ubuntu 半离线部署流程` 标题到 `## 开发工作流` 之前的完整章节。
- 不在 `AGENTS.md` 添加 runbook 副本或项目技能说明。

删除 `docs/superpowers/plans/2026-10-10-ubuntu-offline-deployment-runbook.md`。不得删除新的技能设计规格。

- [ ] **步骤 4：运行完整文档与技能验证**

运行：

```bash
python3 /Users/zhangdi/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/deploy-movie-harbor-ubuntu
node --test tests/documentation.test.mjs
rg -n "Ubuntu 半离线部署流程|2026-10-10-ubuntu-offline-deployment-runbook" AGENTS.md || true
test ! -e docs/superpowers/plans/2026-10-10-ubuntu-offline-deployment-runbook.md
git diff --check
```

预期：技能校验成功；Node 测试 3 项通过、0 失败；`rg` 检查 AGENTS 无输出；`test ! -e` 退出码为 0，确认旧计划不存在；无空白错误。

- [ ] **步骤 5：核对最终差异与秘密保护**

运行：

```bash
git diff --stat
git diff -- . ':!package-lock.json'
git diff | rg -ni 'password\s*[:=]|cookie\s*[:=]|token\s*[:=]|\.env\s*[:=]' || true
```

预期：差异只包含设计认可的技能、测试、AGENTS 清理和旧计划删除；秘密检索无真实凭据值。

- [ ] **步骤 6：Commit**

```bash
git add AGENTS.md tests/documentation.test.mjs docs/superpowers/plans/2026-10-10-ubuntu-offline-deployment-runbook.md
git commit -m "docs: move ubuntu deployment rules into project skill"
```
