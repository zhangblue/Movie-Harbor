import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { clearCsrfToken, setCsrfToken, type JsonValue, type ViewerUserPage, type ViewerUserSummary } from "@movie-harbor/api-client";
import { server } from "../test/server";
import { UserPage } from "./UserPage";

// 测试执行后清理组件及模拟状态，避免影响后续用例。
afterEach(() => { cleanup(); clearCsrfToken(); vi.unstubAllGlobals(); });

const summer: ViewerUserSummary = { id: "u1", username: "Summer", version: 3, created_at: "2026-10-08T00:00:00Z", last_login_at: null, has_active_session: false };
const robin: ViewerUserSummary = { ...summer, id: "u2", username: "robin", version: 7, last_login_at: "2026-10-10T00:00:00Z", has_active_session: true };
// 构造用户接口模拟响应，在用户管理测试准备数据时调用。
function response(body: JsonValue | ViewerUserPage | ViewerUserSummary, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
// 构造用户分页响应，在用户管理测试准备数据时调用。
function page(items = [summer, robin], total = items.length, current = 1): ViewerUserPage {
  return { items, total, page: current, size: 20, summary: { total_users: total, active_users: 1, latest_user: robin } };
}
// 设置会话 CSRF 令牌并安装用户模拟服务，在用户管理测试渲染页面前调用。
function setup(handler?: Parameters<typeof server>[0]) {
  setCsrfToken("session-csrf");
  return server((request) => handler?.(request) ?? (request.method === "GET" && request.url.startsWith("/api/admin/users?") ? response(page()) : undefined));
}

// 缺少概览或允许修改用户名和角色都会破坏已确认的账号模型。
// 验证展示全局概览及仅能改密或删除的普通用户。
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

// 搜索必须返回第一页，且全局概览不受筛选结果影响。
// 验证服务端搜索用户名并重置每页二十项的分页。
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

// FEFF 必须仍可搜索；按照服务端 Unicode 规则，NEL 属于空白。
// 验证搜索 Unicode 用户名时遵循创建账号的归一化规则。
it.each([
  ["\u0085Summer\u0085", "Summer"],
  ["\uFEFFSummer\uFEFF", "\uFEFFSummer\uFEFF"],
])("searches Unicode usernames using the same normalization as account creation: %s", async (input, normalized) => {
  const requests = setup();
  render(<UserPage onExpired={() => {}} />);
  await screen.findByRole("row", { name: /Summer/ });
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索用户名" }), { target: { value: input } });
  fireEvent.submit(screen.getByRole("search"));
  await waitFor(() => expect(requests.at(-1)?.url).toBe(`/api/admin/users?q=${encodeURIComponent(normalized)}&page=1&size=20`));
});

// 创建请求只能包含普通账号字段，并需同时刷新表格和概览。
// 验证创建用户后刷新列表与全局概览。
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

// 检查客户端是否错误拒绝或改写服务端接受的凭据。
// 验证用户名和密码按服务端规则处理 Unicode 空白并保留 FEFF。
it("normalizes Unicode White_Space like the server while preserving FEFF in usernames and passwords", async () => {
  const requests = setup((request) => request.method === "POST" ? response({ ...summer, version: 4 }) : undefined);
  const user = userEvent.setup();
  render(<UserPage onExpired={() => {}} />);
  await screen.findByRole("row", { name: /Summer/ });
  await user.click(screen.getByRole("button", { name: /添加用户/ }));
  fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "\u0085\uFEFFSummer\uFEFF\u0085" } });
  fireEvent.change(screen.getByLabelText("初始密码"), { target: { value: "\uFEFF".repeat(8) } });
  fireEvent.submit(screen.getByLabelText("初始密码").closest("form")!);
  await screen.findByText("用户已添加。");
  expect(requests.find((request) => request.method === "POST")?.body).toEqual({ username: "\uFEFFSummer\uFEFF", password: "\uFEFF".repeat(8) });
});

