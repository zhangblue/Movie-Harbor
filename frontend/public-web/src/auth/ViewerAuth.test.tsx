import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearCsrfToken } from "@movie-harbor/api-client";
import { App } from "../app/App";
import { deferred, json, movie, movieCard, series, seriesCard } from "../test/fixtures";

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); clearCsrfToken(); window.history.replaceState(null, "", "/"); });

// 认证测试时创建可控制登录状态的模拟服务。
function server(initial = false) {
  const state = { authenticated: initial, username: "Summer", csrfToken: "viewer-csrf", sessionNetworkError: false, loginStatus: 200, passwordStatus: 204, logoutStatus: 204,
    requests: [] as Array<{ url: URL; init?: RequestInit }>, catalogTotal: undefined as number | undefined, catalogResponse: undefined as Promise<Response> | undefined,
    sessionResponse: undefined as Promise<Response> | undefined, writeResponse: undefined as Promise<Response> | undefined };
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    state.requests.push({ url, init });
    if (url.pathname === "/api/viewer/session") {
      if (state.sessionResponse) return state.sessionResponse;
      if (state.sessionNetworkError) throw new TypeError("network unavailable");
      return state.authenticated ? json({ username: state.username, csrf_token: state.csrfToken }) : json({ error: "未登录" }, 401);
    }
    if (url.pathname === "/api/viewer/login") {
      if (state.loginStatus !== 200) return json({ error: "account missing internal details" }, state.loginStatus);
      state.authenticated = true;
      state.username = JSON.parse(String(init?.body)).username;
      return json({ username: state.username });
    }
    if (url.pathname === "/api/viewer/logout") {
      if (state.writeResponse) return state.writeResponse;
      if (new Headers(init?.headers).get("x-csrf-token") !== state.csrfToken) return json({}, 403);
      if (state.logoutStatus !== 204) return json({}, state.logoutStatus);
      state.authenticated = false; return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/viewer/password") {
      if (state.writeResponse) return state.writeResponse;
      if (new Headers(init?.headers).get("x-csrf-token") !== state.csrfToken) return json({}, 403);
      if (state.passwordStatus !== 204) return json({ error: "当前密码不正确" }, state.passwordStatus);
      state.authenticated = false;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/catalog") {
      const privateOnly = url.searchParams.get("privacy") === "private";
      const authenticatedItems = privateOnly ? [{ ...seriesCard, is_private: true }] : [movieCard, { ...seriesCard, is_private: true }];
      return state.catalogResponse ?? json({
        items: state.authenticated ? authenticatedItems : [movieCard],
        total: state.catalogTotal ?? (state.authenticated ? authenticatedItems.length : 1), page: Number(url.searchParams.get("page") ?? 1), size: 20,
      });
    }
    if (url.pathname.includes("/movies/")) return state.authenticated ? json({ ...movie, is_private: true }) : json({}, 404);
    if (url.pathname.includes("/series/")) return state.authenticated ? json({ ...series, is_private: true }) : json({}, 404);
    return json({}, 404);
  });
  return state;
}

// 在认证测试中填写并提交普通用户登录表单，返回模拟用户供后续操作。
async function login(username = "Summer") {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "登录" }));
  const dialog = screen.getByRole("dialog", { name: "登录" });
  await user.type(within(dialog).getByLabelText("用户名"), username);
  await user.type(within(dialog).getByLabelText("密码", { exact: true }), "old-password");
  await user.click(within(dialog).getByRole("button", { name: "登录" }));
  return user;
}

// 验证：初始会话返回 401 时匿名目录仍可使用。
it("keeps the anonymous catalog usable when the initial session returns 401", async () => {
  const state = server(); render(<App />);
  expect(await screen.findByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "登录" })).toBeEnabled();
  expect(state.requests.some(({ url }) => url.pathname === "/api/viewer/session")).toBe(true);
  expect(screen.queryByText("私密")).not.toBeInTheDocument();
});

