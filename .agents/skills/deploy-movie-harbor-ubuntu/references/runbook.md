# Movie Harbor Ubuntu 半离线部署 runbook

## 固定环境与授权

| 项目 | 取值或要求 |
| --- | --- |
| SSH 主机别名 | `ubuntu` |
| 正式部署目录 | `/home/zhangdi/works/movie_harbor/serve` |
| 本地发布包 | `dist/offline/movie-harbor-offline-linux-amd64-VERSION.tar.gz` |
| 目标平台 | 服务器 `x86_64`，Docker 镜像 `linux/amd64` |
| 工具 | Docker Engine、Docker Compose v2、`sha256sum`、PostgreSQL 自带工具 |
| 版本与时间 | `VERSION` 取自用户本次指定包；备份时间戳取服务器实际时间，不使用本机时间或历史版本 |

以下是逐步操作指南，不是一键部署脚本。用户明确要求将指定发布包部署或升级到既定 `ubuntu` 主机，即已给出标准部署授权：包括只读预检、通过既定 SSH 主机上传、创建部署文件与数据库安全备份、替换校验后的发布文件、启动与验收，不再请求部署总确认，也不要求为标准上传另选传输方式确认。只制定步骤的请求不允许连接服务器。沿用现有 Compose 项目名、`.env`、数据库与媒体挂载，禁止通过改路径建立新数据集来绕过错误。目标、包、正式目录、Compose 项目或数据挂载存在实质冲突时，在写操作前澄清。

失败条件中的“停止”统一指停止向前部署、停止清理和停止扩大排障；保留诊断与备份，并按末尾的失败处理执行不改变持久数据的应用级回滚。它不要求将可安全恢复的旧 API 保持下线。

默认不备份媒体。数据库与媒体在完整灾难恢复中仍属于同一一致性备份集；本次升级只备份数据库和部署文件，不改变媒体内容，不能称为完整灾备。若指南中的迁移前置条件要求媒体一致备份（例如尚未升级到 v5），停止向前部署、停止清理和停止扩大排障，并取得本次媒体备份明确授权，不能忽略该前置条件。

## 按序部署：11 步

1. **只读预检。** 确认指定本地包存在、版本和 AMD64 文件名一致；读取归档清单，核验目录结构。检查 `ubuntu` 的服务器架构、Docker/Compose 版本、磁盘空间（上传包、解压、镜像和数据库备份均需余量）、现有容器、旧镜像标签与 ID、正式部署目录和数据挂载。仅选择性读取容器状态、镜像、标签和挂载，不输出完整 `docker inspect` 的环境信息。核对已有部署项目名，后续操作沿用它。确认 PostgreSQL、Caddy、Alpine 的固定版本镜像可用或可从 Docker Hub 获取；包仅含三个自研镜像。

2. **校验传输完整性。** 本地计算外层包 SHA-256，通过既定 SSH 主机 `ubuntu` 上传到 `/home/zhangdi/works/movie_harbor` 下的唯一位置；不要覆盖现有包。在服务器重新计算 SHA-256，必须与本地完全一致，才进入后续步骤。哈希不符立即停止向前部署、停止清理和停止扩大排障，进入失败处理。

3. **保护原 `.env`。** 在正式目录对 `.env` 记录 SHA-256 和配置项名称；报告只包含哈希与键名，绝不显示配置值、密码、Cookie 或秘密。为确认数据位置，只在受控检查中读取 `DATABASE_HOST_DIR`、`MEDIA_HOST_DIR` 路径并与实际挂载比较；不要把 `.env` 作为 shell 脚本执行。禁止 `cat .env`、`set -x`、完整 `docker compose config` 或 `config --environment`。发现必填配置缺失就停止向前部署、停止清理和停止扩大排障，进入失败处理；不得编辑、猜测、补写或重建 `.env`，也不得从 `.env.example` 创建新 `.env`。

4. **备份旧部署文件。** 从服务器实际时间取得时间戳，在正式目录外创建唯一备份目录，创建时设 `0700` 且不覆盖旧备份。按预检确定的发布文件清单备份旧 `compose.yml`、`Caddyfile`、加载脚本、发布说明、示例配置与校验清单等存在的文件，另行原样复制 `.env`；排除数据库和媒体目录，不递归备份整个 `serve`。备份 `.env` 内容不变，备份副本哈希须与原哈希一致。记录原镜像标签与 ID，保留旧镜像。包含 `.env` 的文件立即设为 `0600`。

