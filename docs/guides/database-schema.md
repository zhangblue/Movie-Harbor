# 数据库表设计

[返回项目 README](../../README.md)

> 本文描述当前迁移全部执行后的数据库结构；`backend/migration/src/` 是唯一事实来源。

## 关系概览

当前共有 11 张业务表，不计迁移工具自身的记录表。管理员与会话是一对多关系；剧集通过季组织单集；电影和剧集分别通过关联表与题材建立多对多关系。

| 关系 | 外键与删除行为 |
| --- | --- |
| 管理员 → 会话 | `admin_session.admin_user_id`，`ON DELETE CASCADE` |
| 剧集 → 季 → 单集 | `season.series_id`、`episode.season_id`，均为 `ON DELETE CASCADE` |
| 电影 / 剧集 → 题材关联 | `movie_genre.movie_id`、`series_genre.series_id`，`ON DELETE CASCADE` |
| 题材 → 内容关联 | 两张关联表的 `genre_id`，`ON DELETE RESTRICT` |
| 内容 → 媒体 | 电影海报和视频、剧集海报、单集视频外键均为 `ON DELETE RESTRICT` |
| 媒体 → 所有权 | `media_asset_ownership.asset_id`，`ON DELETE CASCADE` |

以下表格中“—”表示未声明默认值；可空字段省略时为 `NULL`。所有 UUID 主键均无数据库生成默认值。`timestamptz` 表示带时区时间戳。`CURRENT_TIMESTAMP` 只提供插入默认值，迁移没有自动更新时间戳的触发器。

## 认证与会话

### `admin_user`

| 字段 | PostgreSQL 类型 | 可空 | 默认值 | 约束 / 含义 |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | 否 | — | 主键 |
| `name` | `text` | 否 | — | 唯一；`length(btrim(name)) > 0` |
| `password_hash` | `text` | 否 | — | 密码哈希 |
| `created_at` | `timestamptz` | 否 | `CURRENT_TIMESTAMP` | 创建时间 |
| `updated_at` | `timestamptz` | 否 | `CURRENT_TIMESTAMP` | 更新时间 |

单管理员是应用规则；表结构没有限制记录总数为 1。

### `admin_session`

| 字段 | PostgreSQL 类型 | 可空 | 默认值 | 约束 / 含义 |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | 否 | — | 主键 |
| `admin_user_id` | `uuid` | 否 | — | 外键 → `admin_user.id`；删除级联 |
| `token_hash` | `text` | 否 | — | 唯一；会话令牌摘要 |
| `csrf_token_hash` | `text` | 否 | — | CSRF 令牌摘要 |
| `expires_at` | `timestamptz` | 否 | — | 会话过期时间 |
| `created_at` | `timestamptz` | 否 | `CURRENT_TIMESTAMP` | 创建时间 |

## 内容与题材

`movie`、`series`、`episode` 的生命周期字段含义一致：`status` 取 `draft`（草稿）、`published`（已发布）、`archived`（已归档）；`version` 是应用并发更新使用的版本号；`published_at` 和 `archived_at` 分别记录发布、归档时间。数据库只约束状态取值和版本为正数，状态转换、只允许编辑草稿及发布时间与状态的一致性由后端执行。

### `genre`

| 字段 | PostgreSQL 类型 | 可空 | 默认值 | 约束 / 含义 |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | 否 | — | 主键 |
| `name` | `text` | 否 | — | 唯一；`length(btrim(name)) > 0` |
| `sort_order` | `integer` | 否 | `0` | 展示顺序；无唯一或非负约束 |
| `enabled` | `boolean` | 否 | `true` | 是否启用 |
| `created_at` | `timestamptz` | 否 | `CURRENT_TIMESTAMP` | 创建时间 |
| `updated_at` | `timestamptz` | 否 | `CURRENT_TIMESTAMP` | 更新时间 |

### `movie`