// 验证：焦点触发匿名身份发现失败时保持退出状态且不打扰访客。
it.each(["401", "network error"] as const)("silently keeps an anonymous viewer signed out when focus discovery has a %s", async (failure) => {
  const state = server(); render(<App />);
  await screen.findByRole("link", { name: "查看远方来信详情" });
  await screen.findByRole("button", { name: "登录" });
  const before = state.requests.filter(({ url }) => url.pathname === "/api/viewer/session").length;
  state.sessionNetworkError = failure === "network error";

  await act(async () => { window.dispatchEvent(new Event("focus")); });

  expect(state.requests.filter(({ url }) => url.pathname === "/api/viewer/session")).toHaveLength(before + 1);
  expect(screen.getByRole("button", { name: "登录" })).toBeEnabled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

// 验证：公开海报加载失败时不重新校验匿名访客。
it("does not revalidate an anonymous viewer when a public poster fails", async () => {
  const state = server(); render(<App />);
  await screen.findByRole("button", { name: "登录" });
  const poster = await screen.findByRole("img", { name: "远方来信海报" });
  const before = state.requests.filter(({ url }) => url.pathname === "/api/viewer/session").length;

  await act(async () => { fireEvent.error(poster); });

  expect(state.requests.filter(({ url }) => url.pathname === "/api/viewer/session")).toHaveLength(before);
  expect(screen.getByRole("button", { name: "登录" })).toBeEnabled();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

// 验证：初始会话返回 401 后丢弃身份发现前的私密目录。
it("discards a pre-discovery private catalog after the initial session returns 401", async () => {
  const state = server();
  const session = deferred<Response>(); const old = deferred<Response>();
  state.sessionResponse = session.promise; state.catalogResponse = old.promise;
  render(<App />);
  await waitFor(() => expect(state.requests.some(({ url }) => url.pathname === "/api/catalog")).toBe(true));
  state.catalogResponse = undefined;
  await act(async () => session.resolve(json({}, 401)));
  await act(async () => old.resolve(json({ items: [{ ...seriesCard, is_private: true }], total: 41, page: 3, size: 20 })));
  expect(await screen.findByText("1 部影片")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "目录分页" })).not.toBeInTheDocument();
  expect(screen.queryByText("41 部影片")).not.toBeInTheDocument();
  expect(state.requests.filter(({ url }) => url.pathname === "/api/catalog")).toHaveLength(2);
});

// 验证：其他标签页切换用户后忽略旧请求的不同失败状态。
it.each([ ["logout", 204], ["logout", 401], ["password", 204], ["password", 401] ] as const)(
  "ignores old %s status %s after another tab switches to Winter", async (operation, status) => {
    const state = server(true); const user = userEvent.setup(); render(<App />);
    await screen.findByText("Summer"); await screen.findByText("私密");
    const old = deferred<Response>(); state.writeResponse = old.promise;
    if (operation === "logout") await user.click(screen.getByRole("button", { name: "退出登录" }));
    else {
      await user.click(screen.getByRole("button", { name: "修改密码" }));
      await user.type(screen.getByLabelText("当前密码"), "old-password");
      await user.type(screen.getByLabelText("新密码"), "new-password");
      await user.click(screen.getByRole("button", { name: "保存新密码" }));
    }
    await waitFor(() => expect(state.requests.some(({ url }) => url.pathname === `/api/viewer/${operation}`)).toBe(true));
    state.username = "Winter"; state.csrfToken = "winter-csrf";
    act(() => window.dispatchEvent(new Event("focus")));
    await screen.findByText("Winter");
    await act(async () => old.resolve(status === 204 ? new Response(null, { status }) : json({}, status)));
    expect(screen.getByText("Winter")).toBeInTheDocument();
    state.writeResponse = undefined;
    await user.click(screen.getByRole("button", { name: "修改密码" }));
    await user.type(screen.getByLabelText("当前密码"), "old-password");
    await user.type(screen.getByLabelText("新密码"), "new-password");
    await user.click(screen.getByRole("button", { name: "保存新密码" }));
    const lastWrite = state.requests.filter(({ url }) => url.pathname === "/api/viewer/password").at(-1)!;
    expect(new Headers(lastWrite.init?.headers).get("x-csrf-token")).toBe("winter-csrf");
    expect(await screen.findByText("密码已修改，请重新登录")).toBeInTheDocument();
  },
);

// 验证：会话发现网络失败时仍允许匿名浏览。
it("keeps anonymous browsing available when session discovery has a network error", async () => {
  const state = server(); state.sessionNetworkError = true; render(<App />);
  expect(await screen.findByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "登录" })).toBeEnabled();
  expect(screen.getByText("暂时无法确认登录状态，请稍后重试。")).toBeInTheDocument();
});

