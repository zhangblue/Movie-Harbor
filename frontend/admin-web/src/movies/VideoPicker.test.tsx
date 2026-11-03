import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { VideoPicker } from "./VideoPicker";

const baseProps = {
  current: null,
  file: new File(["video"], "feature.mp4", { type: "video/mp4" }),
  // 仅检查进度展示时忽略文件选择，避免为无关交互增加断言。
  onSelect: () => {},
  readOnly: false,
  disabled: false,
};

// 测试执行后清理组件及模拟状态，避免影响后续用例。
afterEach(cleanup);

// 验证选中视频上传时显示可计算进度。
it("shows determinate upload progress for a selected video", () => {
  render(<VideoPicker {...baseProps} progress={{ phase: "uploading", percent: 68 }} />);

  expect(screen.getByText("正在上传视频…")).toBeInTheDocument();
  expect(screen.getByText("68%")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "视频上传进度" })).toHaveAttribute("value", "68");
});

// 验证上传总量未知时进度保持不确定。
it("keeps the progress bar indeterminate when upload total is unavailable", () => {
  render(<VideoPicker {...baseProps} progress={{ phase: "uploading", percent: null }} />);

  expect(screen.getByRole("progressbar", { name: "视频上传进度" })).not.toHaveAttribute("value");
  expect(screen.queryByText(/%/)).not.toBeInTheDocument();
});

// 验证上传请求体完成后显示处理状态。
it("shows the processing state after the upload body completes", () => {
  render(<VideoPicker {...baseProps} progress={{ phase: "processing", percent: 100 }} />);

  expect(screen.getByText("上传完成，正在校验并保存…")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "视频上传进度" })).toHaveAttribute("value", "100");
});

// 验证没有进行中的上传时隐藏进度区域。
it("hides the progress region without an active upload", () => {
  render(<VideoPicker {...baseProps} progress={null} />);

  expect(screen.queryByRole("progressbar", { name: "视频上传进度" })).not.toBeInTheDocument();
});

// 验证只读视频不显示文件选择与待上传状态。
it("keeps read-only videos free of file selection and pending uploads", () => {
  render(<VideoPicker {...baseProps} progress={{ phase: "uploading", percent: 68 }} readOnly />);

  expect(screen.queryByLabelText("视频文件")).not.toBeInTheDocument();
  expect(screen.queryByText(/待上传：feature.mp4/)).not.toBeInTheDocument();
  expect(screen.queryByRole("progressbar", { name: "视频上传进度" })).not.toBeInTheDocument();
});
