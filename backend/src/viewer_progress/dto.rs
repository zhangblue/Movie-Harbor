use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
/// 区分电影和单集进度目标，供路由参数与批量请求共享。
pub enum PlaybackTargetKind {
    Movie,
    Episode,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
/// 区分电影、单集和整剧删除范围，供墓碑同步使用。
pub enum RemovalTargetKind {
    Movie,
    Episode,
    Series,
}

#[derive(Clone, Debug, Deserialize)]
/// 承载单条播放位置和客户端时间，供 PUT 与批量合并解析。
pub struct ProgressInput {
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub completed: bool,
    pub updated_at: DateTime<FixedOffset>,
}

#[derive(Clone, Debug, Deserialize)]
/// 承载批量播放位置及目标，供合并接口逐项处理。
pub struct ProgressMergeInput {
    pub kind: PlaybackTargetKind,
    pub id: Uuid,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub completed: bool,
    pub updated_at: DateTime<FixedOffset>,
}

#[derive(Clone, Debug, Deserialize)]
/// 承载剧集最近单集及客户端时间，供跨设备游标合并。
pub struct CursorInput {
    pub series_id: Uuid,
    pub episode_id: Uuid,
    pub updated_at: DateTime<FixedOffset>,
}

#[derive(Clone, Debug, Deserialize)]
/// 承载删除目标和原始操作时间，供离线墓碑重试。
pub struct RemovalInput {
    pub kind: RemovalTargetKind,
    pub id: Uuid,
    pub removed_at: DateTime<FixedOffset>,
}

#[derive(Clone, Debug, Deserialize)]
/// 承载单条删除的原始客户端时间，目标由 DELETE 路径提供。
pub struct RemovalRequest {
    pub removed_at: DateTime<FixedOffset>,
}

#[derive(Clone, Debug, Default, Deserialize)]
/// 承载一次批量合并的进度、游标和删除操作。
pub struct MergeRequest {
    #[serde(default)]
    pub progress: Vec<ProgressMergeInput>,
    #[serde(default)]
    pub cursors: Vec<CursorInput>,
    #[serde(default)]
    pub removals: Vec<RemovalInput>,
}

#[derive(Clone, Debug, Serialize)]
/// 返回一条当前有效的规范播放进度，供前端刷新本地缓存。
pub struct ProgressRecord {
    pub kind: PlaybackTargetKind,
    pub id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_id: Option<Uuid>,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub completed: bool,
    pub updated_at: DateTime<FixedOffset>,
}

#[derive(Clone, Debug, Serialize)]
/// 返回一条当前有效的剧集游标，供播放器跨设备定位单集。
pub struct CursorRecord {
    pub series_id: Uuid,
    pub episode_id: Uuid,
    pub updated_at: DateTime<FixedOffset>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
/// 表示单项合并是接受、忽略还是拒绝，供前端清理待同步队列。
pub enum MergeStatus {
    Accepted,
    Ignored,
    Rejected,
}

#[derive(Clone, Debug, Serialize)]
/// 描述单项合并结果及可选拒绝原因，供部分成功批次使用。
pub struct MergeItemResult {
    pub operation: &'static str,
    pub id: Uuid,
    pub status: MergeStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

#[derive(Clone, Debug, Default, Serialize)]
/// 返回当前用户的规范进度、游标和本次逐项结果。
pub struct ProgressSnapshot {
    pub progress: Vec<ProgressRecord>,
    pub cursors: Vec<CursorRecord>,
    pub results: Vec<MergeItemResult>,
}
