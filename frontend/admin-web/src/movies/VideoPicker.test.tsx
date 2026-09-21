import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { VideoPicker } from "./VideoPicker";

const baseProps = {
  current: null,
  file: new File(["video"], "feature.mp4", { type: "video/mp4" }),
  onSelect: () => {},
  readOnly: false,
  disabled: false,
};

afterEach(cleanup);

it("shows determinate upload progress for a selected video", () => {
  render(<VideoPicker {...baseProps} progress={{ phase: "uploading", percent: 68 }} />);

  expect(screen.getByText("正在上传视频…")).toBeInTheDocument();
  expect(screen.getByText("68%")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "视频上传进度" })).toHaveAttribute("value", "68");
});

it("keeps the progress bar indeterminate when upload total is unavailable", () => {
  render(<VideoPicker {...baseProps} progress={{ phase: "uploading", percent: null }} />);

  expect(screen.getByRole("progressbar", { name: "视频上传进度" })).not.toHaveAttribute("value");
  expect(screen.queryByText(/%/)).not.toBeInTheDocument();
});

it("shows the processing state after the upload body completes", () => {
  render(<VideoPicker {...baseProps} progress={{ phase: "processing", percent: 100 }} />);

  expect(screen.getByText("上传完成，正在校验并保存…")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "视频上传进度" })).toHaveAttribute("value", "100");
});

it("hides the progress region without an active upload", () => {
  render(<VideoPicker {...baseProps} progress={null} />);

  expect(screen.queryByRole("progressbar", { name: "视频上传进度" })).not.toBeInTheDocument();
});

it("keeps read-only videos free of file selection and pending uploads", () => {
  render(<VideoPicker {...baseProps} progress={{ phase: "uploading", percent: 68 }} readOnly />);

  expect(screen.queryByLabelText("视频文件")).not.toBeInTheDocument();
  expect(screen.queryByText(/待上传：feature.mp4/)).not.toBeInTheDocument();
  expect(screen.queryByRole("progressbar", { name: "视频上传进度" })).not.toBeInTheDocument();
});