5. **冻结写入并验证数据库备份。** 在正式目录用原配置停止 `api`，确认已停止且所有应用写入停止，保持 PostgreSQL 运行。通过 PostgreSQL 容器的 `psql` 记录全部状态的电影、剧集、季、单集数量；已有 `is_private` 时记录电影和剧集按访问范围的数量。使用同一容器内的 `pg_dump -Fc` 生成自定义格式逻辑备份，检查退出码和非空文件，再用同版本 `pg_restore -l` 读取备份清单，确认退出码为 `0`。备份包含私密内容和密码哈希，权限设 `0600`，不输出备份内容。示例命令均在服务器正式目录执行，`BACKUP_DIR` 为本次已验证的唯一备份目录；容器自行展开数据库账号，不在本地拼接密码：

   ```bash
   docker compose --env-file .env -f compose.yml stop api
   docker compose --env-file .env -f compose.yml exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT (SELECT count(*) FROM movie) AS movies, (SELECT count(*) FROM series) AS series, (SELECT count(*) FROM season) AS seasons, (SELECT count(*) FROM episode) AS episodes;"'
   docker compose --env-file .env -f compose.yml exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACKUP_DIR/database.dump"
   docker compose --env-file .env -f compose.yml exec -T postgres pg_restore -l < "$BACKUP_DIR/database.dump" > "$BACKUP_DIR/database.list"
   ```

   每条命令成功后才执行下一条，不能忽略失败后继续。清单可读证明归档结构可读，不等同于已演练完整恢复。备份验证失败时不得替换正式文件；保存诊断信息，按失败处理恢复旧服务的可用状态。

6. **保持媒体目录。** 用户未明确要求时，不备份、不复制、不移动、不删除或改写媒体目录与其文件；不通过修权限、删除隔离文件或扫描孤立文件解决启动错误。预检确认原有属主和权限满足项目要求，正常 Compose 的既定 `media-init` 生命周期仍须验收。若用户当次明确要求媒体备份，在 API 停止的同一备份点按媒体指南只读归档；若中止，停止本次临时备份容器并删除已确认属于本次的不完整归档，保留完整备份，不删除媒体源目录。

7. **隔离解压和加载镜像。** 在正式目录之外用 `mktemp -d` 创建唯一临时目录；先检查已校验包的归档路径没有绝对路径、`..`、异常链接或不符合包结构的成员，再解压。正常根目录是 `movie-harbor/`，发布文件是 `.env.example`、`Caddyfile`、`README.md`、`compose.yml`、`images.tar`、`load-images.sh`、`SHA256SUMS`。在临时包目录执行 `./load-images.sh`，让其验证包内 SHA-256、导入三个自研镜像并验证精确标签与平台。任何包校验、镜像加载或平台验证失败都不替换正式部署文件。

8. **校验并替换发布文件。** 用原 `.env` 验证临时新版 Compose，保留正式目录作为相对路径基准和原项目名。使用静默 `config -q`，只用 `config --images` 查看镜像标签；不要输出带秘密的完整配置。示例中 `STAGED_COMPOSE` 为本次临时目录中已验证的 `movie-harbor/compose.yml`，项目名应与预检一致：

   ```bash
   docker compose --project-directory /home/zhangdi/works/movie_harbor/serve --env-file /home/zhangdi/works/movie_harbor/serve/.env -f "$STAGED_COMPOSE" config -q
   docker compose --project-directory /home/zhangdi/works/movie_harbor/serve --env-file /home/zhangdi/works/movie_harbor/serve/.env -f "$STAGED_COMPOSE" config --images
   ```

   核对三个标签为 `movie-harbor-api:VERSION-linux-amd64`、`movie-harbor-public-web:VERSION-linux-amd64`、`movie-harbor-admin-web:VERSION-linux-amd64`，基础镜像为 `postgres:17-alpine`、`caddy:2.10-alpine`、`alpine:3.22`。确认 shell 环境未覆盖原 `.env` 的配置，选择性核对数据挂载仍指向原目录。校验成功后只按清单替换发布文件，明确排除 `.env`、数据库和媒体目录；替换完成立即重新计算 `.env` SHA-256，必须与步骤 3 一致。替换中途失败即进入失败处理，不继续启动新版。

9. **启动目标版本。** 在 `/home/zhangdi/works/movie_harbor/serve`，使用原项目身份执行：

   ```bash
   docker compose --env-file .env -f compose.yml up -d --no-build --wait --wait-timeout 180
   ```

   `--wait` 等待服务 `running` 或 `healthy`，不能代替下一步的精确验收。API 启动自动执行迁移。命令失败或超时后停止向前部署、停止清理和停止扩大排障，保留日志和容器现场，按失败处理执行应用级回滚，不无限重试或扩大范围。

