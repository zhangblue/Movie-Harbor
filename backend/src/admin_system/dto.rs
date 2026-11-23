use serde::Serialize;

/// 表示电影、剧集或单集按生命周期拆分的数量。
#[derive(Debug, Serialize)]
pub struct LifecycleCounts {
    pub draft: u64,
    pub published: u64,
    pub archived: u64,
}

/// 表示一种媒体用途的记录数量和数据库声明字节数。
#[derive(Debug, Serialize)]
pub struct AssetCounts {
    pub count: u64,
    pub bytes: u64,
}

/// 承载系统概览的全部数据库摘要，供管理页面一次读取。
#[derive(Debug, Serialize)]
pub struct OverviewCounts {
    pub movies: LifecycleCounts,
    pub series: LifecycleCounts,
    pub episodes: LifecycleCounts,
    pub viewer_users: u64,
    pub active_viewer_users: u64,
    pub posters: AssetCounts,
    pub videos: AssetCounts,
}

/// 表示当前单媒体卷的可观察容量和上传接受状态。
#[derive(Debug, Serialize)]
pub struct VolumeOverview {
    pub number: u32,
    pub status: &'static str,
    pub total_bytes: Option<u64>,
    pub available_bytes: Option<u64>,
    pub reserve_bytes: u64,
    pub writable_bytes: Option<u64>,
    pub accepts_uploads: bool,
    pub asset_count: u64,
    pub recorded_asset_bytes: u64,
}

/// 表示系统概览中的稳定、非敏感告警。
#[derive(Debug, Serialize)]
pub struct OverviewWarning {
    pub code: &'static str,
    pub scope: &'static str,
    pub message: &'static str,
}

/// 表示应用不能验证外部备份的固定边界。
#[derive(Debug, Serialize)]
pub struct BackupOverview {
    pub status: &'static str,
}

/// 承载管理员只读系统概览响应。
#[derive(Debug, Serialize)]
pub struct SystemOverview {
    pub sampled_at: String,
    pub application_version: &'static str,
    pub status: &'static str,
    pub counts: OverviewCounts,
    pub volumes: Vec<VolumeOverview>,
    pub backup: BackupOverview,
    pub warnings: Vec<OverviewWarning>,
}
