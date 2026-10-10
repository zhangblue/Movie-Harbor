---
name: deploy-movie-harbor-ubuntu
description: Use when deploying, upgrading, or recovering Movie Harbor on the project's configured Ubuntu host from a semi-offline Linux AMD64 release package.
---

# 部署 Movie Harbor 到 Ubuntu

用于将指定半离线包部署、升级或回滚到本项目既定 Ubuntu 服务。普通开发、仅构建发布包、仅解释部署原理不属于自动触发范围。

## 开始前

完整读取以下文件，再制定或执行步骤：

- [部署 runbook](references/runbook.md)：固定环境、11 步流程、验收和失败回滚。
- [部署指南](../../../docs/guides/deployment.md)：现有配置和访问边界。
- [半离线发布指南](../../../docs/guides/offline-package.md)：包结构和镜像加载。
- [媒体与备份指南](../../../docs/guides/media-and-backup.md)：数据一致性和迁移要求。

涉及 Docker Compose CLI 行为时，遵循根 `AGENTS.md` 的 Context7 规则：先 `resolve-library-id`，再按单一概念 `query-docs` 查询当前官方文档。避免输出会展开秘密值的完整 Compose 配置。

## 授权与停止

加载技能不等于获得生产变更授权；实际操作以用户本次请求为准。只要求方案时仅制定步骤，不连接服务器或执行部署。数据库恢复与媒体备份必须取得当次明确授权；升级失败不能代替恢复授权。

按 runbook 逐项确认前置条件后推进。失败条件出现后停止、保留现场并报告，不自行更换部署目标、修改 `.env`、修复数据或扩大操作范围。
