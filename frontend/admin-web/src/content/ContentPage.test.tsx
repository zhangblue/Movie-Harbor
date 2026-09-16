import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { clearCsrfToken } from "@movie-harbor/api-client";
import { App } from "../app/App";
import {
  adminContentItem,
  adminContentPage,
  deferred,
  json,
  jsonDownload,
  movie,
  server,
  session,
} from "../test/server";
import styles from "../styles.css?raw";

afterEach(() => { cleanup(); clearCsrfToken(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function numberedItems(first: number, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const number = first + index;
    return adminContentItem({ id: `movie-${number}`, name: `内容 ${number}` });
  });
}

function stubDownloadBrowser() {
  const createObjectURL = vi.fn(() => "blob:content-export");
  const revokeObjectURL = vi.fn();
  class DownloadUrl extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  }
  vi.stubGlobal("URL", DownloadUrl);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return { createObjectURL, revokeObjectURL, click };
}

// Catches exporting through a separate control, an untrusted response filename, or retaining object URLs.
it("downloads the content export once from the adjacent title action using the response filename", async () => {
  const browser = stubDownloadBrowser();
  const requests = server((request) => request.url === "/api/admin/contents/export"
    ? jsonDownload({ movies: [] })
    : undefined);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("潮汐尽头");

  const exportButton = screen.getByRole("button", { name: "导出 JSON" });
  const actions = exportButton.parentElement!;
  expect(actions).toHaveClass("admin-title-actions");
  expect(within(actions).getAllByRole("button").map((button) => button.textContent)).toEqual(["导出 JSON", "＋ 新建内容"]);
  await user.click(exportButton);

  expect(browser.createObjectURL).toHaveBeenCalledOnce();
  expect(browser.click).toHaveBeenCalledOnce();
  expect(browser.click.mock.instances[0]).toMatchObject({
    href: "blob:content-export",
    download: "movie-harbor-content-export-20260916-120000.json",
  });
  expect(browser.revokeObjectURL).toHaveBeenCalledWith("blob:content-export");
  expect(requests.filter((request) => request.url === "/api/admin/contents/export")).toHaveLength(1);
});

