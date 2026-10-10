import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { clearCsrfToken, setCsrfToken, type ViewerUserPage, type ViewerUserSummary } from "@movie-harbor/api-client";
import { server } from "../test/server";
import { UserPage } from "./UserPage";

afterEach(() => { cleanup(); clearCsrfToken(); vi.unstubAllGlobals(); });

const summer: ViewerUserSummary = { id: "u1", username: "Summer", version: 3, created_at: "2026-10-08T00:00:00Z", last_login_at: null, has_active_session: false };
const robin: ViewerUserSummary = { ...summer, id: "u2", username: "robin", version: 7, last_login_at: "2026-10-10T00:00:00Z", has_active_session: true };
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function page(items = [summer, robin], total = items.length, current = 1): ViewerUserPage {
  return { items, total, page: current, size: 20, summary: { total_users: total, active_users: 1, latest_user: robin } };
}
function setup(handler?: Parameters<typeof server>[0]) {
  setCsrfToken("session-csrf");
  return server((request) => handler?.(request) ?? (request.method === "GET" && request.url.startsWith("/api/admin/users?") ? response(page()) : undefined));
}

// A missing overview or an editable username/role would break the accepted account model.
it("shows global overview and immutable ordinary users with only password and delete actions", async () => {
  setup();
  render(<UserPage onExpired={() => {}} />);
  const overview = await screen.findByRole("region", { name: "用户概览" });
  expect(overview).toHaveTextContent("普通用户2");
  expect(overview).toHaveTextContent("当前有会话1");
  expect(overview).toHaveTextContent("最近添加robin");
  const row = screen.getByRole("row", { name: /Summer/ });
  expect(within(row).getByRole("button", { name: "修改密码" })).toBeInTheDocument();
  expect(within(row).getByRole("button", { name: "删除" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /修改用户名|重置密码|角色|管理员/ })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/角色/)).not.toBeInTheDocument();
  expect(screen.getByText("从未登录")).toBeInTheDocument();
});

// Search must return to page one while the overview stays independent of the filtered result.
it("searches usernames on the server and resets fixed twenty-item pagination", async () => {
  const requests = setup((request) => {
    if (request.url.includes("q=Summer")) return response({ ...page([summer]), summary: page().summary });
    if (request.url.includes("page=2")) return response(page([robin], 21, 2));
    if (request.method === "GET" && request.url.startsWith("/api/admin/users?")) return response(page([summer], 21));
  });
  const user = userEvent.setup();
  render(<UserPage onExpired={() => {}} />);
  await user.click(await screen.findByRole("button", { name: "第 2 页" }));
  await screen.findByRole("row", { name: /robin/ });
  await user.type(screen.getByRole("searchbox", { name: "搜索用户名" }), "Summer");
  await user.keyboard("{Enter}");
  await screen.findByRole("row", { name: /Summer/ });
  expect(requests.at(-1)?.url).toBe("/api/admin/users?q=Summer&page=1&size=20");
  expect(screen.getByRole("region", { name: "用户概览" })).toHaveTextContent("普通用户2");
  expect(screen.getByRole("button", { name: "第 1 页" })).toHaveAttribute("aria-current", "page");
});

// Creating must send only ordinary-account fields and refresh both table and overview.
it("creates a user then refreshes the list and global overview", async () => {
  let created = false;
  const requests = setup((request) => {
    if (request.method === "POST") { created = true; return response({ ...summer, id: "u3", username: "hanmei" }, 201); }
    if (created) return response({ ...page([{ ...summer, username: "hanmei" }], 3), summary: { total_users: 3, active_users: 1, latest_user: { ...summer, username: "hanmei" } } });
  });
  const user = userEvent.setup();
  render(<UserPage onExpired={() => {}} />);
  await screen.findByRole("row", { name: /Summer/ });
  await user.click(screen.getByRole("button", { name: /添加用户/ }));
  const dialog = screen.getByRole("dialog", { name: "添加用户" });
  expect(dialog).toHaveTextContent("用户名创建后不可修改");
  await user.type(within(dialog).getByLabelText("用户名"), " hanmei ");
  await user.type(within(dialog).getByLabelText("初始密码"), "new-password");
  await user.click(within(dialog).getByRole("button", { name: "创建用户" }));
  expect(await screen.findByRole("row", { name: /hanmei/ })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "用户概览" })).toHaveTextContent("普通用户3");
  const mutation = requests.find((request) => request.method === "POST")!;
  expect(mutation.body).toEqual({ username: "hanmei", password: "new-password" });
  expect(mutation.headers.get("X-CSRF-Token")).toBe("session-csrf");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

