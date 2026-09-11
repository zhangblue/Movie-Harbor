import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { clearCsrfToken } from "@movie-harbor/api-client";
import { App } from "../app/App";
import { deferred, json, movie, series, server, session } from "../test/server";
import styles from "../styles.css?raw";

afterEach(() => { cleanup(); clearCsrfToken(); vi.unstubAllGlobals(); });

// Catches wrong kind endpoint selection, local-only filtering, and failure to send the name/status query.
it("loads both kinds and submits compact name and dropdown filters to the API", async () => {
  const requests = server((r) => r.url.includes("status=archived") ? json([series({ name: "归档长夜", status: "archived" })]) : undefined);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("潮汐尽头");
  expect(screen.getByText("长夜航线")).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "海报" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "潮汐尽头海报" })).toHaveAttribute("src", "/media/poster.webp");
  await user.selectOptions(screen.getByLabelText("内容形态"), "series");
  await user.selectOptions(screen.getByLabelText("状态", { exact: true }), "archived");
  await user.type(screen.getByRole("searchbox", { name: "名称" }), "  长夜  ");
  await user.click(screen.getByRole("button", { name: "查询" }));
  await screen.findByText("归档长夜");
  expect(screen.queryByText("潮汐尽头")).not.toBeInTheDocument();
  expect(requests.at(-1)!.url).toBe("/api/admin/series?status=archived&name=%E9%95%BF%E5%A4%9C");
});

it("renders only each server status's legal actions and narrows optional allowed_actions", async () => {
  server((r) => r.url === "/api/admin/movies" ? json([
    movie(), movie({ id: "archived", name: "归档电影", status: "archived" }),
    { ...movie({ id: "limited", name: "限制草稿" }), allowed_actions: ["view", "edit"] },
    { ...movie({ id: "unknown", name: "未知状态" }), status: "unknown", allowed_actions: ["delete"] },
  ]) : undefined);
  render(<App />);
  const draft = within(await screen.findByRole("row", { name: /潮汐尽头/ }));
  expect(draft.getAllByRole("button").map((b) => b.textContent)).toEqual(["编辑", "发布", "永久删除"]);
  const published = within(screen.getByRole("row", { name: /长夜航线/ }));
  expect(published.getAllByRole("button").map((b) => b.textContent)).toEqual(["查看", "归档"]);
  const archived = within(screen.getByRole("row", { name: /归档电影/ }));
  expect(archived.getAllByRole("button").map((b) => b.textContent)).toEqual(["查看", "原样发布", "转为草稿", "永久删除"]);
  expect(within(screen.getByRole("row", { name: /限制草稿/ })).getAllByRole("button").map((b) => b.textContent)).toEqual(["编辑"]);
  expect(within(screen.getByRole("row", { name: /未知状态/ })).queryByRole("button")).not.toBeInTheDocument();
});

it("sends the displayed version on transition and reloads authoritative actions", async () => {
  let archived = false;
  const requests = server((r) => {
    if (r.url === "/api/admin/series/series-1/archive") { archived = true; return json(series({ status: "archived", version: 4 })); }
    if (r.url === "/api/admin/series") return json([series({ status: archived ? "archived" : "published", version: archived ? 4 : 3 })]);
  });
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole("button", { name: "归档" }));
  await screen.findByRole("button", { name: "原样发布" });
  const mutation = requests.find((r) => r.url.endsWith("/archive"))!;
  expect(mutation.body).toEqual({ version: 3 });
  expect(mutation.method).toBe("POST");
  expect(mutation.headers.get("X-CSRF-Token")).toBe("session-csrf");
});

