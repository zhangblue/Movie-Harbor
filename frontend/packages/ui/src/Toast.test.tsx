import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { Toast } from "./Toast";

afterEach(cleanup);

it("announces informational and success messages politely", () => {
  const { rerender } = render(<Toast message="草稿已保存" />);
  expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  rerender(<Toast variant="success" message="发布成功" />);
  expect(screen.getByRole("status")).toHaveTextContent("发布成功");
  expect(screen.getByRole("status")).toHaveClass("mh-toast--success");
});

it("announces error messages assertively and renders content as text", () => {
  render(<Toast variant="error" message={'失败 <script>alert("x")</script>'} />);
  expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  expect(screen.getByRole("alert")).toHaveTextContent('失败 <script>alert("x")</script>');
  expect(document.querySelector("script")).not.toBeInTheDocument();
});

it("renders nothing for an empty message", () => {
  const { container } = render(<Toast message="" />);
  expect(container).toBeEmptyDOMElement();
});
