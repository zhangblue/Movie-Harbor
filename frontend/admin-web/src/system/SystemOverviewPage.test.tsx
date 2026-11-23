import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminSystemOverview } from "@movie-harbor/api-client";
import { deferred, server } from "../test/server";
import { SystemOverviewPage } from "./SystemOverviewPage";

// 系统概览用例结束后清理页面和网络替身，避免请求状态影响其他测试。
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// 构造可覆盖的系统概览，在页面测试准备不同容量状态时调用。
function overview(overrides: Partial<AdminSystemOverview> = {}): AdminSystemOverview {
  return {
    sampled_at: "2026-11-23T10:00:00+08:00",
    application_version: "1.2.3",
    status: "healthy",
    counts: {
      movies: { draft: 1, published: 2, archived: 3 },
      series: { draft: 4, published: 5, archived: 6 },
      episodes: { draft: 7, published: 8, archived: 9 },
      viewer_users: 10,
      active_viewer_users: 2,
      posters: { count: 11, bytes: 1_024 },
      videos: { count: 12, bytes: 1_073_741_824 },
    },
    volumes: [{
      number: 0,
      status: "healthy",
      total_bytes: 2_147_483_648,
      available_bytes: 1_073_741_824,
      reserve_bytes: 536_870_912,
      writable_bytes: 536_870_912,
      accepts_uploads: true,
      asset_count: 23,
      recorded_asset_bytes: 1_073_742_848,
    }],
    backup: { status: "unverifiable" },
    warnings: [],
    ...overrides,
  };
}

// 构造系统概览 HTTP 响应，在模拟只读接口结果时调用。
function response(body: AdminSystemOverview | { error: string }, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// 页面必须明确展示加载、正常摘要、完整字节无障碍文本和备份能力边界。
// 验证首次加载后渲染只读系统概览且不提供任何运维写操作。
it("loads and renders the readable system summary with accessible status and backup limits", async () => {
  const pending = deferred<Response>();
  server((request) => request.url === "/api/admin/system/overview" ? pending.promise : undefined);
  render(<SystemOverviewPage onExpired={() => {}} />);

  expect(screen.getByRole("status")).toHaveTextContent("正在读取系统状态");
  pending.resolve(response(overview()));

  expect(await screen.findByRole("heading", { name: "系统概览" })).toBeInTheDocument();
  expect(screen.getByRole("status", { name: "总体状态：正常" })).toHaveTextContent("正常");
  const summary = screen.getByRole("region", { name: "资源摘要" });
  expect(summary).toHaveTextContent("电影6");
  expect(summary).toHaveTextContent("普通用户10");
  expect(within(summary).getByLabelText("1024 字节")).toHaveTextContent("1 KiB");
  expect(within(summary).getByLabelText("1073741824 字节")).toHaveTextContent("1 GiB");
  expect(screen.getByRole("region", { name: "备份边界" })).toHaveTextContent("备份状态：应用无法验证");
  expect(screen.getByRole("region", { name: "备份边界" })).toHaveTextContent("数据库和全部媒体卷作为同一一致性备份集");
  expect(screen.getByRole("region", { name: "备份边界" })).toHaveTextContent("docs/guides/media-and-backup.md");
  expect(screen.queryByRole("button", { name: /备份|恢复|清理|检查更新|迁移|重启/ })).not.toBeInTheDocument();
});

// 容量不足与无法采样都必须由文字说明影响，不能只依靠颜色或伪造零容量。
// 验证低空间和容量未知状态保留后端判定及可上传影响。
it.each([
  ["space_low", "空间不足", 10, "该卷暂不接受新上传"],
  ["unavailable", "不可访问", null, "容量暂时无法读取"],
] as const)("renders the %s volume state without re-deriving capacity", async (status, label, totalBytes, detail) => {
  server((request) => request.url === "/api/admin/system/overview" ? response(overview({
    status: "attention",
    volumes: [{
      ...overview().volumes[0]!,
      status,
      total_bytes: totalBytes,
      available_bytes: totalBytes,
      writable_bytes: totalBytes,
      accepts_uploads: false,
    }],
    warnings: [{ code: status === "space_low" ? "storage_space_low" : "storage_capacity_unavailable", scope: "volume:0", message: "卷状态需要关注" }],
  })) : undefined);
  render(<SystemOverviewPage onExpired={() => {}} />);

  const volume = await screen.findByRole("region", { name: "媒体卷 0" });
  expect(within(volume).getByRole("status", { name: `卷 0 状态：${label}` })).toBeInTheDocument();
  expect(volume).toHaveTextContent(detail);
  if (totalBytes === null) expect(volume).toHaveTextContent("总容量未知");
  expect(screen.getByRole("alert")).toHaveTextContent("卷状态需要关注");
});

// 刷新失败后保留旧徽标会让管理员误信过期状态，重试必须从空错误页重新采样。
// 验证刷新失败清除旧概览，并允许重新加载成功。
it("clears stale facts after a failed refresh and reloads on retry", async () => {
  let call = 0;
  server((request) => {
    if (request.url !== "/api/admin/system/overview") return undefined;
    call += 1;
    if (call === 1) return response(overview());
    if (call === 2) return response({ error: "database unavailable" }, 500);
    return response(overview({ application_version: "2.0.0" }));
  });
  const user = userEvent.setup();
  render(<SystemOverviewPage onExpired={() => {}} />);
  await screen.findByText("版本 1.2.3");

  await user.click(screen.getByRole("button", { name: "刷新状态" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("无法读取系统状态");
  expect(screen.queryByText("版本 1.2.3")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "重新加载" }));
  expect(await screen.findByText("版本 2.0.0")).toBeInTheDocument();
});

// 多次手动刷新可能乱序完成，只有最新请求可以更新当前采样结果。
// 验证请求代次阻止较早刷新覆盖较新的系统状态。
it("keeps the newest manual refresh when requests finish out of order", async () => {
  const older = deferred<Response>();
  const newer = deferred<Response>();
  let call = 0;
  server((request) => {
    if (request.url !== "/api/admin/system/overview") return undefined;
    call += 1;
    if (call === 1) return response(overview());
    return call === 2 ? older.promise : newer.promise;
  });
  const user = userEvent.setup();
  render(<SystemOverviewPage onExpired={() => {}} />);
  await screen.findByText("版本 1.2.3");

  const refresh = screen.getByRole("button", { name: "刷新状态" });
  await user.click(refresh);
  await user.click(refresh);
  newer.resolve(response(overview({ application_version: "3.0.0" })));
  expect(await screen.findByText("版本 3.0.0")).toBeInTheDocument();
  older.resolve(response(overview({ application_version: "2.0.0" })));
  await waitFor(() => expect(screen.queryByText("版本 2.0.0")).not.toBeInTheDocument());
});

