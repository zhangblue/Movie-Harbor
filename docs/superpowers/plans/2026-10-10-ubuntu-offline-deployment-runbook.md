# Ubuntu 半离线部署协作规则实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将已确认的 Ubuntu AMD64 半离线升级流程写入根目录 `AGENTS.md`，使后续部署默认保留 `.env`、备份数据库和旧部署文件、跳过媒体备份并完成上线验证。

**架构：** 在现有“媒体、部署与发布”资料索引中加入部署规则规格与计划链接，并新增一个独立的服务器部署章节。章节使用参数化版本号与时间戳，但固定 SSH 主机别名和部署目录；安全边界、失败停止条件、回滚要求和验收项均直接写入协作规则。

**技术栈：** Markdown、SSH、Docker Engine、Docker Compose v2、PostgreSQL 17 工具。

---

## 文件结构

- 修改：`AGENTS.md`：登记本规格与计划，并保存 Ubuntu 半离线部署的固定执行流程。
- 参考：`docs/superpowers/specs/2026-10-10-ubuntu-offline-deployment-runbook-design.md`：已确认的流程、失败边界和验收标准。
- 创建：`docs/superpowers/plans/2026-10-10-ubuntu-offline-deployment-runbook.md`：本实现计划。

### 任务 1：固化 Ubuntu 半离线部署流程

**文件：**
- 修改：`AGENTS.md`
- 测试：`tests/documentation.test.mjs`

- [ ] **步骤 1：确认现有文档契约测试基线通过**

运行：

```bash
node --test tests/documentation.test.mjs
```

预期：现有 README 与指南链接检查通过，证明文档基线没有损坏。

- [ ] **步骤 2：在部署资料索引中登记规格与计划**

在 `AGENTS.md` 的“媒体、部署与发布”列表中加入：

```markdown
- `docs/superpowers/specs/2026-10-10-ubuntu-offline-deployment-runbook-design.md`
- `docs/superpowers/plans/2026-10-10-ubuntu-offline-deployment-runbook.md`
```

保持按主题相邻排列，不调整无关条目。

- [ ] **步骤 3：新增固定服务器部署章节**

在“半离线发布边界”之后、“开发工作流”之前新增 `## Ubuntu 半离线部署流程`，写明以下实际约束：

```markdown
## Ubuntu 半离线部署流程

- 使用 SSH 主机别名 `ubuntu`，部署目录固定为 `/home/zhangdi/works/movie_harbor/serve`。
- AMD64 包位于本地 `dist/offline/movie-harbor-offline-linux-amd64-VERSION.tar.gz`；`VERSION` 和备份时间戳必须按本次部署确定。
- 任何部署前先读取本节引用的规格、部署指南、半离线发布指南和媒体备份指南，并按 Context7 约定核对 Docker Compose CLI。
```

随后用有序步骤完整记录：只读预检、本地与远端 SHA-256 校验、`.env` 哈希保护、上传、权限为 `0700` 的备份目录、停止 API、数据库及旧部署文件备份、默认不备份媒体、临时解压与 `load-images.sh`、用原 `.env` 验证新版 Compose、替换时排除 `.env`、`up -d --no-build --wait --wait-timeout 180`、健康与迁移验证、备份权限收紧和临时目录清理。

章节还必须明确：

- 不显示或覆盖 `.env` 内容；只允许读取数据目录路径和配置项名称。
- 不执行 `docker compose down -v`，不删除或改写数据库、媒体目录。
- 包、配置或备份验证失败时不替换正式文件。
- 启动失败时保留现场；数据库迁移已提交后不自动向下迁移，数据库恢复必须重新获得用户明确授权。
- 用户未明确要求时不备份媒体；若中止媒体备份，停止本次临时容器并删除不完整归档。
- 最终验收必须覆盖目标镜像、容器健康、健康接口、公开站和后台响应、迁移结构、原内容数量、数据挂载、API 日志及 `.env` 哈希。

- [ ] **步骤 4：验证规则完整且未引入秘密或失效链接**

运行：

```bash
node --test tests/documentation.test.mjs
rg -n "Ubuntu 半离线部署流程|ssh.*ubuntu|/home/zhangdi/works/movie_harbor/serve|不备份媒体|\.env.*SHA-256|--no-build --wait" AGENTS.md
test -f docs/superpowers/specs/2026-10-10-ubuntu-offline-deployment-runbook-design.md
test -f docs/superpowers/plans/2026-10-10-ubuntu-offline-deployment-runbook.md
git diff --check
```

预期：文档测试通过；检索结果覆盖固定主机、目录、媒体备份策略、`.env` 保护和启动命令；规格与计划链接目标存在；差异无空白错误。确认差异中没有密码、Cookie、令牌或 `.env` 值。

- [ ] **步骤 5：提交**

```bash
git add AGENTS.md docs/superpowers/plans/2026-10-10-ubuntu-offline-deployment-runbook.md
git commit -m "docs: record ubuntu deployment workflow"
```
