import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getAdminSystemOverview, type AdminSystemLifecycleCounts, type AdminSystemOverview, type AdminSystemVolume } from "@movie-harbor/api-client";
import { Button } from "@movie-harbor/ui";

// 汇总一种内容的三个生命周期数量，在资源摘要渲染总数时调用。
function lifecycleTotal(counts: AdminSystemLifecycleCounts): number {
  return counts.draft + counts.published + counts.archived;
}

// 把已知字节格式化为易读的二进制单位，同时让调用方保留原始无障碍数值。
function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = value >= 10 || Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

// 展示易读字节数并保留完整原始值，供屏幕阅读器准确朗读容量。
function ByteValue({ value }: { value: number }) {
  return <span aria-label={`${value} 字节`} title={`${value} 字节`}>{formatBytes(value)}</span>;
}

// 根据文件系统总量与当前可用量计算已使用容量和整数百分比，异常采样返回未知。
function volumeUsage(volume: AdminSystemVolume): { usedBytes: number; percent: number } | null {
  const totalBytes = volume.total_bytes;
  const availableBytes = volume.available_bytes;
  if (totalBytes === null || availableBytes === null || !Number.isFinite(totalBytes) || !Number.isFinite(availableBytes)
    || totalBytes <= 0 || availableBytes < 0 || availableBytes > totalBytes) return null;
  const usedBytes = totalBytes - availableBytes;
  return { usedBytes, percent: Math.round((usedBytes / totalBytes) * 100) };
}

// 渲染媒体卷文件系统使用率；容量未知或异常时只展示未知状态，不伪造进度。
function VolumeUsage({ volume }: { volume: AdminSystemVolume }) {
  const usage = volumeUsage(volume);
  if (!usage || volume.total_bytes === null || volume.available_bytes === null) {
    return <section className="system-usage system-usage--unknown" aria-label="硬盘使用情况">
      <div className="system-usage-heading"><strong>硬盘使用量</strong><span>未知</span></div>
    </section>;
  }
  const valueText = `已使用 ${formatBytes(usage.usedBytes)}，共 ${formatBytes(volume.total_bytes)}，使用率 ${usage.percent}%`;
  return <section className="system-usage" aria-label="硬盘使用情况">
    <div className="system-usage-heading"><strong>硬盘使用量</strong><span>{usage.percent}%</span></div>
    <p>已使用 <ByteValue value={usage.usedBytes} />，共 <ByteValue value={volume.total_bytes} /></p>
    <div className="system-usage-progress" role="progressbar" aria-label="硬盘使用量" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={usage.percent} aria-valuetext={valueText}>
      <span className="system-usage-progress-fill" style={{ width: `${usage.percent}%` }} />
    </div>
    <div className="system-usage-legend"><span>已使用 <ByteValue value={usage.usedBytes} /></span><span>当前可用 <ByteValue value={volume.available_bytes} /></span></div>
  </section>;
}

// 返回后端系统总状态对应的中文文字，不重新推断健康状态。
function overviewStatusLabel(status: AdminSystemOverview["status"]): string {
  return status === "healthy" ? "正常" : "需注意";
}

// 返回后端媒体卷状态对应的中文文字，供文字徽标和无障碍名称共用。
function volumeStatusLabel(status: AdminSystemVolume["status"]): string {
  if (status === "healthy") return "健康";
  if (status === "space_low") return "空间不足";
  return "不可访问";
}

// 格式化服务端采样时间，在概览标题区域说明数据时点。
function sampledAtLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date(value));
}

// 渲染一类内容的总数和生命周期拆分，在资源摘要中复用。
function LifecycleCard({ label, counts }: { label: string; counts: AdminSystemLifecycleCounts }) {
  return <article><span>{label}</span><strong>{lifecycleTotal(counts)}</strong><small>草稿 {counts.draft} · 已发布 {counts.published} · 已归档 {counts.archived}</small></article>;
}

// 渲染媒体卷的容量与上传影响，在系统概览返回卷数据时调用。
function VolumeCard({ volume }: { volume: AdminSystemVolume }) {
  const label = volumeStatusLabel(volume.status);
  return <section className={`system-panel system-volume system-volume--${volume.status}`} aria-label={`媒体卷 ${volume.number}`}>
    <div className="system-panel-heading"><div><p className="eyebrow">MEDIA VOLUME</p><h2>卷 {volume.number}</h2></div>
      <span className="system-status" role="status" aria-label={`卷 ${volume.number} 状态：${label}`}>{label}</span>
    </div>
    <VolumeUsage volume={volume} />
    <dl className="system-facts">
      <div><dt>总容量</dt><dd>{volume.total_bytes === null ? "未知" : <ByteValue value={volume.total_bytes} />}</dd></div>
      <div><dt>当前可用</dt><dd>{volume.available_bytes === null ? "未知" : <ByteValue value={volume.available_bytes} />}</dd></div>
      <div><dt>安全保留</dt><dd><ByteValue value={volume.reserve_bytes} /></dd></div>
      <div><dt>可上传容量</dt><dd>{volume.writable_bytes === null ? "未知" : <ByteValue value={volume.writable_bytes} />}</dd></div>
      <div><dt>媒体资产</dt><dd>{volume.asset_count}</dd></div>
      <div><dt>记录字节</dt><dd><ByteValue value={volume.recorded_asset_bytes} /></dd></div>
    </dl>
    {volume.total_bytes === null && <p className="system-impact">总容量未知，容量暂时无法读取；数据库媒体统计仍可查看。</p>}
    {!volume.accepts_uploads && <p className="system-impact">该卷暂不接受新上传，已有内容读取不因此自动判定为不可用。</p>}
    <p className="system-note">容量与数据库媒体记录的采样时点可能略有不同，数值仅表示当前近似状态。</p>
  </section>;
}

