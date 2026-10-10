# Ubuntu 部署项目技能设计

日期：2026-10-10

## 目标

将已验证的 Movie Harbor Ubuntu 半离线升级流程从根目录 `AGENTS.md` 迁移为项目级技能。部署规则仅在用户要求部署或升级本项目时按需加载，避免长期占用项目协作上下文，同时保留生产操作所需的安全边界。

## 技能结构

技能目录固定为 `.agents/skills/deploy-movie-harbor-ubuntu/`：

- `SKILL.md`：定义准确的触发条件、适用范围、执行入口、授权边界和需要读取的项目文档。
- `references/runbook.md`：保存完整的部署、验收、失败处理和回滚步骤。
- `agents/openai.yaml`：提供与技能名称和用途一致的界面元数据；保持默认的自动发现策略。

不创建自动部署脚本。部署目标是生产服务器，版本、包名、服务状态和失败位置会随每次任务变化；由代理逐步检查并在高风险边界获得授权，比固化一键脚本更安全。

## 触发与边界

技能名为 `deploy-movie-harbor-ubuntu`。当用户要求将 Movie Harbor 半离线包部署、升级或回滚到既定 Ubuntu 服务器时使用；普通开发、构建发布包或仅询问部署原理时不自动触发。

固定环境：

- SSH 主机别名：`ubuntu`。
- 部署目录：`/home/zhangdi/works/movie_harbor/serve`。
- AMD64 包：本地 `dist/offline/movie-harbor-offline-linux-amd64-<版本>.tar.gz`。
- 服务器必须为 `x86_64`/`linux/amd64`，并安装 Docker Engine 与 Docker Compose v2。

技能不得把创建技能或阅读流程视为执行生产部署的授权。任何实际部署仍以用户当次请求为准；数据库恢复、媒体备份等额外操作必须获得明确授权。

## 入口与渐进披露

`SKILL.md` 保持简短，只包含：

1. 使用场景与不适用场景。
2. 开始前读取 `references/runbook.md`、`docs/guides/deployment.md`、`docs/guides/offline-package.md` 和 `docs/guides/media-and-backup.md`。
3. 涉及 Docker Compose CLI 行为时按项目规则使用 Context7 查询当前文档。
4. 生产操作的停止条件与授权边界。

完整的线性部署步骤放入 `references/runbook.md`，避免每次发现技能时加载所有操作细节。

## 部署流程要求

runbook 保留以下已验证流程：

1. 只读预检本地包、服务器架构、Docker/Compose 版本、磁盘空间、现有容器、镜像、部署目录和挂载。
2. 本地与远端分别计算离线包 SHA-256，完全一致后继续。
3. 只记录 `.env` 的 SHA-256 与配置项名称，不输出秘密值；备份时保持原 `.env` 内容不变。
4. 使用服务器实际时间创建权限为 `0700` 的唯一备份目录，备份旧部署文件和 `.env`。
5. 停止 API 冻结写入，生成并验证 PostgreSQL 自定义格式备份；记录升级前内容数量作为验收基线。
6. 默认不备份、不复制、不移动、不删除或改写媒体目录。
7. 在唯一临时目录校验并解压发布包，运行 `load-images.sh` 导入三个自研镜像。
8. 使用原 `.env` 验证新版 Compose 配置和镜像标签，只替换发布文件并再次核对 `.env` SHA-256。
9. 执行 `docker compose --env-file .env -f compose.yml up -d --no-build --wait --wait-timeout 180`。
10. 验证五个常驻服务 `postgres`、`api`、`public-web`、`admin-web`、`caddy` 均为 `healthy`，一次性 `media-init` 成功退出且退出码为 `0`。
11. 完成 HTTP、镜像版本、迁移结构、内容数量与默认公开范围、数据挂载、日志和 `.env` 哈希验收；成功后收紧备份权限并清理临时文件。

## 失败与回滚

- 包、配置或备份验证失败时，不替换正式部署文件。
- 正式文件替换或新服务启动失败时，保留日志和容器现场，使用旧部署备份恢复发布文件及原 `.env`，再用原镜像标签启动。
- 不执行 `docker compose down -v`，不删除或改写数据库目录与媒体目录，不输出 `.env` 内容。
- 数据库迁移提交后不自动向下迁移；恢复数据库必须重新获得用户明确授权，并使用升级前备份。
- 用户若另行要求媒体备份，中止时必须停止临时容器并删除不完整归档。

## AGENTS.md 调整

删除本次新增的 `Ubuntu 半离线部署流程` 全章，以及指向旧部署设计和实现计划的索引项。`AGENTS.md` 不保留部署步骤或技能内容的副本，项目级技能通过 `.agents/skills/` 自动发现。

原实现计划 `docs/superpowers/plans/2026-10-10-ubuntu-offline-deployment-runbook.md` 将由新的技能实现计划替代，避免仓库保留相互冲突的指令。

## 验证

- 使用技能校验器检查 frontmatter、目录名和未完成占位符。
- 检查 `AGENTS.md` 不再包含本次新增的 Ubuntu 部署章节或旧文档链接。
- 检查技能入口能发现并链接 runbook，runbook 覆盖 `.env` 保护、默认不备份媒体、数据库备份、服务状态验收和回滚授权边界。
- 通过独立行为测试确认：没有技能时代理容易遗漏项目特定边界；加载技能后，代理能够提出安全、完整且不泄露秘密的部署方案。
- 运行项目文档契约测试与 `git diff --check`。
