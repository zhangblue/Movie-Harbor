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

it("does not reset focus when an inline onClose callback changes during a parent rerender", () => {
  const firstClose = vi.fn();
  const secondClose = vi.fn();
  const { rerender } = render(
    <>
      <button>打开编辑器</button>
      <Dialog open={false} title="编辑" onClose={() => firstClose()}>内容</Dialog>
    </>,
  );
  const opener = screen.getByRole("button", { name: "打开编辑器" });
  const focusSpy = vi.spyOn(opener, "focus");
  opener.focus();
  focusSpy.mockClear();

  rerender(
    <>
      <button>打开编辑器</button>
      <Dialog open title="编辑" onClose={() => firstClose()}>
        <input aria-label="第一个字段" />
        <input aria-label="第二个字段" />
      </Dialog>
    </>,
  );
  screen.getByRole("textbox", { name: "第二个字段" }).focus();

  rerender(
    <>
      <button>打开编辑器</button>
      <Dialog open title="编辑" onClose={() => secondClose()}>
        <input aria-label="第一个字段" />
        <input aria-label="第二个字段" />
      </Dialog>
    </>,
  );
  expect(screen.getByRole("textbox", { name: "第二个字段" })).toHaveFocus();
  expect(focusSpy).not.toHaveBeenCalled();

  rerender(
    <>
      <button>打开编辑器</button>
      <Dialog open={false} title="编辑" onClose={() => secondClose()}>内容</Dialog>
    </>,
  );
  expect(opener).toHaveFocus();
  expect(focusSpy).toHaveBeenCalledOnce();
});

it("skips hidden, inert, aria-hidden, disabled, and negative-tabindex controls", () => {
  render(
    <Dialog open title="筛选焦点" onClose={() => undefined}>
      <input type="hidden" />
      <div hidden><button>hidden ancestor</button></div>
      <div inert><button>inert ancestor</button></div>
      <div aria-hidden="true"><button>aria-hidden ancestor</button></div>
      <button disabled>disabled</button>
      <fieldset disabled><button>disabled fieldset descendant</button></fieldset>
      <button tabIndex={-1}>negative tabindex</button>
      <input aria-label="第一个可用字段" />
    </Dialog>,
  );
  expect(screen.getByRole("textbox", { name: "第一个可用字段" })).toHaveFocus();
});

it("skips controls hidden by their own or an ancestor's computed style", () => {
  render(
    <Dialog open title="样式可见性" onClose={() => undefined}>
      <button style={{ display: "none" }}>display none</button>
      <div style={{ visibility: "hidden" }}><button>visibility hidden ancestor</button></div>
      <button>可见按钮</button>
    </Dialog>,
  );
  expect(screen.getByRole("button", { name: "可见按钮" })).toHaveFocus();
});

it("uses browser tab order rather than DOM order for positive tabindex values", () => {
  render(
    <Dialog open title="显式顺序" onClose={() => undefined}>
      <button tabIndex={2}>第二顺位</button>
      <button tabIndex={1}>第一顺位</button>
      <button>普通顺位</button>
    </Dialog>,
  );
  expect(screen.getByRole("button", { name: "第一顺位" })).toHaveFocus();
});

it("moves focus back inside when Tab starts outside the panel", async () => {
  const user = userEvent.setup();
  render(
    <>
      <button>对话框前</button>
      <Dialog open title="焦点边界" onClose={() => undefined}>
        <button>第一个</button>
        <button>最后一个</button>
      </Dialog>
    </>,
  );
  const after = document.createElement("button");
  after.textContent = "对话框后";
  document.body.append(after);
  try {
    after.focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "第一个" })).toHaveFocus();

    screen.getByRole("button", { name: "对话框前" }).focus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "关闭焦点边界" })).toHaveFocus();
  } finally {
    after.remove();
  }
});

it("keeps Tab on the close control when the dialog body has no tabbable content", async () => {
  const user = userEvent.setup();
  render(<Dialog open title="空对话框" onClose={() => undefined}><p>仅说明文字</p></Dialog>);
  const close = screen.getByRole("button", { name: "关闭空对话框" });
  expect(close).toHaveFocus();
  await user.tab();
  expect(close).toHaveFocus();
  await user.tab({ shift: true });
  expect(close).toHaveFocus();
});