// 验证：登录后刷新当前目录查询并显示用户名及账号操作。
it("logs in, refreshes the current catalog query, and exposes username and account actions", async () => {
  window.history.replaceState(null, "", "/?kind=series&q=星&page=2");
  const state = server(); render(<App />); await login();
  expect(await screen.findByText("Summer")).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: "查看群星之间详情" })).toBeInTheDocument();
  expect(screen.getByText("私密")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "修改密码" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();
  expect(screen.queryByText(/注册|修改用户名/)).not.toBeInTheDocument();
  const request = state.requests.filter(({ url }) => url.pathname === "/api/catalog").at(-1)!;
  expect(request.url.searchParams.get("kind")).toBe("series");
  expect(request.url.searchParams.get("q")).toBe("星");
  const write = state.requests.find(({ url }) => url.pathname === "/api/viewer/login")!;
  expect(JSON.parse(String(write.init?.body))).toEqual({ username: "Summer", password: "old-password" });
});

// 验证：后端返回不同登录凭据错误时展示统一提示。
it.each([401, 400])("uses the same login credential error for backend status %s", async (status) => {
  const state = server(); state.loginStatus = status; render(<App />); await login();
  expect(await screen.findByRole("alert")).toHaveTextContent("用户名或密码错误");
  expect(screen.queryByText(/account missing/)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
});

// 验证：退出登录后清除私密目录数据和 CSRF 令牌。
it("clears private catalog data and CSRF after logout", async () => {
  const state = server(true); const user = userEvent.setup(); render(<App />);
  await screen.findByText("Summer"); await screen.findByText("私密");
  await user.click(screen.getByRole("button", { name: "退出登录" }));
  await screen.findByRole("button", { name: "登录" });
  await screen.findByRole("link", { name: "查看远方来信详情" });
  expect(screen.queryByRole("link", { name: "查看群星之间详情" })).not.toBeInTheDocument();
  expect(screen.queryByText("私密")).not.toBeInTheDocument();
  const logout = state.requests.find(({ url }) => url.pathname === "/api/viewer/logout")!;
  expect(new Headers(logout.init?.headers).get("x-csrf-token")).toBe("viewer-csrf");
});

// 验证：拒绝少于八个 Unicode 字符的密码并在有效改密后撤销会话。
it("rejects passwords shorter than eight Unicode code points and revokes the session after a valid password change", async () => {
  const state = server(true); const user = userEvent.setup(); render(<App />);
  await screen.findByText("Summer"); await user.click(screen.getByRole("button", { name: "修改密码" }));
  const dialog = screen.getByRole("dialog", { name: "修改密码" });
  await user.type(within(dialog).getByLabelText("当前密码"), "old-password");
  fireEvent.change(within(dialog).getByLabelText("新密码"), { target: { value: "😀😀😀😀😀😀😀" } });
  await user.click(within(dialog).getByRole("button", { name: "保存新密码" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("新密码至少需要 8 个字符");
  expect(state.requests.some(({ url }) => url.pathname === "/api/viewer/password")).toBe(false);
  fireEvent.change(within(dialog).getByLabelText("新密码"), { target: { value: "😀😀😀😀😀😀😀😀" } });
  await user.click(within(dialog).getByRole("button", { name: "保存新密码" }));
  expect(await screen.findByText("密码已修改，请重新登录")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument();
  await screen.findByRole("link", { name: "查看远方来信详情" });
  expect(screen.queryByText("私密")).not.toBeInTheDocument();
  const write = state.requests.find(({ url }) => url.pathname === "/api/viewer/password")!;
  expect(JSON.parse(String(write.init?.body))).toEqual({ current_password: "old-password", new_password: "😀😀😀😀😀😀😀😀" });
});

// 验证：改密被拒绝时显示本地化错误并保持登录。
it("shows the localized password rejection and keeps the user signed in", async () => {
  const state = server(true); state.passwordStatus = 400; const user = userEvent.setup(); render(<App />);
  await screen.findByText("Summer"); await user.click(screen.getByRole("button", { name: "修改密码" }));
  const dialog = screen.getByRole("dialog", { name: "修改密码" });
  await user.type(within(dialog).getByLabelText("当前密码"), "wrong-password");
  await user.type(within(dialog).getByLabelText("新密码"), "new-password");
  await user.click(within(dialog).getByRole("button", { name: "保存新密码" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("当前密码不正确");
  expect(screen.getByText("Summer")).toBeInTheDocument();
});

// 验证：从不同私密内容路径退出时立即关闭内容。
it.each(["/movies/movie-1", "/series/series-1", "/movies/movie-1/play", "/series/series-1/play/ep-1"])(
  "closes private content at %s immediately after logout", async (path) => {
    window.history.replaceState(null, "", path);
    server(true); const user = userEvent.setup(); render(<App />);
    await screen.findByText("Summer");
    await screen.findByRole("heading", { level: 1 });
    await user.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(location.pathname).toBe("/"));
    expect(screen.queryByTestId("native-video")).not.toBeInTheDocument();
    expect(screen.queryByText("私密")).not.toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
  },
);

// 验证：焦点校验发现会话撤销后移除私密数据并忽略旧响应。
it("removes private data after a revoked session on focus and ignores an old authenticated response", async () => {
  const state = server(true); render(<App />);
  await screen.findByText("Summer"); await screen.findByText("私密");
  const old = deferred<Response>(); state.catalogResponse = old.promise;
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "星" } });
  await waitFor(() => expect(state.requests.at(-1)?.url.pathname).toBe("/api/catalog"));
  state.catalogResponse = undefined; state.authenticated = false;
  act(() => window.dispatchEvent(new Event("focus")));
  await screen.findByRole("button", { name: "登录" });
  await screen.findByRole("link", { name: "查看远方来信详情" });
  await act(async () => old.resolve(json({ items: [{ ...seriesCard, is_private: true }], total: 1, page: 1, size: 20 })));
  expect(screen.queryByRole("link", { name: "查看群星之间详情" })).not.toBeInTheDocument();
});

// 验证：会话重新校验遇到网络错误时不注销已登录用户。
it("does not sign out an authenticated viewer because session revalidation has a network error", async () => {
  const state = server(true); render(<App />); await screen.findByText("Summer");
  state.sessionNetworkError = true; act(() => window.dispatchEvent(new Event("focus")));
  await screen.findByText("暂时无法确认登录状态，请稍后重试。");
  expect(screen.getByText("Summer")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "星" } });
  expect(await screen.findByRole("link", { name: "查看群星之间详情" })).toBeInTheDocument();
});

// 验证：内容请求前发现会话过期后恢复匿名目录。
it("restores anonymous catalog after session expiration discovered before a content request", async () => {
  const state = server(true); render(<App />); await screen.findByText("Summer"); await screen.findByText("私密");
  state.authenticated = false;
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "星" } });
  await screen.findByRole("button", { name: "登录" });
  expect(await screen.findByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
  expect(screen.queryByText("私密")).not.toBeInTheDocument();
});

