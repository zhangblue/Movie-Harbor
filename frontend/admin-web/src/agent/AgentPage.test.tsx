import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { chatWithAgent, createMovie, listAgentHistory } from "@movie-harbor/api-client";
import { AgentPage } from "./AgentPage";

vi.mock("@movie-harbor/api-client", async (load) => ({
  ...await load<typeof import("@movie-harbor/api-client")>(),
  chatWithAgent: vi.fn(),
  createMovie: vi.fn(),
  listAgentHistory: vi.fn(),
}));

// 验证模型提议仅在管理员确认后创建草稿，并且成功后移除确认按钮。
test("仅确认后才创建电影草稿", async () => {
  vi.mocked(listAgentHistory).mockResolvedValue({ items: [], next: null });
  vi.mocked(chatWithAgent).mockResolvedValue({
    id: "1", reply: "可以创建草稿。",
    draft: { kind: "movie", name: "星际穿越" },
  });
  const onCreated = vi.fn();
  render(<AgentPage onExpired={vi.fn()} onCreated={onCreated} />);
  fireEvent.click(screen.getByRole("button", { name: "影片助手" }));
  const dialog = await screen.findByRole("dialog", { name: "影片助手" });
  expect(dialog.hasAttribute("aria-modal")).toBe(false);
  expect(screen.queryByTestId("dialog-backdrop")).toBeNull();
  const handle = screen.getByRole("button", { name: "移动影片助手" });
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(dialog.style.left).not.toBe("");
  Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() });
  fireEvent(handle, Object.assign(new MouseEvent("pointerdown", { bubbles: true, clientX: 20, clientY: 20 }), { pointerId: 1 }));
  fireEvent(handle, Object.assign(new MouseEvent("pointermove", { bubbles: true, clientX: 110, clientY: 120 }), { pointerId: 1 }));
  fireEvent(handle, Object.assign(new MouseEvent("pointerup", { bubbles: true }), { pointerId: 1 }));
  expect(dialog.style.left).toBe("90px");
  expect(dialog.style.top).toBe("100px");
  fireEvent.change(await screen.findByLabelText("消息"), { target: { value: "创建电影星际穿越" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  const confirm = await screen.findByRole("button", { name: "确认创建草稿" });
  expect(createMovie).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  expect(createMovie).toHaveBeenCalledWith("星际穿越", false);
  await screen.findByText("已创建电影草稿《星际穿越》。");
  expect(onCreated).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "确认创建草稿" })).toBeNull();
});
