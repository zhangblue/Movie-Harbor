import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { BulkActionDialog } from "./BulkActionDialog";

// 每个确认框用例结束后卸载 Portal，避免对话框焦点和节点影响后续测试。
afterEach(() => cleanup());

const rows = [
  { id: "movie-1", kind: "movie" as const, name: "电影一", status: "published" as const, version: 3, is_private: false, created_at: "2026-01-01", poster_url: null },
];
const genres = [
  { id: "active", name: "剧情", sort_order: 1, enabled: true },
  { id: "inactive", name: "旧题材", sort_order: 2, enabled: false },
];

// 验证添加仅展示启用题材，切换移除后包含停用题材并提交所选标识。
it("filters genre choices by mode and submits the selected genre action", async () => {
  const submit = vi.fn();
  const user = userEvent.setup();
  render(<BulkActionDialog action="genres" rows={rows} genres={genres} pending={false} problems={[]} onClose={() => {}} onSubmit={submit} />);
  const dialog = screen.getByRole("dialog", { name: "批量调整题材" });
  expect(within(dialog).getByLabelText("剧情")).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("旧题材（已停用）")).not.toBeInTheDocument();
  await user.click(within(dialog).getByLabelText("移除题材"));
  await user.click(within(dialog).getByLabelText("旧题材（已停用）"));
  await user.click(within(dialog).getByRole("button", { name: "确认调整题材" }));
  expect(submit).toHaveBeenCalledWith({
    action: "update_genres", mode: "remove", genre_ids: ["inactive"],
    targets: [{ kind: "movie", id: "movie-1", version: 3 }],
  });
});
