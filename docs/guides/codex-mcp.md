# Codex 视频入库 MCP 指南

[返回 README](../../README.md)

Movie Harbor MCP 是运行在本机的 STDIO 服务。它让 Codex 用一组独立工具检查、转换和上传本地视频，创建电影或电视剧草稿，并在你再次确认后发布。视频按流上传，不会作为 Base64 或对话内容交给模型。

## 安装前准备

安装机器需要 Node.js、npm、Codex CLI、FFmpeg 和 FFprobe。先确认 Movie Harbor 服务已经部署且可以从本机访问，再在仓库根目录执行：

```bash
./mcp/install.sh
```

脚本使用锁文件安装依赖并构建 MCP，然后通过 `codex mcp add` 注册全局服务。它只更新名为 `movie-harbor`、且确认属于当前仓库的条目，不会整体改写 Codex 配置，也不会覆盖其他工程的同名服务。

安装完成后可检查注册：

```bash
codex mcp list
codex mcp get movie-harbor --json
```

脚本不会自动重启 Docker Compose。请把输出的 SHA-256 摘要写入 Movie Harbor 部署环境中的 `MCP_API_KEY_SHA256`，自行重启 Movie Harbor，然后在 Codex 桌面版的 MCP servers 设置中重启 `movie-harbor`。不要把摘要误当作原始密钥。

## 独立密钥和本机配置

MCP 使用独立于管理员登录的 Bearer 密钥。原始密钥仅保存在权限为 `0600` 的 `credentials.env`，普通配置只引用该文件；安装输出、Codex 启动参数和 Git 中都不应出现原始密钥。后端只保存其 SHA-256 摘要。

默认配置目录是 `${XDG_CONFIG_HOME:-$HOME/.config}/movie-harbor-mcp`。默认允许读取 `/Users/zhangdi/Downloads`，可在运行安装脚本前通过 `MOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON` 指定其他绝对目录，例如：

```bash
MOVIE_HARBOR_MCP_ALLOWED_ROOTS_JSON='["/Volumes/Media/Incoming"]' ./mcp/install.sh
```

只把确实用于入库的目录加入允许列表。MCP 会解析真实路径，拒绝目录、非普通文件、符号链接逃逸和执行期间发生身份变化的文件。转换输出位于受控生成目录；上传明确成功后自动删除，上传失败或结果未知时保留以便重试，原视频永不删除。

远程 Movie Harbor 可通过 `MOVIE_HARBOR_MCP_BASE_URL` 指定无凭据、无额外路径的 HTTPS 根地址。安装器仍只显示摘要；请在远程部署端人工配置摘要并重启服务，不要复制原始密钥到命令行或聊天中。

## 入库要求

MCP 创建的新电影和电视剧固定为私密草稿。创建前必须由你指定并验证海报路径；没有海报不能创建。元数据要求如下：

- 电影：名称、年代、至少一个题材、海报和由 FFprobe 探测的时长。
- 电视剧：名称、年代、至少一个题材和海报。
- 单集：季号、集号、你提供的单集名称，以及由 FFprobe 探测的时长。

缺少题材时，Codex 会先列出计划，再单独调用创建题材工具。搜索结果不会按近似名称自动合并；出现多个同名候选时必须由你明确选择。已有内容只按最新版本更新，遇到 `409` 版本冲突时应重新查询并重新确认，不能自动覆盖并发修改。

## 三次独立确认

转换、入库和发布是三个相互独立的阶段，一次确认不能代替另一次：

1. **转换确认**：视频不符合网站要求时，Codex 展示原因、轨道处理和输出位置；只有你同意后才调用转换工具。需要 FFmpeg/FFprobe，图像字幕等不支持情况会停止并提示处理。
2. **入库或替换确认**：Codex 展示将创建或更新的内容、海报和视频路径。空视频槽位使用普通上传；已有视频必须明确说明替换，并调用独立的替换工具。普通上传不会隐式覆盖。
3. **发布确认**：上传完成后 Codex 再询问是否发布。电影、单集和父电视剧分别发布；发布单集不会自动发布仍为草稿的父电视剧。

所有工具都是原子操作。任何一步失败后可从该步重试，已经创建的私密草稿和已经成功上传的媒体不会因后续发布失败而回滚。

## 密钥轮换与卸载

轮换时重新生成独立原始密钥，将其保存到权限为 `0600` 的凭据文件，计算 SHA-256 摘要并更新部署端 `MCP_API_KEY_SHA256`。重启 Movie Harbor 后再重启 Codex 中的 MCP 服务；旧密钥会立即失效。轮换期间不要把原始密钥打印到终端历史或发送到对话。

只移除 Codex 注册时执行：

```bash
codex mcp remove movie-harbor
```

这不会删除 Movie Harbor 数据，也不会撤销后端摘要。确认不再需要后，可人工删除本机 MCP 配置目录，并从部署环境移除 `MCP_API_KEY_SHA256` 后自行重启 Movie Harbor。