// 验证：私密详情页展示访问范围标记。
it.each(["/movies/movie-1", "/series/series-1"])("labels private details at %s", async (path) => {
  window.history.replaceState(null, "", path); server(true); render(<App />);
  expect(await screen.findByText("私密")).toBeInTheDocument();
});

// 验证：媒体加载失败时检查撤销的会话并关闭私密播放器。
it("checks revoked sessions on media failure and removes the private player", async () => {
  window.history.replaceState(null, "", "/movies/movie-1/play");
  const state = server(true); render(<App />); await screen.findByText("Summer");
  const video = await screen.findByTestId("native-video");
  state.authenticated = false; fireEvent.error(video);
  await screen.findByRole("button", { name: "登录" });
  expect(screen.queryByTestId("native-video")).not.toBeInTheDocument();
  expect(video).not.toHaveAttribute("src");
  expect(location.pathname).toBe("/");
});

// 验证：初始会话确认前不展示私密内容。
it.each(["/movies/movie-1", "/series/series-1", "/movies/movie-1/play", "/series/series-1/play/ep-1"])(
  "withholds private content at %s until the initial session is confirmed", async (path) => {
    window.history.replaceState(null, "", path);
    const state = server(true); const pending = deferred<Response>(); state.sessionResponse = pending.promise;
    render(<App />);
    await waitFor(() => expect(state.requests.some(({ url }) => url.pathname.includes("/api/catalog/"))).toBe(true));
    await act(async () => {});
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByTestId("native-video")).not.toBeInTheDocument();
    state.sessionResponse = undefined; await act(async () => pending.resolve(json({ username: "Summer", csrf_token: "viewer-csrf" })));
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
  },
);