// The authoritative duplicate error must explain case-insensitive uniqueness without closing the form.
it("explains case-insensitive duplicate usernames returned by the server", async () => {
  setup((request) => request.method === "POST" ? response({ error: "conflict", code: "username_conflict" }, 409) : undefined);
  const user = userEvent.setup();
  render(<UserPage onExpired={() => {}} />);
  await screen.findByRole("row", { name: /Summer/ });
  await user.click(screen.getByRole("button", { name: /添加用户/ }));
  await user.type(screen.getByLabelText("用户名"), "summer");
  await user.type(screen.getByLabelText("初始密码"), "new-password");
  await user.click(screen.getByRole("button", { name: "创建用户" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/用户名已存在.*大小写/);
  expect(screen.getByLabelText("用户名")).toHaveValue("summer");
});

// A stale version or username write on password change must be caught at the real HTTP boundary.
it("changes only the password with the current version and explains session invalidation", async () => {
  let changed = false;
  const requests = setup((request) => {
    if (request.method === "PUT") { changed = true; return response({ ...summer, version: 4 }); }
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (changed) return response(page([{ ...summer, version: 4 }]));
  });
  const user = userEvent.setup();
  render(<UserPage onExpired={() => {}} />);
  await user.click(within(await screen.findByRole("row", { name: /Summer/ })).getByRole("button", { name: "修改密码" }));
  const dialog = screen.getByRole("dialog", { name: "修改密码" });
  expect(dialog).toHaveTextContent(/现有的登录会话会立即失效/);
  expect(within(dialog).getByLabelText("用户名")).toHaveValue("Summer");
  expect(within(dialog).getByLabelText("用户名")).toBeDisabled();
  await user.type(within(dialog).getByLabelText("新密码"), "changed-password");
  await user.click(within(dialog).getByRole("button", { name: "保存新密码" }));
  await screen.findByText(/密码已修改，该用户现有的登录会话已失效/);
  const deleteButton = within(await screen.findByRole("row", { name: /Summer/ })).getByRole("button", { name: "删除" });
  await waitFor(() => expect(deleteButton).toBeEnabled());
  await user.click(deleteButton);
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  expect(requests.find((request) => request.method === "PUT")?.body).toEqual({ version: 3, new_password: "changed-password" });
  expect(requests.find((request) => request.method === "DELETE")?.body).toEqual({ version: 4 });
});

// The first click must never delete; only the dialog's explicit confirmation authorizes the request.
it("requires a second confirmation to delete and refreshes the overview afterwards", async () => {
  let deleted = false;
  const requests = setup((request) => {
    if (request.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
    if (deleted) return response({ ...page([robin]), summary: { total_users: 1, active_users: 1, latest_user: robin } });
  });
  const user = userEvent.setup();
  render(<UserPage onExpired={() => {}} />);
  const open = async () => user.click(within(await screen.findByRole("row", { name: /Summer/ })).getByRole("button", { name: "删除" }));
  await open();
  expect(screen.getByRole("dialog", { name: "删除用户？" })).toHaveTextContent(/Summer.*现有会话.*立即失效.*不可撤销/);
  expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  await open();
  await user.click(screen.getByRole("button", { name: "确认删除" }));
  await screen.findByText("用户已删除。");
  expect(screen.queryByRole("row", { name: /Summer/ })).not.toBeInTheDocument();
  expect(screen.getByRole("region", { name: "用户概览" })).toHaveTextContent("普通用户1");
  expect(requests.find((request) => request.method === "DELETE")?.body).toEqual({ version: 3 });
});

// Conflict must block blind retries, then a reload must acquire the new version before reopening.
it("blocks stale password changes until an explicit reload obtains the latest version", async () => {
  let conflict = false;
  const requests = setup((request) => {
    if (request.method === "PUT") { conflict = true; return response({ error: "conflict", code: "version_conflict" }, 409); }
    if (conflict) return response(page([{ ...summer, version: 9 }]));
  });
  const user = userEvent.setup();
  render(<UserPage onExpired={() => {}} />);
  await user.click(within(await screen.findByRole("row", { name: /Summer/ })).getByRole("button", { name: "修改密码" }));
  await user.type(screen.getByLabelText("新密码"), "new-password");
  await user.click(screen.getByRole("button", { name: "保存新密码" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/用户已发生变化.*重新加载/);
  expect(screen.getByRole("button", { name: "保存新密码" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "重新加载" }));
  await user.click(within(await screen.findByRole("row", { name: /Summer/ })).getByRole("button", { name: "修改密码" }));
  await user.type(screen.getByLabelText("新密码"), "new-password");
  await user.click(screen.getByRole("button", { name: "保存新密码" }));
  expect(requests.filter((request) => request.method === "PUT").at(-1)?.body).toEqual({ version: 9, new_password: "new-password" });
});

it.each(["list", "create", "password", "delete"])("expires the administrator session on a 401 %s response", async (operation) => {
  const expired = vi.fn();
  setup((request) => {
    if ((operation === "list" && request.method === "GET") || (operation === "create" && request.method === "POST") || (operation === "password" && request.method === "PUT") || (operation === "delete" && request.method === "DELETE")) return response({ error: "authentication failed" }, 401);
  });
  const user = userEvent.setup();
  render(<UserPage onExpired={expired} />);
  if (operation !== "list") {
    const row = await screen.findByRole("row", { name: /Summer/ });
    if (operation === "create") {
      await user.click(screen.getByRole("button", { name: /添加用户/ }));
      await user.type(screen.getByLabelText("用户名"), "new-user");
      await user.type(screen.getByLabelText("初始密码"), "new-password");
      await user.click(screen.getByRole("button", { name: "创建用户" }));
    } else if (operation === "password") {
      await user.click(within(row).getByRole("button", { name: "修改密码" }));
      await user.type(screen.getByLabelText("新密码"), "new-password");
      await user.click(screen.getByRole("button", { name: "保存新密码" }));
    } else {
      await user.click(within(row).getByRole("button", { name: "删除" }));
      await user.click(screen.getByRole("button", { name: "确认删除" }));
    }
  }
  await vi.waitFor(() => expect(expired).toHaveBeenCalledOnce());
});
