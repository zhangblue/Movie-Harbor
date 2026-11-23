// 提供后端卷 0 的完整快照，包含非零计数和 RFC 3339 时区偏移。
export const healthyOverview = {
  sampled_at: '2026-11-23T10:00:00.123456+00:00',
  application_version: '1.0.0',
  status: 'healthy',
  counts: {
    movies: { draft: 3, published: 20, archived: 1 },
    series: { draft: 2, published: 8, archived: 0 },
    episodes: { draft: 5, published: 120, archived: 2 },
    viewer_users: 4, active_viewer_users: 2,
    posters: { count: 31, bytes: 84000000 }, videos: { count: 148, bytes: 920000000000 },
  },
  volumes: [{
    number: 0, status: 'healthy', total_bytes: 2000000000000, available_bytes: 1080000000000,
    reserve_bytes: 10737418240, writable_bytes: 1069262581760, accepts_uploads: true,
    asset_count: 179, recorded_asset_bytes: 920084000000,
  }],
  backup: { status: 'unverifiable' },
  warnings: [],
};

// 提供后端采样失败时返回的完整快照，供成功和不一致响应测试复用。
export const unavailableOverview = {
  ...healthyOverview,
  status: 'attention',
  volumes: [{
    ...healthyOverview.volumes[0], status: 'unavailable', total_bytes: null, available_bytes: null,
    writable_bytes: null, accepts_uploads: false,
  }],
  warnings: [{ code: 'storage_capacity_unavailable', scope: 'volume:0', message: '无法读取媒体卷容量' }],
};
