import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { Field } from "./Field";

afterEach(cleanup);

it("associates its label and help text with the control", () => {
  render(
    <Field label="名称" helpText="公开页面显示的名称">
      <input />
    </Field>,
  );
  const input = screen.getByRole("textbox", { name: "名称" });
  expect(input).toHaveAccessibleDescription("公开页面显示的名称");
});

it("associates an error and invalid state while keeping help text", () => {
  render(
    <Field label="名称" helpText="最多 120 字" error="请输入名称">
      <input aria-describedby="caller-description" />
    </Field>,
  );
  const input = screen.getByRole("textbox", { name: "名称" });
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input.getAttribute("aria-describedby")).toContain("caller-description");
  expect(input).toHaveAccessibleDescription(/最多 120 字.*请输入名称/);
});