// 验证：切换单集后仍能在会话失效时关闭私密剧集播放器。
it("continues closing a private series player after changing episodes", async () => {
  window.history.replaceState(null, "", "/series/series-1/play/ep-1");
  server(true); const user = userEvent.setup(); render(<App />);
  await screen.findByTestId("native-video");
  await user.click(screen.getByRole("button", { name: "下一集：第 3 集 · 灯塔" }));
  await screen.findByRole("heading", { name: "第 3 集 · 灯塔" });
  await user.click(screen.getByRole("button", { name: "退出登录" }));
  await waitFor(() => expect(location.pathname).toBe("/"));
  expect(screen.queryByTestId("native-video")).not.toBeInTheDocument();
});

// 验证：焦点和可见性事件同时发生时复用进行中的会话检查。
it("reuses an in-flight session check when focus and visibility events arrive together", async () => {
  const state = server(true); render(<App />); await screen.findByText("私密");
  const pending = deferred<Response>(); state.sessionResponse = pending.promise;
  const before = state.requests.filter(({ url }) => url.pathname === "/api/viewer/session").length;
  act(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
  expect(state.requests.filter(({ url }) => url.pathname === "/api/viewer/session")).toHaveLength(before + 1);
  state.sessionResponse = undefined;
  await act(async () => pending.resolve(json({ username: "Summer", csrf_token: "viewer-csrf" })));
});

// 验证：退出失败后恢复令牌以允许重试。
it("restores CSRF so a failed logout can be retried", async () => {
  const state = server(true); state.logoutStatus = 500; const user = userEvent.setup(); render(<App />);
  await screen.findByText("Summer");
  await user.click(screen.getByRole("button", { name: "退出登录" }));
  await screen.findByText("退出登录失败，请稍后重试。");
  state.logoutStatus = 204; await user.click(screen.getByRole("button", { name: "退出登录" }));
  expect(await screen.findByRole("button", { name: "登录" })).toBeInTheDocument();
});

// 验证：私密海报失败时发现已撤销的普通用户会话。
it("detects a revoked viewer session when a private poster fails", async () => {
  window.history.replaceState(null, "", "/movies/movie-1");
  const state = server(true); render(<App />);
  const poster = await screen.findByRole("img", { name: "远方来信海报" });
  state.authenticated = false; fireEvent.error(poster);
  expect(await screen.findByRole("button", { name: "登录" })).toBeInTheDocument();
  expect(location.pathname).toBe("/");
});

// 验证：原用户私密海报失败导致会话过期后在焦点恢复时发现新用户。
it("rediscovers Winter on focus after Summer's private poster failure expires the session", async () => {
  window.history.replaceState(null, "", "/movies/movie-1");
  const state = server(true); render(<App />);
  await screen.findByText("Summer");
  const poster = await screen.findByRole("img", { name: "远方来信海报" });

  state.authenticated = false; fireEvent.error(poster);
  await screen.findByRole("button", { name: "登录" });
  expect(screen.getByText("登录已失效，请重新登录。")).toBeInTheDocument();
  expect(location.pathname).toBe("/");
  expect(screen.queryByText("Summer")).not.toBeInTheDocument();
  const before = state.requests.filter(({ url }) => url.pathname === "/api/viewer/session").length;
  state.authenticated = true; state.username = "Winter"; state.csrfToken = "winter-csrf";

  act(() => window.dispatchEvent(new Event("focus")));

  expect(state.requests.filter(({ url }) => url.pathname === "/api/viewer/session")).toHaveLength(before + 1);
  expect(await screen.findByText("Winter")).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: "查看群星之间详情" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "登录" })).not.toBeInTheDocument();
  expect(screen.queryByText("登录已失效，请重新登录。")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

// 验证：其他标签页切换账号后接受新用户并清除旧私密页面。
it.each(["/", "/movies/movie-1", "/series/series-1", "/movies/movie-1/play", "/series/series-1/play/ep-1"])(
  "accepts a different viewer from another tab and clears the previous private view at %s", async (path) => {
    window.history.replaceState(null, "", path);
    const state = server(true); render(<App />); await screen.findByText("Summer");
    if (path === "/") await screen.findByText("私密");
    else await screen.findByRole("heading", { level: 1 });
    const previousVideo = screen.queryByTestId("native-video");
    const catalogRequests = state.requests.filter(({ url }) => url.pathname === "/api/catalog").length;
    state.username = "Winter"; state.csrfToken = "winter-csrf";
    act(() => window.dispatchEvent(new Event("focus")));
    expect(await screen.findByText("Winter")).toBeInTheDocument();
    expect(screen.queryByText("Summer")).not.toBeInTheDocument();
    expect(location.pathname).toBe("/");
    expect(screen.queryByTestId("native-video")).not.toBeInTheDocument();
    if (previousVideo) expect(previousVideo).not.toHaveAttribute("src");
    await screen.findByRole("link", { name: "查看群星之间详情" });
    expect(state.requests.filter(({ url }) => url.pathname === "/api/catalog").length).toBeGreaterThan(catalogRequests);
  },
);

// 验证：改密和重新登录后旧会话响应不能替换新用户令牌。
it("does not let a previous viewer session response replace the new viewer's CSRF after password change and login", async () => {
  const state = server(true); state.csrfToken = "summer-csrf";
  const user = userEvent.setup(); render(<App />); await screen.findByText("Summer"); await screen.findByText("私密");
  const old = deferred<Response>(); state.sessionResponse = old.promise;
  act(() => window.dispatchEvent(new Event("focus")));
  state.sessionResponse = undefined;
  // 在认证测试中填写并提交普通用户改密表单，供后续断言身份变化。
  async function changePassword() {
    await user.click(screen.getByRole("button", { name: "修改密码" }));
    const dialog = screen.getByRole("dialog", { name: "修改密码" });
    await user.type(within(dialog).getByLabelText("当前密码"), "old-password");
    await user.type(within(dialog).getByLabelText("新密码"), "new-password");
    await user.click(within(dialog).getByRole("button", { name: "保存新密码" }));
  }
  await changePassword(); await screen.findByRole("button", { name: "登录" });
  state.csrfToken = "winter-csrf"; await login("Winter");
  await screen.findByText("Winter"); await screen.findByText("私密");
  await act(async () => old.resolve(json({ username: "Summer", csrf_token: "summer-csrf" })));
  expect(screen.getByText("Winter")).toBeInTheDocument();
  await changePassword();
  const writes = state.requests.filter(({ url }) => url.pathname === "/api/viewer/password");
  expect(new Headers(writes.at(-1)?.init?.headers).get("x-csrf-token")).toBe("winter-csrf");
  expect(await screen.findByText("密码已修改，请重新登录")).toBeInTheDocument();
});


// 验证：已登录目录按私密内容筛选并从 URL 恢复筛选。
it("filters the authenticated catalog to private content and restores it from the URL", async () => {
  window.history.replaceState(null, "", "/?kind=series&q=%E6%98%9F&page=2");
  const state = server(true); const user = userEvent.setup(); render(<App />);
  const filter = await screen.findByRole("checkbox", { name: "只看私密" });
  await screen.findByRole("link", { name: "查看远方来信详情" });
  state.catalogResponse = deferred<Response>().promise;
  act(() => {
    window.history.pushState(null, "", "/?kind=series&q=%E6%98%9F&page=2");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitFor(() => expect(state.requests.at(-1)?.url.searchParams.get("page")).toBe("2"));
  state.catalogResponse = undefined;
  await user.click(filter);
  await screen.findByRole("link", { name: "查看群星之间详情" });
  expect(screen.queryByRole("link", { name: "查看远方来信详情" })).not.toBeInTheDocument();
  expect(location.search).toContain("kind=series");
  expect(location.search).toContain("q=%E6%98%9F");
  expect(location.search).toContain("privacy=private");
  expect(new URLSearchParams(location.search).get("page")).toBeNull();
  expect(state.requests.filter(({ url }) => url.pathname === "/api/catalog").at(-1)?.url.searchParams.get("privacy")).toBe("private");
  act(() => { window.history.pushState(null, "", "/"); window.dispatchEvent(new PopStateEvent("popstate")); });
  expect(screen.getByRole("checkbox", { name: "只看私密" })).not.toBeChecked();
  act(() => { window.history.pushState(null, "", "/?privacy=private"); window.dispatchEvent(new PopStateEvent("popstate")); });
  expect(await screen.findByRole("checkbox", { name: "只看私密" })).toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "只看私密" }));
  expect(new URLSearchParams(location.search).get("privacy")).toBeNull();
  expect(await screen.findByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
});

// 验证：身份变化时清除私密筛选与页码并保留搜索词。
it.each(["logout", "password", "expired"] as const)("clears private filtering and page but preserves the query after %s", async (operation) => {
  window.history.replaceState(null, "", "/?kind=series&q=%E6%98%9F&privacy=private");
  const state = server(true); const user = userEvent.setup(); render(<App />);
  await screen.findByText("Summer"); await screen.findByText("私密");
  state.catalogResponse = deferred<Response>().promise;
  act(() => {
    window.history.pushState(null, "", "/?kind=series&q=%E6%98%9F&privacy=private&page=2");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await waitFor(() => expect(state.requests.at(-1)?.url.searchParams.get("page")).toBe("2"));
  if (operation === "logout") await user.click(screen.getByRole("button", { name: "退出登录" }));
  else if (operation === "password") {
    await user.click(screen.getByRole("button", { name: "修改密码" }));
    await user.type(screen.getByLabelText("当前密码"), "old-password");
    await user.type(screen.getByLabelText("新密码"), "new-password");
    await user.click(screen.getByRole("button", { name: "保存新密码" }));
  } else { state.authenticated = false; act(() => window.dispatchEvent(new Event("focus"))); }
  await screen.findByRole("button", { name: "登录" });
  await waitFor(() => expect(new URLSearchParams(location.search).get("privacy")).toBeNull());
  expect(new URLSearchParams(location.search).get("page")).toBeNull();
  expect(new URLSearchParams(location.search).get("kind")).toBe("series");
  expect(new URLSearchParams(location.search).get("q")).toBe("星");
  expect(screen.queryByRole("checkbox", { name: "只看私密" })).not.toBeInTheDocument();
});

// 验证：切换私密筛选后忽略迟到的普通目录响应。
it("ignores a delayed ordinary catalog after switching to the private filter", async () => {
  const state = server(true); const user = userEvent.setup(); render(<App />);
  await screen.findByText("Summer"); await screen.findByText("私密");
  const old = deferred<Response>(); state.catalogResponse = old.promise;
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "星" } });
  await waitFor(() => expect(state.requests.at(-1)?.url.searchParams.get("q")).toBe("星"));
  state.catalogResponse = undefined;
  await user.click(screen.getByRole("checkbox", { name: "只看私密" }));
  await screen.findByRole("link", { name: "查看群星之间详情" });
  await act(async () => old.resolve(json({ items: [movieCard], total: 1, page: 1, size: 20 })));
  expect(screen.queryByRole("link", { name: "查看远方来信详情" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "查看群星之间详情" })).toBeInTheDocument();
});

