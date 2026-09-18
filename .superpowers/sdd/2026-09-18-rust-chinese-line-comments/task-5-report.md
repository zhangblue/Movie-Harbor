# 任务 5：媒体 API、受控路径、上传替换与同步删除

## 逐文件摘要

- `backend/src/media/mod.rs`：将既有发布边界文档注释原位译为中文，说明用途、声明类型和受控普通文件共同构成可发布资产。
- `backend/src/media/path.rs`：说明受控存储键的三段系统生成格式，以及公开 URL 和容器路径拒绝任意相对路径的边界。
- `backend/src/media/routes.rs`：说明路由实际使用的请求体上限为文件策略上限加 64 KiB Multipart 开销；同时标明单一 `file` 字段、255 字节文件名和稳定错误映射。
- `backend/src/media/removal.rs`：说明全局媒体变更锁、先持久化清单后暂存、事务失败恢复、提交后完成删除，以及启动时仅依据清单恢复。
- `backend/src/media/upload.rs`：说明新文件恢复标记与数据库登记顺序、替换期间的全局锁、归属对象锁定与版本重检、旧文件暂存恢复和提交后 finalize；并将既有英文祖先锁顺序注释原位译为中文。

## 验证

- 以计划基线 `9bfb72c` 对 `backend/src` 运行仅注释差异审计：无输出。
- `cargo fmt --all -- --check`：通过。
- `cargo check -p movie-harbor-api`：通过。
- `git diff --check`：通过。

## 自审

- 仅修改了简报列出的五个 Rust 文件中的 `//` 注释，或将既有 `///` 注释原位翻译为中文；未新建文档注释，未改变类型、接口、常量、SQL 或控制流。
- 受限于当前实现，准确说明 `media::routes` 的 `DefaultBodyLimit::max(policy.max_bytes() + 64 KiB)`；未描述不存在的 `app::build` `DefaultBodyLimit::disable` 调用。
- 已复核本轮范围内的英文 `//`、`///`、`//!` 注释；仅保留代码标识符和技术名词。

## 提交

- `docs: explain Rust media mutation workflow`

## 修复记录

- 第 1 轮：更正提交后注册新资产与清理旧隔离副本的错误映射；两者均为 `ReplacementFinalizationFailed`，只与提交前可恢复的 `ReplacementFailed` 区分。

## 担忧

- 无。
