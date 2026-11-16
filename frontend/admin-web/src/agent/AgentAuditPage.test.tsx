import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { listAgentAudit, listAgentAuditAccounts, type AgentTurn } from "@movie-harbor/api-client";
import { AgentAuditPage } from "./AgentAuditPage";

vi.mock("@movie-harbor/api-client", async (load) => ({
  ...await load<typeof import("@movie-harbor/api-client")>(),
  listAgentAudit: vi.fn(),
  listAgentAuditAccounts: vi.fn(),
}));

afterEach(cleanup);

// 验证切换账号后只显示该账号的内容，并把分页游标重置到首页。
test("按账号查看和翻阅对话", async () => {
  const viewer = { id: "same-id", account: "Alice", account_role: "viewer", turn_count: 21 } as const;
  const admin = { id: "same-id", account: "Admin", account_role: "admin", turn_count: 1 } as const;
  const turn: AgentTurn = {
    id: "2", account: "Alice", account_role: "viewer", prompt: "用户问题", reply: "用户回复",
    created_at: "2026-11-16T00:00:00Z",
  };
  vi.mocked(listAgentAuditAccounts).mockResolvedValue([viewer, admin]);
  vi.mocked(listAgentAudit)
    .mockResolvedValueOnce({ items: [turn], next: "2" })
    .mockResolvedValueOnce({ items: [{ ...turn, id: "1", prompt: "较早的问题" }], next: null })
    .mockResolvedValueOnce({ items: [{ ...turn, account: "Admin", account_role: "admin", prompt: "管理员问题" }], next: null });
  render(<AgentAuditPage onExpired={vi.fn()} />);
  await screen.findByText("用户问题");
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await screen.findByText("较早的问题");
  expect(listAgentAudit).toHaveBeenLastCalledWith(viewer, "2");
  // 收起和展开只修改布局，选中账号和当前页无需重新查询。
  fireEvent.click(screen.getByRole("button", { name: "收起用户列表" }));
  expect(screen.queryByRole("button", { name: /Alice/ })).toBeNull();
  expect(screen.getByText("较早的问题")).toBeTruthy();
  expect(screen.getByText("第 2 页")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "展开用户列表" }));
  expect(screen.getByRole("button", { name: /Alice/ }).getAttribute("aria-pressed")).toBe("true");
  expect(listAgentAudit).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: /Admin/ }));
  await screen.findByText("管理员问题");
  expect(screen.queryByText("较早的问题")).toBeNull();
  expect(listAgentAudit).toHaveBeenLastCalledWith(admin, undefined);
});
