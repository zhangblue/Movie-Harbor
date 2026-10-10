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

加载技能不等于获得生产变更授权；实际操作以用户本次请求为准。用户明确要求将指定发布包部署或升级到固定 `ubuntu` 主机时，已授权 runbook 的标准部署步骤，不再请求部署总确认。只要求方案时仅制定步骤，不连接服务器或执行部署。部署目标、指定包、正式目录、Compose 项目或数据挂载存在实质冲突时，在写操作前澄清，不自行更换目标或数据集。

按 runbook 逐项确认前置条件后推进。失败后停止向前升级、停止清理和停止扩大排障，保留现场并报告；仍可按 runbook 执行不改变持久数据的应用级回滚，恢复已验证的旧发布文件、原 `.env` 备份和旧镜像并验收旧服务，不让可安全恢复的旧 API 因“停止”保持下线。不得编辑、猜测、补写或重建 `.env`。

数据库恢复与媒体备份必须分别取得当次明确授权；向下迁移和媒体恢复也须取得当次明确授权。标准部署授权、应用级回滚或升级失败都不能代替这些持久数据操作的授权。
