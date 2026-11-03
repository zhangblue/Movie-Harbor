import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { Toast } from "./Toast";

// 通知测试结束后卸载组件，避免残留状态消息影响后续断言。
afterEach(cleanup);

// 验证：信息和成功提示使用礼貌的无障碍播报。
it("announces informational and success messages politely", () => {
  const { rerender } = render(<Toast message="草稿已保存" />);
  expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  rerender(<Toast variant="success" message="发布成功" />);
  expect(screen.getByRole("status")).toHaveTextContent("发布成功");
  expect(screen.getByRole("status")).toHaveClass("mh-toast--success");
});

// 验证：错误提示立即播报并将内容作为文本渲染。
it("announces error messages assertively and renders content as text", () => {
  render(<Toast variant="error" message={'失败 <script>alert("x")</script>'} />);
  expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  expect(screen.getByRole("alert")).toHaveTextContent('失败 <script>alert("x")</script>');
  expect(document.querySelector("script")).not.toBeInTheDocument();
});

// 验证：消息为空时不渲染提示。
it("renders nothing for an empty message", () => {
  const { container } = render(<Toast message="" />);
  expect(container).toBeEmptyDOMElement();
});
