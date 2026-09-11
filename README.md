# Movie Harbor

Movie Harbor 是一个面向个人或小型团队、可自行部署的电影与剧集媒体库。访客无需登录即可浏览、搜索和播放已发布内容；单一管理员通过独立后台维护电影、剧集、季、单集、题材、海报和视频。

## 当前状态

- 产品设计：已确认。
- UI Demo：已确认，保存在 `demo/`。
- 实现计划：已完成。
- 生产代码：尚未开始。

## 核心设计

- 内容支持电影和“剧集 → 季 → 集”两种结构。
- 电影、剧集和单集具有草稿、已发布、已归档状态，只有草稿可以编辑。
- 访客无需账号；观看进度只保存在当前浏览器。
- 管理后台采用单一管理员账号。
- 视频不自动转码，管理员上传浏览器可直接播放的文件。
- 海报和视频保存在本地持久化媒体目录。
- 首版使用 Docker Compose 面向 NAS、个人服务器或小型 VPS 部署。

## 技术栈

- 公开站与管理后台：React + Vite + TypeScript，分别构建。
- 后端：Rust + Axum。
- 数据库访问：SeaORM + PostgreSQL。
- 异步运行时与文件操作：Tokio。
- 对外入口：同一域名下的 `/`、`/admin`、`/api` 和 `/media`。

## 项目文档

- [产品设计规格](docs/superpowers/specs/2026-09-11-self-hosted-media-library-design.md)
- [实现计划](docs/superpowers/plans/2026-09-11-self-hosted-media-library-implementation.md)
- [协作约定](AGENTS.md)

## 查看 UI Demo

Demo 使用模拟数据，用于审核访客首页、管理后台和添加剧集页面，不连接真实后端。

在项目根目录执行：

```bash
python3 -m http.server 4173 --directory demo --bind 127.0.0.1
```

服务启动后，可访问以下页面：

- 访客首页：http://127.0.0.1:4173/?view=home
- 管理后台：http://127.0.0.1:4173/?view=admin
- 添加剧集：http://127.0.0.1:4173/?view=series-editor

停止服务时，在运行服务的终端按 `Ctrl+C`。

如果 `4173` 端口已被占用，可以更换端口，例如：

```bash
python3 -m http.server 4174 --directory demo --bind 127.0.0.1
```

此时将访问地址中的端口同步改为 `4174`。

## 当前目录

```text
demo/                       已审核的静态 UI Demo
docs/superpowers/specs/     产品设计规格
docs/superpowers/plans/     分阶段实现计划
openspec/                   OpenSpec 工作目录
AGENTS.md                   项目协作与实现约束
```

生产代码目录会按照实现计划在开发阶段逐步创建。

## 首版不包含

- 自动转码和码率自适应。
- 外挂字幕管理。
- 多管理员或角色权限。
- 服务端观看历史、收藏、评分和评论。
- 第三方元数据导入。
- S3、MinIO 等对象存储。
- 防下载、数字版权保护或可靠的防盗链。
