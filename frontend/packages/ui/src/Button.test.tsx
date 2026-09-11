import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { Button } from "./Button";

afterEach(cleanup);

it("is reached and activated with the keyboard as a native button", async () => {
  const user = userEvent.setup();
  const onClick = vi.fn();
  render(<Button onClick={onClick}>保存草稿</Button>);

  await user.tab();
  expect(screen.getByRole("button", { name: "保存草稿" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(onClick).toHaveBeenCalledOnce();
});

it("exposes danger styling without making color the accessible name", () => {
  render(<Button variant="danger">永久删除</Button>);
  expect(screen.getByRole("button", { name: "永久删除" })).toHaveClass("mh-button--danger");
});

it("defaults to a non-submitting button and honors disabled behavior", async () => {
  const user = userEvent.setup();
  const onClick = vi.fn();
  render(<Button disabled onClick={onClick}>发布</Button>);
  const button = screen.getByRole("button", { name: "发布" });
  expect(button).toHaveAttribute("type", "button");
  expect(button).toBeDisabled();
  await user.click(button);
  expect(onClick).not.toHaveBeenCalled();
});