// 验证：会话发现完成前私密筛选深链保持加载状态。
it("keeps a private filter deep link loading until session discovery finishes", async () => {
  window.history.replaceState(null, "", "/?privacy=private");
  const state = server(true); const session = deferred<Response>(); state.sessionResponse = session.promise;
  state.catalogResponse = Promise.resolve(json({ items: [], total: 0, page: 1, size: 20 }));
  render(<App />);
  await waitFor(() => expect(state.requests.some(({ url }) => url.pathname === "/api/catalog")).toBe(true));
  await act(async () => {});
  expect(screen.queryByText("没有找到匹配内容")).not.toBeInTheDocument();
  expect(screen.queryByText("没有找到私密内容")).not.toBeInTheDocument();
  state.sessionResponse = undefined;
  state.catalogResponse = Promise.resolve(json({ items: [], total: 0, page: 1, size: 20 }));
  await act(async () => session.resolve(json({ username: "Summer", csrf_token: "viewer-csrf" })));
  expect(await screen.findByText("没有找到私密内容")).toBeInTheDocument();
});


// 验证：身份变化时即使匿名目录有多页也清除旧页码。
it.each(["logout", "password", "expired"] as const)("clears the ordinary catalog page after %s even when the anonymous catalog has multiple pages", async (operation) => {
  window.history.replaceState(null, "", "/?kind=series&q=%E6%98%9F&page=2");
  const state = server(true); state.catalogTotal = 41;
  const user = userEvent.setup(); render(<App />);
  await screen.findByText("Summer"); await screen.findByText("41 部影片");
  expect(screen.getByRole("checkbox", { name: "只看私密" })).not.toBeChecked();
  expect(new URLSearchParams(location.search).get("page")).toBe("2");
  if (operation === "logout") await user.click(screen.getByRole("button", { name: "退出登录" }));
  else if (operation === "password") {
    await user.click(screen.getByRole("button", { name: "修改密码" }));
    await user.type(screen.getByLabelText("当前密码"), "old-password");
    await user.type(screen.getByLabelText("新密码"), "new-password");
    await user.click(screen.getByRole("button", { name: "保存新密码" }));
  } else { state.authenticated = false; act(() => window.dispatchEvent(new Event("focus"))); }
  await screen.findByRole("button", { name: "登录" });
  await screen.findByText("41 部影片");
  await waitFor(() => expect(new URLSearchParams(location.search).get("page")).toBeNull());
  expect(new URLSearchParams(location.search).get("privacy")).toBeNull();
  expect(new URLSearchParams(location.search).get("kind")).toBe("series");
  expect(new URLSearchParams(location.search).get("q")).toBe("星");
});

// 验证：保留初始匿名目录的分页深链。
it("preserves an initial anonymous catalog page deep link", async () => {
  window.history.replaceState(null, "", "/?kind=series&q=%E6%98%9F&page=2");
  const state = server(); state.catalogTotal = 41; render(<App />);
  await screen.findByRole("button", { name: "登录" });
  await screen.findByText("41 部影片");
  expect(new URLSearchParams(location.search).get("page")).toBe("2");
  expect(state.requests.filter(({ url }) => url.pathname === "/api/catalog").at(-1)?.url.searchParams.get("page")).toBe("2");
});