| 字段 | PostgreSQL 类型 | 可空 | 默认值 | 约束 / 含义 |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | 否 | — | 主键 |
| `name` | `text` | 否 | — | `length(btrim(name)) > 0` |
| `synopsis` | `text` | 否 | `''` | 简介 |
| `year` | `integer` | 是 | — | 年份；无范围检查 |
| `duration_seconds` | `integer` | 是 | — | `duration_seconds >= 0` |
| `poster_asset_id` | `uuid` | 是 | — | 外键 → `media_asset.id`；删除受限 |
| `video_asset_id` | `uuid` | 是 | — | 外键 → `media_asset.id`；删除受限 |
| `status` | `text` | 否 | `'draft'` | 仅 `draft`、`published`、`archived` |
| `version` | `bigint` | 否 | `1` | `version > 0` |
| `published_at` | `timestamptz` | 是 | — | 发布时间 |
| `archived_at` | `timestamptz` | 是 | — | 归档时间 |
| `created_at` | `timestamptz` | 否 | `CURRENT_TIMESTAMP` | 创建时间 |
| `updated_at` | `timestamptz` | 否 | `CURRENT_TIMESTAMP` | 更新时间 |

### `series`

| 字段 | PostgreSQL 类型 | 可空 | 默认值 | 约束 / 含义 |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | 否 | — | 主键 |
| `name` | `text` | 否 | — | `length(btrim(name)) > 0` |
| `synopsis` | `text` | 否 | `''` | 简介 |
| `year` | `integer` | 是 | — | 年份；无范围检查 |
| `poster_asset_id` | `uuid` | 是 | — | 外键 → `media_asset.id`；删除受限 |
| `status` | `text` | 否 | `'draft'` | 仅 `draft`、`published`、`archived` |
| `version` | `bigint` | 否 | `1` | `version > 0` |
| `published_at` | `timestamptz` | 是 | — | 发布时间 |
| `archived_at` | `timestamptz` | 是 | — | 归档时间 |
| `created_at` | `timestamptz` | 否 | `CURRENT_TIMESTAMP` | 创建时间 |
| `updated_at` | `timestamptz` | 否 | `CURRENT_TIMESTAMP` | 更新时间 |

### `season`

| 字段 | PostgreSQL 类型 | 可空 | 默认值 | 约束 / 含义 |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | 否 | — | 主键 |
| `series_id` | `uuid` | 否 | — | 外键 → `series.id`；删除级联 |
| `number` | `integer` | 否 | — | `number > 0` |

`UNIQUE (series_id, number)` 保证季号在所属剧集内唯一。季仅是组织容器，没有名称、简介、时间戳或独立生命周期。

### `episode`

| 字段 | PostgreSQL 类型 | 可空 | 默认值 | 约束 / 含义 |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | 否 | — | 主键 |
| `season_id` | `uuid` | 否 | — | 外键 → `season.id`；删除级联 |
| `number` | `integer` | 否 | — | `number > 0` |
| `name` | `text` | 否 | — | `length(btrim(name)) > 0`；单集名称 |
| `duration_seconds` | `integer` | 是 | — | `duration_seconds >= 0` |
| `video_asset_id` | `uuid` | 是 | — | 外键 → `media_asset.id`；删除受限 |
| `status` | `text` | 否 | `'draft'` | 仅 `draft`、`published`、`archived` |
| `version` | `bigint` | 否 | `1` | `version > 0` |
| `published_at` | `timestamptz` | 是 | — | 发布时间 |
| `archived_at` | `timestamptz` | 是 | — | 归档时间 |
| `created_at` | `timestamptz` | 否 | `CURRENT_TIMESTAMP` | 创建时间 |
| `updated_at` | `timestamptz` | 否 | `CURRENT_TIMESTAMP` | 更新时间 |

`UNIQUE (season_id, number)` 保证集号在所属季内唯一。v4 已删除 `episode.synopsis`，单集没有简介、年份或题材字段。

