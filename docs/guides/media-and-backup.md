# 媒体与备份指南

本文说明媒体目录权限、媒体独占与同步删除、迁移 v5，以及数据库和媒体的一致备份与恢复。

[返回项目 README](../../README.md)

## 媒体目录安全边界

`MEDIA_DIR` 必须由后端进程的 OS 账号拥有，且不可对组用户或其他用户开放写权限。后端会在启动时验证该条件，并以 `0700` 创建私有 `.quarantine` 目录；权限不安全时会拒绝启动。部署时不得让其他服务共享该 OS 账号或获得媒体目录写权限。同一 OS 账号下运行的恶意进程能够修改应用自有文件，因此位于本地文件存储的信任边界内。

Compose 会先用一次性初始化容器把媒体卷根目录交给专用的 API 用户，并设为 `0700`。API 以 UID `10001` 读写媒体卷；入口 Caddy 仅以只读方式挂载同一卷。若改用宿主机目录绑定，请先执行 `chown 10001:10001 <目录>` 和 `chmod 0700 <目录>`，且不要把该目录写权限授予其他服务。

每个 `media_asset` 在电影海报、电影视频、剧集海报和单集视频槽位之间全局独占，不能被多个槽位共享。删除电影、剧集、季或单集时，API 会在同一请求内暂存对应文件、提交数据库删除并移除物理文件；替换海报或视频时也会在成功响应前同步移除旧媒体记录与旧文件。成功响应表示本次对应的数据库记录和物理文件均已处理，不需要另行等待垃圾回收。

系统不运行周期媒体垃圾回收任务。启动恢复只处理删除或替换请求在中断前已经写入持久清单的操作：数据库仍引用的文件会恢复到公开路径，已不再引用的隔离文件会完成删除；它不会扫描或自动删除任意孤立文件。因此数据库和媒体目录仍须作为一致的整体运维。

### 升级到数据库迁移 v5

迁移 v5 会把媒体所有权改为全局独占，并移除旧的 `file_cleanup_job` 周期清理队列。升级前必须先备份数据库和媒体目录，确认 `file_cleanup_job` 为空，并检查电影海报、电影视频、剧集海报和单集视频的全部引用；任何被多个槽位共享的媒体都必须先复制为各自独立的媒体记录和物理文件，再更新对应引用。迁移检测到待处理清理任务或共享引用时会拒绝升级，不会静默丢弃任务或猜测文件归属。

## 一致备份与恢复

数据库元数据和 `MEDIA_HOST_DIR` 媒体目录必须作为同一个一致性备份集处理，只备份其中一项会产生丢失引用或孤立文件。稳妥的单机流程是在维护窗口停止 API 写入，同时导出数据库并归档媒体目录。下面假设 `.env` 中的 `MEDIA_HOST_DIR` 已改为宿主机绝对路径：

```bash
docker compose -p movie-harbor stop api
docker compose -p movie-harbor exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > movie-harbor-db.dump
MEDIA_BACKUP_SOURCE=/absolute/path/from-MEDIA_HOST_DIR
docker run --rm --mount type=bind,src="$MEDIA_BACKUP_SOURCE",dst=/source,readonly --mount type=bind,src="$PWD",dst=/backup alpine:3.22 tar -C /source -czf /backup/movie-harbor-media.tgz .
docker compose -p movie-harbor start api
```

恢复时先停止 API，将数据库恢复到空库，并把媒体归档解压回 `MEDIA_HOST_DIR` 指向的目录；确认两者来自同一备份点、媒体目录属主仍为 UID/GID `10001:10001` 且权限为 `0700` 后再启动 API。备份文件包含私有内容与密码哈希，应加密保存并定期演练恢复。`DATABASE_HOST_DIR` 的 PostgreSQL 文件不能替代逻辑导出直接跨版本复制。

宿主数据目录的环境变量与挂载配置见[部署指南](deployment.md)；使用新发布包升级见[半离线发布指南](offline-package.md)。
