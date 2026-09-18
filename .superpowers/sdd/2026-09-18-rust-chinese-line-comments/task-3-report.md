# 任务 3：管理查询、导出、公开目录与题材

## 逐文件摘要

- `backend/src/admin_content/query.rs`：说明电影与剧集统一投影、绑定参数筛选、可重复读快照，以及稳定分页排序。
- `backend/src/admin_export/query.rs`：说明全量导出的一致只读快照、题材批量归组（含停用的历史关联）和受控媒体路径的失败关闭。
- `backend/src/catalog/query.rs`：说明公开内容的有效发布条件、列表与详情快照、剧集与单集的双重可见性，以及题材批量读取。
- `backend/src/catalog/dto.rs`：将既有搜索字段的英文文档注释翻译为中文，并说明 LIKE 字面量转义。
- `backend/src/genres/service.rs`：说明唯一约束错误映射、停用保留历史关联、重排完整性、删除引用检查和关联前的共享行锁；将既有英文文档注释翻译为中文。
- `admin_content`、`admin_export`、`catalog`、`genres` 的 `dto.rs`、`routes.rs` 和 `mod.rs` 已逐项审核；除上述必要位置及既有英文注释翻译外，没有为简单转发或显然数据结构添加冗余注释。

## 验证证据

- `cargo fmt --all -- --check`：通过。
- `cargo check -p movie-harbor-api`：通过。
- `git diff --check`：通过。
- 注释专用差异审计：只检查简报范围内 Rust 文件；无非注释代码增删。
- 英文行注释审计：简报范围内原有英文 `//`、`///`、`//!` 均已原位翻译；代码标识符和技术名词除外。

## 自审

- 所有改动均为中文注释或既有注释的原位翻译，未改变 SQL、控制流、数据结构、接口或错误语义。
- 未新建文档注释；新增说明一律使用普通 `//` 行注释，并紧邻其解释的不变量或并发边界。
- 注释覆盖简报要求的查询快照、稳定排序、参数化筛选、题材批量读取、公开可见性与题材服务并发约束。

## 提交

- `docs: explain Rust query and genre invariants`（本报告与源码改动同一提交）。

## 担忧

- 无。