### `movie_genre`

| 字段 | PostgreSQL 类型 | 可空 | 默认值 | 约束 / 含义 |
| --- | --- | --- | --- | --- |
| `movie_id` | `uuid` | 否 | — | 外键 → `movie.id`；删除级联；复合主键成员 |
| `genre_id` | `uuid` | 否 | — | 外键 → `genre.id`；删除受限；复合主键成员 |

主键为 `(movie_id, genre_id)`，同一电影不能重复关联同一题材。

### `series_genre`

| 字段 | PostgreSQL 类型 | 可空 | 默认值 | 约束 / 含义 |
| --- | --- | --- | --- | --- |
| `series_id` | `uuid` | 否 | — | 外键 → `series.id`；删除级联；复合主键成员 |
| `genre_id` | `uuid` | 否 | — | 外键 → `genre.id`；删除受限；复合主键成员 |

主键为 `(series_id, genre_id)`，同一剧集不能重复关联同一题材。

## 媒体

### `media_asset`

| 字段 | PostgreSQL 类型 | 可空 | 默认值 | 约束 / 含义 |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | 否 | — | 主键 |
| `storage_key` | `text` | 否 | — | 唯一；`length(storage_key) > 0`；受控相对存储键 |
| `original_name` | `text` | 否 | — | 原始文件名 |
| `mime_type` | `text` | 否 | — | MIME 类型 |
| `byte_size` | `bigint` | 否 | — | `byte_size >= 0` |
| `purpose` | `text` | 否 | — | 仅 `poster`、`video` |
| `checksum_sha256` | `text` | 是 | — | SHA-256 摘要；无格式检查 |
| `created_at` | `timestamptz` | 否 | `CURRENT_TIMESTAMP` | 创建时间 |

数据库不保存文件二进制，也不保存 `local_path`；路径安全和用途与内容槽位的匹配由应用校验，迁移没有相应 CHECK。

### `media_asset_ownership`

| 字段 | PostgreSQL 类型 | 可空 | 默认值 | 约束 / 含义 |
| --- | --- | --- | --- | --- |
| `asset_id` | `uuid` | 否 | — | 主键；外键 → `media_asset.id`；删除级联 |
| `owner_kind` | `text` | 否 | — | 仅 `movie`、`series`、`episode` |
| `owner_id` | `uuid` | 否 | — | 内容 ID；没有指向内容表的外键 |
| `slot` | `text` | 否 | — | 仅 `poster`、`video` |

`asset_id` 主键保证一个媒体资产最多属于一个内容槽位，覆盖电影海报、电影视频、剧集海报和单集视频；`UNIQUE (owner_kind, owner_id, slot)` 保证一个内容槽位最多拥有一个资产。两个取值 CHECK 不单独限制类型与槽位组合，正常记录由下述触发器维护。

## 索引与查询优化

主键与唯一约束产生对应唯一索引，包括关联表复合主键、季号和集号的作用域唯一约束，以及所有权表的主键和槽位唯一约束。