it("disables a pending export without changing the current list page", async () => {
  stubDownloadBrowser();
  const pending = deferred<Response>();
  const requests = server((request) => {
    if (request.url === "/api/admin/contents?kind=all&page=1") return json(adminContentPage(numberedItems(1, 20), 21, 1));
    if (request.url === "/api/admin/contents?kind=all&page=2") return json(adminContentPage(numberedItems(21, 1), 21, 2));
    if (request.url === "/api/admin/contents/export") return pending.promise;
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("内容 1");
  await user.click(screen.getByRole("button", { name: "第 2 页" }));
  await screen.findByText("内容 21");
  const exportButton = screen.getByRole("button", { name: "导出 JSON" });
  await act(async () => {
    fireEvent.click(exportButton);
    fireEvent.click(exportButton);
  });
  expect(exportButton).toBeDisabled();
  expect(requests.filter((request) => request.url === "/api/admin/contents/export")).toHaveLength(1);
  expect(screen.getByText("内容 21")).toBeInTheDocument();
  expect(screen.getByText("共 21 条 · 第 2/2 页")).toBeInTheDocument();
  await act(async () => { pending.resolve(jsonDownload({ movies: [] })); });
  await screen.findByRole("button", { name: "导出 JSON" });
  expect(requests.filter((request) => request.url.startsWith("/api/admin/contents?"))).toHaveLength(2);
});

it("does not create a download or write export state after unmounting during a pending export", async () => {
  const browser = stubDownloadBrowser();
  const pending = deferred<Response>();
  server((request) => request.url === "/api/admin/contents/export" ? pending.promise : undefined);
  const user = userEvent.setup();
  const view = render(<App />);
  await screen.findByText("潮汐尽头");
  await user.click(screen.getByRole("button", { name: "导出 JSON" }));
  view.unmount();
  await act(async () => { pending.resolve(jsonDownload({ movies: [] })); });
  expect(browser.createObjectURL).not.toHaveBeenCalled();
  expect(browser.revokeObjectURL).not.toHaveBeenCalled();
});

it("expires the session for an unauthorized export and otherwise shows an export-only failure", async () => {
  let status = 401;
  const browser = stubDownloadBrowser();
  server((request) => request.url === "/api/admin/contents/export"
    ? json({ error: status === 401 ? "authentication failed" : "export unavailable" }, status)
    : undefined);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("潮汐尽头");
  await user.click(screen.getByRole("button", { name: "导出 JSON" }));
  await screen.findByRole("heading", { name: "管理员登录" });
  expect(browser.createObjectURL).not.toHaveBeenCalled();

  status = 500;
  render(<App />);
  await screen.findByText("潮汐尽头");
  await user.click(screen.getByRole("button", { name: "导出 JSON" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("内容导出失败，请重试");
  expect(browser.createObjectURL).not.toHaveBeenCalled();
});

// Catches a regression to the two legacy list endpoints or client-only filtering.
it("loads the unified list and submits compact name and dropdown filters to the API", async () => {
  const requests = server((request) => request.url.includes("status=archived")
    ? json(adminContentPage([
      adminContentItem({ id: "series-archived", kind: "series", name: "归档长夜", status: "archived" }),
    ]))
    : undefined);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("潮汐尽头");
  expect(screen.getByText("长夜航线")).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "序号" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "海报" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "潮汐尽头海报" })).toHaveAttribute("src", "/media/poster.webp");
  expect(requests.filter((request) => request.url.startsWith("/api/admin/contents"))).toHaveLength(1);
  expect(requests.some((request) => request.url.startsWith("/api/admin/movies?"))).toBe(false);
  expect(requests.some((request) => request.url.startsWith("/api/admin/series?"))).toBe(false);

  await user.selectOptions(screen.getByLabelText("内容形态"), "series");
  await user.selectOptions(screen.getByLabelText("状态", { exact: true }), "archived");
  await user.type(screen.getByRole("searchbox", { name: "名称" }), "  长夜  ");
  await user.click(screen.getByRole("button", { name: "查询" }));
  await screen.findByText("归档长夜");
  expect(screen.queryByText("潮汐尽头")).not.toBeInTheDocument();
  expect(requests.at(-1)!.url).toBe("/api/admin/contents?kind=series&status=archived&name=%E9%95%BF%E5%A4%9C&page=1");
});

// Catches sequence numbers restarting at one or pagination controls omitting the current page semantics.
it("paginates 21 results and continues the sequence number on page two", async () => {
  const requests = server((request) => {
    if (request.url === "/api/admin/contents?kind=all&page=1") return json(adminContentPage(numberedItems(1, 20), 21, 1));
    if (request.url === "/api/admin/contents?kind=all&page=2") return json(adminContentPage(numberedItems(21, 1), 21, 2));
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("内容 1");
  await user.click(screen.getByRole("button", { name: "第 2 页" }));
  const row = await screen.findByRole("row", { name: /内容 21/ });
  expect(within(row).getByRole("cell", { name: "21" })).toBeInTheDocument();
  expect(screen.getByText("共 21 条 · 第 2/2 页")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "第 2 页" })).toHaveAttribute("aria-current", "page");
  expect(requests.at(-1)!.url).toBe("/api/admin/contents?kind=all&page=2");
});

it("renders actions from the four supported or unknown statuses only", async () => {
  server((request) => request.url.startsWith("/api/admin/contents") ? json(adminContentPage([
    adminContentItem(),
    adminContentItem({ id: "published", name: "已发布电影", status: "published" }),
    adminContentItem({ id: "archived", name: "归档电影", status: "archived" }),
    { ...adminContentItem({ id: "unknown", name: "未知状态" }), status: "unknown" as never },
  ])) : undefined);
  render(<App />);
  expect(within(await screen.findByRole("row", { name: /潮汐尽头/ })).getAllByRole("button").map((button) => button.textContent))
    .toEqual(["编辑", "发布", "永久删除"]);
  expect(within(screen.getByRole("row", { name: /已发布电影/ })).getAllByRole("button").map((button) => button.textContent))
    .toEqual(["查看", "归档"]);
  expect(within(screen.getByRole("row", { name: /归档电影/ })).getAllByRole("button").map((button) => button.textContent))
    .toEqual(["查看", "原样发布", "转为草稿", "永久删除"]);
  expect(within(screen.getByRole("row", { name: /未知状态/ })).queryByRole("button")).not.toBeInTheDocument();
});

// Catches a lifecycle refresh resetting the current page.
it("sends the displayed version on transition and refreshes the current page", async () => {
  let archived = false;
  const requests = server((request) => {
    if (request.url === "/api/admin/series/series-21/archive") {
      archived = true;
      return json(movie({ id: "series-21", name: "第二页剧集", status: "archived", version: 4 }));
    }
    if (request.url === "/api/admin/contents?kind=all&page=1") return json(adminContentPage(numberedItems(1, 20), 21, 1));
    if (request.url === "/api/admin/contents?kind=all&page=2") return json(adminContentPage([
      adminContentItem({ id: "series-21", kind: "series", name: "第二页剧集", status: archived ? "archived" : "published", version: archived ? 4 : 3 }),
    ], 21, 2));
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("内容 1");
  await user.click(screen.getByRole("button", { name: "第 2 页" }));
  await user.click(await screen.findByRole("button", { name: "归档" }));
  await screen.findByRole("button", { name: "原样发布" });
  const mutation = requests.find((request) => request.url.endsWith("/archive"))!;
  expect(mutation.body).toEqual({ version: 3 });
  expect(mutation.method).toBe("POST");
  expect(mutation.headers.get("X-CSRF-Token")).toBe("session-csrf");
  expect(requests.filter((request) => request.url === "/api/admin/contents?kind=all&page=2")).toHaveLength(2);
});

it("locks stale actions on 409 and reloads the current server page", async () => {
  let changed = false;
  server((request) => {
    if (request.url.endsWith("/archive")) { changed = true; return json({ error: "version conflict" }, 409); }
    if (request.url.startsWith("/api/admin/contents")) return json(adminContentPage([
      adminContentItem({ id: "series-1", kind: "series", name: "长夜航线", status: changed ? "archived" : "published", version: changed ? 4 : 3 }),
    ]));
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "归档" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/刷新/);
  expect(screen.getByRole("button", { name: "归档" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "重新加载" }));
  await screen.findByRole("button", { name: "原样发布" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

// Catches an obsolete page request overwriting a newer first-page query.
it("discards an older page response after a newer query has completed", async () => {
  const pending = deferred<Response>();
  server((request) => {
    if (request.url === "/api/admin/contents?kind=all&page=1") return json(adminContentPage(numberedItems(1, 20), 21, 1));
    if (request.url === "/api/admin/contents?kind=all&page=2") return pending.promise;
    if (request.url.includes("name=new") && request.url.endsWith("page=1")) return json(adminContentPage([
      adminContentItem({ name: "新查询结果" }),
    ]));
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("内容 1");
  await user.click(screen.getByRole("button", { name: "第 2 页" }));
  expect(screen.getByText("内容 1")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "第 2 页" })).toBeDisabled();
  const input = screen.getByRole("searchbox", { name: "名称" });
  await user.type(input, "new{Enter}");
  await screen.findByText("新查询结果");
  await act(async () => { pending.resolve(json(adminContentPage([
    adminContentItem({ id: "obsolete", name: "过期第二页" }),
  ], 21, 2))); });
  expect(screen.queryByText("过期第二页")).not.toBeInTheDocument();
  expect(screen.getByText("新查询结果")).toBeInTheDocument();
});

it("returns to login when the latest list reload reports session expiration", async () => {
  let expired = false;
  server((request) => expired && request.url.startsWith("/api/admin/contents")
    ? json({ error: "authentication failed" }, 401)
    : undefined);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("潮汐尽头");
  expired = true;
  await user.click(screen.getByRole("button", { name: "查询" }));
  await screen.findByRole("heading", { name: "管理员登录" });
  expect(screen.queryByRole("button", { name: session.name })).not.toBeInTheDocument();
});

it("keeps pagination in layout A and reserves narrow sequence and action columns", async () => {
  server();
  render(<><style>{styles}</style><App /></>);
  await screen.findByText("潮汐尽头");
  expect(getComputedStyle(screen.getByRole("searchbox", { name: "名称" })).width).toBe("132px");
  const navigation = screen.getByRole("navigation", { name: "内容分页" });
  expect(getComputedStyle(navigation).justifyContent).toBe("space-between");
  expect(getComputedStyle(navigation.querySelector(".content-pagination__controls")!).flexWrap).toBe("wrap");
  const row = screen.getByRole("row", { name: /潮汐尽头/ });
  const sequence = row.querySelector<HTMLElement>(".sequence-cell")!;
  expect(getComputedStyle(sequence).width).toBe("1%");
  expect(getComputedStyle(sequence).whiteSpace).toBe("nowrap");
  const name = within(row).getByRole("rowheader");
  expect(getComputedStyle(name).minWidth).toBe("150px");
  const actionCell = within(row).getByRole("button", { name: "编辑" }).closest("td")!;
  expect(getComputedStyle(actionCell).minWidth).toBe("330px");
  expect(getComputedStyle(actionCell).textAlign).toBe("right");
  expect(getComputedStyle(actionCell).paddingRight).toBe("32px");
  expect(getComputedStyle(actionCell.firstElementChild!).justifyContent).toBe("flex-end");
});

// Catches clearing the old page or moving its summary when the next page request fails.
it("keeps the existing table after a later page fails and recovers on reload", async () => {
  let unavailable = true;
  server((request) => {
    if (request.url === "/api/admin/contents?kind=all&page=1") return json(adminContentPage(numberedItems(1, 20), 21, 1));
    if (request.url === "/api/admin/contents?kind=all&page=2") return unavailable
      ? json({ error: "unavailable" }, 503)
      : json(adminContentPage(numberedItems(21, 1), 21, 2));
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("内容 1");
  await user.click(screen.getByRole("button", { name: "第 2 页" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/加载失败/);
  expect(screen.getByText("内容 1")).toBeInTheDocument();
  expect(screen.getByText("共 21 条 · 第 1/2 页")).toBeInTheDocument();
  unavailable = false;
  await user.click(screen.getByRole("button", { name: "重新加载" }));
  await screen.findByText("内容 21");
  expect(screen.getByText("共 21 条 · 第 2/2 页")).toBeInTheDocument();
});

// Catches a successful deletion leaving the app stranded on an empty out-of-range page.
it("returns from deleting the last row and falls back to the last valid page", async () => {
  let deleted = false;
  const requests = server((request) => {
    if (request.url === "/api/admin/contents?kind=all&page=1") return json(adminContentPage(numberedItems(1, 20), deleted ? 20 : 21, 1));
    if (request.url === "/api/admin/contents?kind=all&page=2") return json(adminContentPage(
      deleted ? [] : [adminContentItem({ id: "movie-21", name: "待删除内容" })],
      deleted ? 20 : 21,
      2,
    ));
    if (request.url === "/api/admin/movies/movie-21" && request.method === "GET") return json(movie({ id: "movie-21", name: "待删除内容" }));
    if (request.url === "/api/admin/movies/movie-21/delete-impact") return json({ name: "待删除内容", version: 3, season_count: 0, episode_count: 0, media_count: 1 });
    if (request.url === "/api/admin/movies/movie-21" && request.method === "DELETE") { deleted = true; return json({ deleted_media_count: 1 }); }
    if (request.url === "/api/admin/genres") return json([]);
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("内容 1");
  await user.click(screen.getByRole("button", { name: "第 2 页" }));
  await user.click(await screen.findByRole("button", { name: "永久删除" }));
  const dialog = await screen.findByRole("dialog", { name: "永久删除电影" });
  await user.type(within(dialog).getByLabelText("输入完整内容名称"), "待删除内容");
  await user.click(within(dialog).getByRole("button", { name: "确认永久删除" }));
  await screen.findByText("内容 1");
  expect(screen.getByText("共 20 条 · 第 1/1 页")).toBeInTheDocument();
  const listRequests = requests.filter((request) => request.url.startsWith("/api/admin/contents"));
  expect(listRequests.slice(-2).map((request) => request.url)).toEqual([
    "/api/admin/contents?kind=all&page=2",
    "/api/admin/contents?kind=all&page=1",
  ]);
});

it("preserves filters and page when returning from a detail view", async () => {
  const requests = server((request) => {
    if (request.url === "/api/admin/contents?kind=all&page=1") return json(adminContentPage(numberedItems(1, 20), 21, 1));
    if (request.url === "/api/admin/contents?kind=movie&page=1") return json(adminContentPage(numberedItems(1, 20), 21, 1));
    if (request.url === "/api/admin/contents?kind=movie&page=2") return json(adminContentPage([
      adminContentItem({ id: "movie-21", name: "查看内容", status: "archived" }),
    ], 21, 2));
    if (request.url === "/api/admin/movies/movie-21") return json(movie({ id: "movie-21", name: "查看内容", status: "archived" }));
    if (request.url === "/api/admin/genres") return json([]);
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("内容 1");
  await user.selectOptions(screen.getByLabelText("内容形态"), "movie");
  await user.click(screen.getByRole("button", { name: "查询" }));
  await user.click(await screen.findByRole("button", { name: "第 2 页" }));
  await user.click(await screen.findByRole("button", { name: "查看" }));
  await screen.findByRole("heading", { name: "查看电影" });
  await user.click(screen.getByRole("button", { name: "返回列表" }));
  await screen.findByText("查看内容");
  expect(screen.getByLabelText("内容形态")).toHaveValue("movie");
  expect(requests.filter((request) => request.url === "/api/admin/contents?kind=movie&page=2")).toHaveLength(2);
});

it("resets a new query from page two to page one", async () => {
  const requests = server((request) => {
    if (request.url === "/api/admin/contents?kind=all&page=1") return json(adminContentPage(numberedItems(1, 20), 21, 1));
    if (request.url === "/api/admin/contents?kind=all&page=2") return json(adminContentPage(numberedItems(21, 1), 21, 2));
    if (request.url.includes("name=fresh") && request.url.endsWith("page=1")) return json(adminContentPage([
      adminContentItem({ name: "第一页新查询" }),
    ]));
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("内容 1");
  await user.click(screen.getByRole("button", { name: "第 2 页" }));
  await user.type(screen.getByRole("searchbox", { name: "名称" }), "fresh{Enter}");
  await screen.findByText("第一页新查询");
  expect(requests.at(-1)!.url).toBe("/api/admin/contents?kind=all&name=fresh&page=1");
});

// Cookie rotation in another tab leaves this tab's in-memory CSRF stale. Recovery must not replay writes.
it("refreshes stale CSRF after a forbidden lifecycle write and requires explicit retries", async () => {
  let token = session.csrf_token;
  let forbidden = true;
  let archived = false;
  const requests = server((request) => {
    if (request.url === "/api/admin/session") return json({ ...session, csrf_token: token });
    if (request.url.endsWith("/archive")) {
      if (forbidden || request.headers.get("X-CSRF-Token") !== token) return json({ error: "request forbidden" }, 403);
      archived = true;
      return json(movie({ status: "archived", version: 4 }));
    }
    if (request.url.startsWith("/api/admin/contents")) return json(adminContentPage([
      adminContentItem({ id: "series-1", kind: "series", name: "长夜航线", status: archived ? "archived" : "published" }),
    ]));
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("长夜航线");
  token = "renewed-csrf";
  await user.click(screen.getByRole("button", { name: "归档" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/重新确认会话.*重新执行/);
  expect(requests.filter((request) => request.url.endsWith("/archive"))).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "归档" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/请求被拒绝.*403/);
  expect(requests.filter((request) => request.url.endsWith("/archive"))).toHaveLength(2);
  forbidden = false;
  await user.click(screen.getByRole("button", { name: "归档" }));
  await screen.findByRole("button", { name: "原样发布" });
  expect(requests.filter((request) => request.url.endsWith("/archive")).map((request) => request.headers.get("X-CSRF-Token")))
    .toEqual(["session-csrf", "renewed-csrf", "renewed-csrf"]);
});

it("ignores an obsolete page request's delayed 401 after a newer query succeeds", async () => {
  const pending = deferred<Response>();
  server((request) => {
    if (request.url === "/api/admin/contents?kind=all&page=1") return json(adminContentPage(numberedItems(1, 20), 21, 1));
    if (request.url === "/api/admin/contents?kind=all&page=2") return pending.promise;
    if (request.url.includes("name=new") && request.url.endsWith("page=1")) return json(adminContentPage([
      adminContentItem({ name: "新查询结果" }),
    ]));
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("内容 1");
  await user.click(screen.getByRole("button", { name: "第 2 页" }));
  await user.type(screen.getByRole("searchbox", { name: "名称" }), "new{Enter}");
  await screen.findByText("新查询结果");
  await act(async () => { pending.resolve(json({ error: "authentication failed" }, 401)); });
  expect(screen.getByText("新查询结果")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "管理员登录" })).not.toBeInTheDocument();
});
