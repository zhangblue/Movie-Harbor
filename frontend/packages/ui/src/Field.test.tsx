import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { Field } from "./Field";

// 表单字段测试结束后卸载控件，隔离标签与描述关联。
afterEach(cleanup);

// 验证：表单字段关联标签、帮助文字与控件。
it("associates its label and help text with the control", () => {
  render(
    <Field label="名称" helpText="公开页面显示的名称">
      <input />
    </Field>,
  );
  const input = screen.getByRole("textbox", { name: "名称" });
  expect(input).toHaveAccessibleDescription("公开页面显示的名称");
});

// 验证：显示错误时保留帮助关联并标记控件无效。
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