// 防止以 UTF-16 代码单元计数，错误接受不足八字符的普通用户密码。
// 验证创建和改密均拒绝七字符密码并接受八字符密码。
it.each(["create", "password"])("rejects seven-character %s passwords and accepts exactly eight", async (mode) => {
  const requests = setup((request) => request.method === "POST" || request.method === "PUT" ? response({ ...summer, version: 4 }) : undefined);
  const user = userEvent.setup();
  render(<UserPage onExpired={() => {}} />);
  const row = await screen.findByRole("row", { name: /Summer/ });
  await user.click(mode === "create" ? screen.getByRole("button", { name: /添加用户/ }) : within(row).getByRole("button", { name: "修改密码" }));
  if (mode === "create") await user.type(screen.getByLabelText("用户名"), "new-user");
  const input = screen.getByLabelText(mode === "create" ? "初始密码" : "新密码");
  const form = input.closest("form")!;
  for (const password of ["1234567", "😀😀😀😀😀😀😀"]) {
    fireEvent.change(input, { target: { value: password } });
    fireEvent.submit(form);
    expect(screen.queryByRole("alert")).toHaveTextContent("密码至少需要 8 个字符。");
    expect(requests.some((request) => request.method === "POST" || request.method === "PUT")).toBe(false);
  }
  fireEvent.change(input, { target: { value: "12345678" } });
  fireEvent.submit(form);
  await screen.findByText(mode === "create" ? "用户已添加。" : "密码已修改，该用户现有的登录会话已失效。");
  expect(requests.find((request) => request.method === (mode === "create" ? "POST" : "PUT"))?.body).toEqual(mode === "create" ? { username: "new-user", password: "12345678" } : { version: 3, new_password: "12345678" });
});

// 防止将后端本地化校验错误误报为网络故障。
// 验证创建和改密时保留后端本地化密码错误。
it.each(["create", "password"])("preserves the localized backend password error for %s", async (mode) => {
  setup((request) => request.method === "POST" || request.method === "PUT" ? response({ error: "密码至少需要 8 个字符。" }, 400) : undefined);
  const user = userEvent.setup();
  render(<UserPage onExpired={() => {}} />);
  const row = await screen.findByRole("row", { name: /Summer/ });
  await user.click(mode === "create" ? screen.getByRole("button", { name: /添加用户/ }) : within(row).getByRole("button", { name: "修改密码" }));
  if (mode === "create") await user.type(screen.getByLabelText("用户名"), "new-user");
  await user.type(screen.getByLabelText(mode === "create" ? "初始密码" : "新密码"), "12345678");
  await user.click(screen.getByRole("button", { name: mode === "create" ? "创建用户" : "保存新密码" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("密码至少需要 8 个字符。");
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

// 服务端报告重名时应解释不区分大小写的唯一性，并保持表单打开。
// 验证解释服务端返回的不区分大小写用户名冲突。
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

// 在真实 HTTP 请求边界检查改密时是否误用旧版本或写入用户名。
// 验证使用当前版本仅修改密码并解释会话失效。
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

// 第一次点击不得删除，只有弹窗中的明确确认才发起请求。
// 验证删除要求二次确认并在完成后刷新概览。
it("requires a second confirmation to delete and refreshes the overview afterwards", async () => {
  let deleted = false;
  const requests = setup((request) => {
    if (request.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
    if (deleted) return response({ ...page([robin]), summary: { total_users: 1, active_users: 1, latest_user: robin } });
  });
  const user = userEvent.setup();
  render(<UserPage onExpired={() => {}} />);
  // 打开目标用户的删除确认框，在删除测试中重复进入确认步骤时调用。
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

// 冲突必须阻止盲目重试，重新打开前须刷新并取得新版本。
// 验证版本过期时阻止改密直至明确刷新。
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

// 验证用户管理各操作收到 401 时使管理员会话失效。
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
