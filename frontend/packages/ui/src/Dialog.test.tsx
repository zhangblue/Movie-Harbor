import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { Dialog } from "./Dialog";

afterEach(cleanup);

it("has modal semantics, an accessible title, and focuses the first control", () => {
  render(
    <Dialog open title="删除确认" onClose={() => undefined}>
      <input aria-label="输入内容名称" />
    </Dialog>,
  );
  expect(screen.getByRole("dialog", { name: "删除确认" })).toHaveAttribute("aria-modal", "true");
  expect(screen.getByRole("textbox", { name: "输入内容名称" })).toHaveFocus();
});

it("closes on Escape and restores focus to the opener", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const { rerender } = render(
    <>
      <button>打开详情</button>
      <Dialog open={false} title="详情" onClose={onClose}>内容</Dialog>
    </>,
  );
  const opener = screen.getByRole("button", { name: "打开详情" });
  opener.focus();
  rerender(
    <>
      <button>打开详情</button>
      <Dialog open title="详情" onClose={onClose}>内容</Dialog>
    </>,
  );
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
  rerender(
    <>
      <button>打开详情</button>
      <Dialog open={false} title="详情" onClose={onClose}>内容</Dialog>
    </>,
  );
  expect(opener).toHaveFocus();
});

it("closes only when the backdrop itself is pressed", () => {
  const onClose = vi.fn();
  render(<Dialog open title="详情" onClose={onClose}><p>正文</p></Dialog>);
  fireEvent.mouseDown(screen.getByText("正文"));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.mouseDown(screen.getByTestId("dialog-backdrop"));
  expect(onClose).toHaveBeenCalledOnce();
});

it("cycles keyboard focus within the modal", async () => {
  const user = userEvent.setup();
  render(
    <Dialog open title="选择" onClose={() => undefined}>
      <button>第一个</button>
      <button>第二个</button>
    </Dialog>,
  );
  expect(screen.getByRole("button", { name: "第一个" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "第二个" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "关闭选择" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "第一个" })).toHaveFocus();
});
