import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { ValidationFieldList } from "./ValidationFieldList";

afterEach(cleanup);

test("renders mapped and unknown validation fields in one alert", () => {
  render(<ValidationFieldList fields={["name", "video", "unknown"]} labels={{ name: "名称", video: "可播放视频" }} />);

  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("名称");
  expect(alert).toHaveTextContent("可播放视频");
  expect(alert).toHaveTextContent("unknown");
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
});

test("does not render an alert for an empty field list", () => {
  render(<ValidationFieldList fields={[]} labels={{ name: "名称" }} />);

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