10. **核验服务状态。** 五个常驻服务 `postgres`、`api`、`public-web`、`admin-web`、`caddy` 必须全部为 `healthy`，不能仅看 `running`。一次性 `media-init` 必须是 `exited` 且退出码为 `0`，不要求它 `healthy` 或持续运行。用 `docker compose ... ps --all` 找到包括已退出初始化容器的全部服务，再只读取容器 `.State.Status`、`.State.Health.Status`、`.State.ExitCode`。容器缺失、非预期副本、任一健康状态不合格或初始化失败都保留现场、停止向前部署、停止清理和停止扩大排障，进入失败处理，不能宣布成功。

11. **最终验收和收尾。** 所有验收条件通过后才恢复正常使用并清理本次临时文件：

   - 入口 `/api/health` 返回 HTTP 成功和 `{"status":"ok"}`，公开站 `/` 与后台 `/admin/` HTTP 响应正常；使用现有入口地址，不猜端口或修改访问配置。
   - 三个实际运行自研容器使用本次 `VERSION` 的 `linux/amd64` 镜像，实际镜像 ID 与已加载目标镜像一致。
   - 数据库迁移记录与本次目标版本结构相符。涉及私密内容与普通用户的版本须确认电影、剧集 `is_private` 为非空且默认 `false`，以及 `viewer_user`、`viewer_session` 表存在；没有旧访问范围字段的内容仍默认公开，已有公开/私密设置保持原样。
   - 用同一只读数量查询比对步骤 5：电影、剧集、季、单集数量未减少，冻结写入的升级中应保持相等；异常变化时停止向前部署、停止清理和停止扩大排障，保存只读诊断并进入失败处理。验证公开目录未扩大草稿、归档或私密内容的访问范围。
   - PostgreSQL 仍挂载原数据库目录，API 和 Caddy 仍挂载原媒体目录，Caddy 媒体挂载只读；API 启动及迁移日志无错误。日志仅保留必要诊断并遮蔽秘密，不输出完整环境。
   - `.env` SHA-256 与升级前完全一致。备份目录维持 `0700`，含数据库或 `.env` 的备份文件为 `0600`。

   成功后只清理经验证属于本次的唯一临时解压目录和不完整临时文件。保留外层发布包、完整数据库备份和旧部署备份；报告版本、验收结果、哈希一致与备份位置，不报告配置值。

## 失败处理与回滚边界

- 所有失败均先停止向前部署、停止清理和停止扩大排障，保留本次日志、容器诊断与完整备份。标准部署授权包含以下不改变持久数据的应用级回滚，无须再次请求回滚总确认；回滚前确认旧版本兼容当前数据库，恢复后仍须验收。
- 包、配置或数据库备份验证失败：不替换正式文件。若 API 已停而旧配置未变，确认无迁移发生且数据库和媒体未改动后使用原部署配置恢复旧 API，并验收；保存失败记录，不继续升级。
- 正式文件替换或新服务启动失败：用本次已验证旧部署备份恢复发布文件，保持原 `.env` 原样并核对哈希。如 `.env` 被意外改变，仅允许恢复字节一致且哈希匹配的原 `.env` 备份；不得编辑、猜测、补写或重建 `.env`。使用预检记录的旧镜像标签与 ID 启动并重新验收，不猜测替代镜像。原 `.env` 哈希无法恢复、旧镜像缺失、无法确认回滚不改变持久数据或旧版本与已迁移数据库不兼容时，不启动旧 API；保持停止向前部署、停止清理和停止扩大排障，保留现场并报告阻碍。
- 不执行 `docker compose down -v`；不得删除、清空或改写数据库目录、媒体目录，也不得删除持久卷或通过改指数据目录规避错误。
- 数据库恢复、向下迁移、媒体备份或媒体恢复，均须针对各项操作重新取得明确授权，且必须是当次明确授权。数据库迁移已提交后，不自动向下迁移，不自动执行 `pg_restore`。取得数据库恢复授权后，使用升级前已验证备份，在 API 停写下按媒体指南核对一致性后恢复；授权等待期间仅保留现场和诊断，不做数据恢复。升级授权、应用级回滚、既往恢复许可都不替代此次持久数据操作许可。
- 媒体备份须独立明确授权；只有当次已授权的媒体备份中止时，才可按步骤 6 清理经确认属于本次的不完整归档。其他失败保留现场，停止清理；不得将排障扩大为修媒体、重置账号或重新初始化数据库。
