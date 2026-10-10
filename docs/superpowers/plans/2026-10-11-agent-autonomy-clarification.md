# 代理自主性与部署授权规则澄清实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 消除 `AGENTS.md` 与 Ubuntu 部署 Skill 中会引起过度读取、重复确认、无关验证或失败后停滞的歧义，同时保留数据库恢复、媒体操作、秘密和数据目录的明确保护边界。

**架构：** 根 `AGENTS.md` 只定义项目范围内的通用决策规则和按风险选择验证的矩阵；部署 Skill 定义明确部署请求所授权的标准动作，并由 runbook 区分停止向前升级、应用级回滚和必须重新授权的持久数据恢复。Node 文档契约测试保护关键语义，Skill 校验器与独立只读行为测试验证可发现性和实际决策。

**技术栈：** Markdown、Node.js 内置测试运行器、Codex Skill、skill-creator 校验器、Git。

---

## 文件结构

- 修改：`AGENTS.md` — 缩小强制资料读取和计划前提，明确冲突优先级、Context7 适用范围、测试驱动边界、备份语义与验证矩阵。
- 修改：`.agents/skills/deploy-movie-harbor-ubuntu/SKILL.md` — 明确部署请求无需重复总确认，并区分停止向前升级与应用级回滚。
- 修改：`.agents/skills/deploy-movie-harbor-ubuntu/references/runbook.md` — 明确标准上传、授权范围、应用回滚和持久数据恢复边界。
- 修改：`tests/documentation.test.mjs` — 增加全局规则和部署授权语义的契约测试。

### 任务 1：澄清 AGENTS 通用自主性规则

**文件：**
- 修改：`AGENTS.md`
- 修改：`tests/documentation.test.mjs`

- [ ] **步骤 1：编写失败的通用规则契约测试**

在 `tests/documentation.test.mjs` 增加：

```js
test("AGENTS scopes project process rules to the actual change", () => {
  const agents = readFileSync(agentsPath, "utf8");

  assert.match(agents, /修改产品行为、接口、数据结构、媒体生命周期或部署机制前/);
  assert.match(agents, /纯文档、格式、注释、已有流程执行和只读审阅/);
  assert.match(agents, /用户本次明确要求[\s\S]*最新且已确认的增量规格[\s\S]*主规格/);
  assert.match(agents, /当前实现只作为现状证据，不自动覆盖规格/);
  assert.match(agents, /当任务已有经用户确认的实现计划时/);
  assert.match(agents, /文档、Skill、静态配置和一次性运维规则/);
  assert.match(agents, /不需要为跳过无关检查向用户确认/);
  assert.match(agents, /只执行已发布且已验证的部署包/);
});

test("AGENTS distinguishes disaster recovery from deployment safety backup", () => {
  const agents = readFileSync(agentsPath, "utf8");
  assert.match(agents, /完整灾难恢复[\s\S]*数据库和媒体作为同一一致性备份集/);
  assert.match(agents, /仅升级应用且保证媒体目录不变[\s\S]*只创建数据库和部署文件安全备份/);
  assert.match(agents, /迁移前置条件要求媒体一致备份[\s\S]*取得媒体备份明确授权/);
});
```

- [ ] **步骤 2：运行测试确认红灯**

运行：

```bash
node --test tests/documentation.test.mjs
```

预期：两个新测试因旧 `AGENTS.md` 缺少范围和授权语义而失败；已有 3 项测试通过。

- [ ] **步骤 3：重写资料读取与冲突优先级**

在“当前阶段”中保留主规格和增量规格索引，但将规则改为：

- 产品行为、接口、数据结构、媒体生命周期或部署机制变化才强制读取主规格和直接相关增量规格。
- 文档、格式、注释、已有流程执行和只读审阅只读取直接相关资料。
- 优先级为用户本次明确要求、同领域最新且已确认的增量规格、主规格；当前实现只是现状证据。
- 只有不能用优先级消解且会改变结果、数据安全或任务范围的冲突才询问用户。

- [ ] **步骤 4：限定 Context7、计划和测试驱动规则**

将 Context7 规则限定为用法问题、选择或修改 API/CLI 参数、配置、版本及其排障。明确执行仓库固定命令、现有测试脚本和普通 Git 仓库操作无需重复查询。

将“按实现计划顺序推进”增加“任务已有经用户确认的实现计划”前提。可执行代码继续失败测试优先；文档、Skill、静态配置和一次性运维规则使用契约、链接、schema、构建或聚焦检查。

- [ ] **步骤 5：澄清备份与完成验证矩阵**

将宿主数据目录中的一致性备份规则改成规格要求的“完整灾备/同时改变数据时一致备份；媒体不变的应用升级可只做数据库和部署文件安全备份”。

用以下变更类型重写完成验证：Rust/迁移、前端、根工具与契约、跨服务或部署实现、执行既有发布包、仅文档或 Skill。明确无关检查无需运行，也无需为跳过它们请求确认；只有实际运行的检查才能报告通过。

- [ ] **步骤 6：运行绿灯验证**

运行：

```bash
node --test tests/documentation.test.mjs
git diff --check
```

预期：5 项测试通过、0 失败；无空白错误。

- [ ] **步骤 7：提交**