| 显式索引 | 类型与列 / 表达式 | 条件 / 附加列 |
| --- | --- | --- |
| `admin_session_admin_user_idx` | B-tree：`admin_session(admin_user_id)` | 无 |
| `movie_public_published_idx` | B-tree：`movie(published_at DESC, id)` | 已发布且发布时间非空；`INCLUDE (year, poster_asset_id)` |
| `series_public_published_idx` | B-tree：`series(published_at DESC, id)` | 已发布且发布时间非空；`INCLUDE (year, poster_asset_id)` |
| `episode_public_season_idx` | B-tree：`episode(season_id, number, id)` | 已发布且发布时间非空 |
| `movie_name_search_idx` | GIN：`movie(lower(name) public.gin_trgm_ops)` | 已发布且发布时间非空 |
| `movie_synopsis_search_idx` | GIN：`movie(lower(synopsis) public.gin_trgm_ops)` | 已发布且发布时间非空 |
| `series_name_search_idx` | GIN：`series(lower(name) public.gin_trgm_ops)` | 已发布且发布时间非空 |
| `series_synopsis_search_idx` | GIN：`series(lower(synopsis) public.gin_trgm_ops)` | 已发布且发布时间非空 |
| `movie_poster_asset_idx` | B-tree：`movie(poster_asset_id)` | 无 |
| `movie_video_asset_idx` | B-tree：`movie(video_asset_id)` | 无 |
| `series_poster_asset_idx` | B-tree：`series(poster_asset_id)` | 无 |
| `episode_video_asset_idx` | B-tree：`episode(video_asset_id)` | 无 |
| `movie_genre_genre_idx` | B-tree：`movie_genre(genre_id)` | 无 |
| `series_genre_genre_idx` | B-tree：`series_genre(genre_id)` | 无 |

表中“已发布且发布时间非空”的精确谓词是 `status = 'published' AND published_at IS NOT NULL`。v3 在 `public` schema 安装 `pg_trgm` 扩展，四个部分 GIN 索引支持电影与剧集名称、简介的小写搜索；公共目录部分 B-tree 索引支持发布时间排序和季内单集查询。单集索引不能替代应用对父剧集发布状态的可见性校验。

## 所有权触发器

v5 新增所有权表，先从四种现有媒体引用回填，再安装 3 组同步函数和 6 个逐行 `AFTER` 触发器：

| 内容表 | 同步函数 | 写触发器及事件 | 删除触发器 |
| --- | --- | --- | --- |
| `movie` | `sync_movie_media_ownership()` | `movie_media_ownership_write`：`INSERT` 或 `UPDATE OF poster_asset_id, video_asset_id` | `movie_media_ownership_delete`：`DELETE` |
| `series` | `sync_series_media_ownership()` | `series_media_ownership_write`：`INSERT` 或 `UPDATE OF poster_asset_id` | `series_media_ownership_delete`：`DELETE` |
| `episode` | `sync_episode_media_ownership()` | `episode_media_ownership_write`：`INSERT` 或 `UPDATE OF video_asset_id` | `episode_media_ownership_delete`：`DELETE` |

插入时，函数为非空媒体引用写入所有权；更新媒体列时，先按旧内容 ID 删除该内容的全部所有权，再按新引用重建；删除内容时，只删除其所有权。电影函数同步海报与视频，剧集函数只同步海报，单集函数只同步视频。跨内容或跨槽位重复使用资产会违反 `asset_id` 主键，导致本次数据库写入失败。

触发器只维护所有权记录，不删除 `media_asset` 或物理文件。删除和替换媒体的文件处理仍由后端负责。

## 迁移后的变化

| 迁移 | 当前结构中的结果 |
| --- | --- |
| `m20260911_000001_core_schema.rs`（v1） | 建立核心表、字段、外键、检查与唯一约束，以及会话管理员索引 |
| `m20260911_000002_seed_genres.rs`（v2） | 写入 12 个预置题材；不改变表结构 |
| `m20260911_000003_public_catalog_indexes.rs`（v3） | 安装 `pg_trgm`，增加公共目录、搜索及引用查询索引 |
| `m20260912_000004_drop_episode_synopsis.rs`（v4） | 删除 `episode.synopsis` |
| `m20260912_000005_media_ownership.rs`（v5） | 删除 `file_cleanup_job`；新增、回填 `media_asset_ownership`，安装同步函数和触发器 |

v5 升级前检查旧清理队列和重复媒体引用；有待处理清理任务或共享资产时会拒绝升级，须先处理这些数据。`file_cleanup_job` 不属于当前结构，不能继续把它当作正在运行的周期清理队列。v5 用所有权表替换该旧表，因此最终仍为 11 张业务表；所有权表没有对应的 SeaORM entity，核对当前结构应以迁移为准。