it("locks stale actions on 409 and reloads the server state on explicit refresh", async () => {
  let changed = false;
  server((r) => {
    if (r.url.endsWith("/archive")) { changed = true; return json({ error: "version conflict" }, 409); }
    if (r.url === "/api/admin/series") return json([series({ status: changed ? "archived" : "published", version: changed ? 4 : 3 })]);
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

it("discards an older query response after a newer query has completed", async () => {
  const pending = deferred<Response>();
  server((r) => r.url.includes("name=old") ? pending.promise : r.url.includes("name=new") ? json([movie({ name: "新查询结果" })]) : undefined);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("潮汐尽头");
  await user.selectOptions(screen.getByLabelText("内容形态"), "movie");
  const input = screen.getByRole("searchbox", { name: "名称" });
  await user.type(input, "old{Enter}");
  await user.clear(input);
  await user.type(input, "new{Enter}");
  await screen.findByText("新查询结果");
  await act(async () => { pending.resolve(json([movie({ name: "过期结果" })])); });
  expect(screen.queryByText("过期结果")).not.toBeInTheDocument();
  expect(screen.getByText("新查询结果")).toBeInTheDocument();
});

it("returns to login when a list reload reports session expiration", async () => {
  let expired = false;
  server((r) => expired && r.url.startsWith("/api/admin/movies") ? json({ error: "authentication failed" }, 401) : undefined);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("潮汐尽头");
  expired = true;
  await user.click(screen.getByRole("button", { name: "查询" }));
  await screen.findByRole("heading", { name: "管理员登录" });
  expect(screen.queryByRole("button", { name: session.name })).not.toBeInTheDocument();
});

it("keeps name search compact and aligns action controls with 32px table edge spacing", async () => {
  server();
  render(<><style>{styles}</style><App /></>);
  await screen.findByText("潮汐尽头");
  expect(getComputedStyle(screen.getByRole("searchbox", { name: "名称" })).width).toBe("132px");
  const cell = within(screen.getByRole("row", { name: /潮汐尽头/ })).getByRole("button", { name: "编辑" }).closest("td")!;
  expect(getComputedStyle(cell).textAlign).toBe("right");
  expect(getComputedStyle(cell).paddingRight).toBe("32px");
  expect(getComputedStyle(cell.firstElementChild!).justifyContent).toBe("flex-end");
});

it("shows a recoverable list failure and an accessible empty result", async () => {
  let unavailable = true;
  server((r) => r.url.startsWith("/api/admin/movies") ? unavailable ? json({ error: "unavailable" }, 503) : json([]) : r.url.startsWith("/api/admin/series") ? json([]) : undefined);
  const user = userEvent.setup();
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/加载失败/);
  unavailable = false;
  await user.click(screen.getByRole("button", { name: "重新加载" }));
  expect(await screen.findByRole("status")).toHaveTextContent(/没有匹配/);
});

// Cookie rotation in another tab leaves this tab's in-memory CSRF stale. Recovery must not replay writes.
it("refreshes stale CSRF after a forbidden lifecycle write and requires explicit retries", async () => {
  let token = session.csrf_token;
  let forbidden = true;
  let archived = false;
  const requests = server((r) => {
    if (r.url === "/api/admin/session") return json({ ...session, csrf_token: token });
    if (r.url.endsWith("/archive")) {
      if (forbidden || r.headers.get("X-CSRF-Token") !== token) return json({ error: "request forbidden" }, 403);
      archived = true;
      return json(series({ status: "archived", version: 4 }));
    }
    if (r.url === "/api/admin/series") return json([series({ status: archived ? "archived" : "published" })]);
  });
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("长夜航线");
  token = "renewed-csrf";
  await user.click(screen.getByRole("button", { name: "归档" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/重新确认会话.*重新执行/);
  expect(requests.filter((r) => r.url.endsWith("/archive"))).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "归档" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/请求被拒绝.*403/);
  expect(requests.filter((r) => r.url.endsWith("/archive"))).toHaveLength(2);
  forbidden = false;
  await user.click(screen.getByRole("button", { name: "归档" }));
  await screen.findByRole("button", { name: "原样发布" });
  expect(requests.filter((r) => r.url.endsWith("/archive")).map((r) => r.headers.get("X-CSRF-Token"))).toEqual(["session-csrf", "renewed-csrf", "renewed-csrf"]);
});

it.each(["movies", "series"])("honors a late %s 401 even when the other list fails with 503 first", async (kind) => {
  const pending = deferred<Response>();
  server((r) => r.url === `/api/admin/${kind}` ? pending.promise
    : r.url === `/api/admin/${kind === "movies" ? "series" : "movies"}` ? json({ error: "unavailable" }, 503) : undefined);
  render(<App />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/加载失败/);
  await act(async () => { pending.resolve(json({ error: "authentication failed" }, 401)); });
  await screen.findByRole("heading", { name: "管理员登录" });
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
});

it("ignores an obsolete list's delayed 401 after a newer query succeeds", async () => {
  const pending = deferred<Response>();
  server((r) => r.url.includes("name=old") ? pending.promise : r.url.includes("name=new") ? json([movie({ name: "新查询结果" })]) : undefined);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByText("潮汐尽头");
  await user.selectOptions(screen.getByLabelText("内容形态"), "movie");
  const input = screen.getByRole("searchbox", { name: "名称" });
  await user.type(input, "old{Enter}");
  await user.clear(input);
  await user.type(input, "new{Enter}");
  await screen.findByText("新查询结果");
  await act(async () => { pending.resolve(json({ error: "authentication failed" }, 401)); });
  expect(screen.getByText("新查询结果")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "管理员登录" })).not.toBeInTheDocument();
});