```bash
git add AGENTS.md tests/documentation.test.mjs
git commit -m "docs: clarify project autonomy rules"
```

### 任务 2：澄清部署授权与失败回滚

**文件：**
- 修改：`.agents/skills/deploy-movie-harbor-ubuntu/SKILL.md`
- 修改：`.agents/skills/deploy-movie-harbor-ubuntu/references/runbook.md`
- 修改：`tests/documentation.test.mjs`

- [ ] **步骤 1：运行当前 Skill 的独立基线行为测试**

派遣不继承当前会话的独立子代理，只允许读取现有 Skill 及其直接引用文档，不连接服务器。使用场景：

```text
用户说：“把 dist/offline/movie-harbor-offline-linux-amd64-1.6.tar.gz 部署到既定 ubuntu 服务器。”请说明是否还需要一次总确认。假设替换发布文件后新 API 启动失败、数据库迁移尚未发生、媒体和数据库未改动，请说明接下来能否直接恢复旧发布文件、原 .env 备份和旧镜像；数据库恢复和媒体备份分别需要什么授权。只分析决策，不执行命令。
```

记录其是否出现以下任一失败：再次请求部署总确认；把“停止”解释为让旧 API 保持下线；把数据库恢复或媒体备份视为已授权；认为可以编辑或重建 `.env`。不得连接服务器。

- [ ] **步骤 2：编写失败的部署授权契约测试**

在 `tests/documentation.test.mjs` 增加：

```js
test("deployment skill separates standard authorization from data recovery approval", () => {
  const skill = readFileSync(deploymentSkillPath, "utf8");
  const runbookPath = path.join(
    projectRoot,
    ".agents/skills/deploy-movie-harbor-ubuntu/references/runbook.md",
  );
  const runbook = readFileSync(runbookPath, "utf8");

  assert.match(skill, /明确要求将指定发布包部署或升级[\s\S]*不再请求部署总确认/);
  assert.match(skill, /停止向前升级[\s\S]*应用级回滚/);
  assert.match(skill, /数据库恢复与媒体备份[\s\S]*当次明确授权/);
  assert.match(runbook, /标准部署授权[\s\S]*既定 SSH 主机上传/);
  assert.match(runbook, /恢复字节一致且哈希匹配的原 `.env` 备份/);
  assert.match(runbook, /不得编辑、猜测、补写或重建/);
  assert.match(runbook, /数据库恢复[\s\S]*媒体备份[\s\S]*重新取得明确授权/);
});
```

- [ ] **步骤 3：运行测试确认红灯**

运行：

```bash
node --test tests/documentation.test.mjs
```

预期：新增部署授权测试失败；任务 1 的 5 项测试通过。

- [ ] **步骤 4：更新 Skill 入口**

在“授权与停止”中明确：

- 指定发布包并要求部署或升级到固定 `ubuntu` 主机，已经授权 runbook 的标准部署步骤，不再请求总确认。
- 只要求方案时仍不连接服务器。
- 目标、包、正式目录、Compose 项目或数据挂载存在实质冲突时，在写操作前澄清。
- 失败后停止向前升级和清理，但可以执行不改变持久数据的应用级回滚。
- 数据库恢复、向下迁移、媒体备份或媒体恢复继续要求当次明确授权。

- [ ] **步骤 5：更新 runbook 授权和回滚语义**

在开头明确标准部署授权包含：只读预检、通过既定 SSH 主机上传、创建部署文件与数据库安全备份、替换校验后的发布文件、启动与验收。标准上传不要求另选传输方式确认。

把所有“停止”统一表述为停止向前部署、停止清理和停止扩大排障。失败处理明确允许恢复已验证旧发布文件、字节一致且哈希匹配的原 `.env` 备份和预检记录的旧镜像；禁止编辑或重建 `.env`。数据库或媒体恢复仍须重新授权。

- [ ] **步骤 6：运行技能与契约验证**

运行：

```bash
/Users/zhangdi/.local/bin/uv run --with PyYAML python /Users/zhangdi/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/deploy-movie-harbor-ubuntu
node --test tests/documentation.test.mjs
git diff --check
```

预期：Skill 校验成功；6 项测试通过、0 失败；无空白错误。

- [ ] **步骤 7：运行有 Skill 的独立前向行为测试**

派遣新的无历史子代理，给出步骤 1 的同一只读场景并要求使用更新后的 `SKILL.md`。预期：不要求重复部署总确认；允许不改变持久数据的应用级回滚；禁止编辑 `.env`；数据库恢复和媒体备份仍要求分别明确授权。若遗漏，依据实际失败收紧措辞后重新验证。

- [ ] **步骤 8：检查权限没有意外扩大**

聚焦检查必须确认以下词义同时存在：

```bash
rg -n "不再请求部署总确认|停止向前升级|应用级回滚|数据库恢复|媒体备份|当次明确授权|不得编辑、猜测、补写或重建" .agents/skills/deploy-movie-harbor-ubuntu
```

预期：标准部署和应用级回滚获得明确授权边界；持久数据操作仍保留单独批准要求。

- [ ] **步骤 9：提交**

```bash
git add .agents/skills/deploy-movie-harbor-ubuntu tests/documentation.test.mjs
git commit -m "docs: clarify deployment authorization boundaries"
```