// 管理系统只读概览的加载、刷新和降级展示，在进入“系统设置”时渲染。
export function SystemOverviewPage({ onExpired }: { onExpired: () => void }) {
  const [overview, setOverview] = useState<AdminSystemOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestGeneration = useRef(0);

  // 读取一次新快照；代次检查防止较旧的刷新结果覆盖管理员最后请求的状态。
  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError("");
    try {
      const result = await getAdminSystemOverview();
      if (generation !== requestGeneration.current) return;
      setOverview(result);
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      // 认证失败交给应用身份层；其他错误清除旧快照，避免继续展示过期正常状态。
      setOverview(null);
      if (cause instanceof ApiError && cause.status === 401) onExpired();
      else setError("无法读取系统状态，请检查数据库和媒体存储后重新加载。");
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [onExpired]);

  // 首次进入页面时采样一次，离开页面后使尚未完成的请求失效。
  useEffect(() => {
    void load();
    return () => { requestGeneration.current += 1; };
  }, [load]);

  if (!overview && loading) return <section className="system-loading"><p role="status">正在读取系统状态…</p></section>;
  if (!overview && error) return <section className="system-error"><h1>系统概览</h1><p role="alert">{error}</p><Button onClick={() => { void load(); }}>重新加载</Button></section>;
  if (!overview) return null;

  const statusLabel = overviewStatusLabel(overview.status);
  return <section className="system-overview">
    <div className="admin-title-row system-title-row"><div><p className="eyebrow">SYSTEM OVERVIEW</p><h1>系统概览</h1><p className="title-description">只读展示应用、数据库摘要和媒体存储当前可观察状态。</p></div>
      <Button onClick={() => { void load(); }} aria-busy={loading}>刷新状态</Button>
    </div>
    <section className={`system-hero system-hero--${overview.status}`} aria-label="总体状态">
      <div><span className="system-status" role="status" aria-label={`总体状态：${statusLabel}`}>{statusLabel}</span><strong>版本 {overview.application_version}</strong></div>
      <p>采样时间 {sampledAtLabel(overview.sampled_at)}。此状态不代表公开站、域名、TLS 或宿主机进程监控结果。</p>
      {loading && <p role="status">正在刷新系统状态…</p>}
    </section>
    {overview.warnings.length > 0 && <section className="system-warnings" aria-label="当前告警">
      {overview.warnings.map((warning) => <p key={`${warning.code}:${warning.scope}`} role="alert">{warning.message}</p>)}
    </section>}
    <section className="system-summary" aria-label="资源摘要">
      <LifecycleCard label="电影" counts={overview.counts.movies} />
      <LifecycleCard label="剧集" counts={overview.counts.series} />
      <LifecycleCard label="单集" counts={overview.counts.episodes} />
      <article><span>普通用户</span><strong>{overview.counts.viewer_users}</strong><small>当前有会话 {overview.counts.active_viewer_users}</small></article>
      <article><span>海报</span><strong>{overview.counts.posters.count}</strong><small><ByteValue value={overview.counts.posters.bytes} /></small></article>
      <article><span>视频</span><strong>{overview.counts.videos.count}</strong><small><ByteValue value={overview.counts.videos.bytes} /></small></article>
    </section>
    <div className="system-volumes">{overview.volumes.map((volume) => <VolumeCard key={volume.number} volume={volume} />)}</div>
    <section className="system-panel system-backup" aria-label="备份边界">
      <div className="system-panel-heading"><div><p className="eyebrow">BACKUP BOUNDARY</p><h2>备份与恢复</h2></div><span className="system-status system-status--neutral">备份状态：应用无法验证</span></div>
      <p>Movie Harbor 无法验证宿主机或外部备份系统中的备份是否存在、完整或可恢复。</p>
      <ul><li>完整灾难恢复必须把数据库和全部媒体卷作为同一一致性备份集。</li><li>只备份数据库和部署文件属于升级安全备份，不能称为完整灾备。</li></ul>
      <p className="system-note">详细操作边界请参阅部署资料：<code>docs/guides/media-and-backup.md</code>。生产页面不会打开仓库本地文件或提供环境专用命令。</p>
    </section>
  </section>;
}
