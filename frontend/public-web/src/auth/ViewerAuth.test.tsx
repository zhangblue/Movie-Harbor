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

function server(initial = false) {
  const state = { authenticated: initial, sessionNetworkError: false, loginStatus: 200, passwordStatus: 204, logoutStatus: 204,
    requests: [] as Array<{ url: URL; init?: RequestInit }>, catalogResponse: undefined as Promise<Response> | undefined,
    sessionResponse: undefined as Promise<Response> | undefined };
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input, "http://localhost");
    state.requests.push({ url, init });
    if (url.pathname === "/api/viewer/session") {
      if (state.sessionResponse) return state.sessionResponse;
      if (state.sessionNetworkError) throw new TypeError("network unavailable");
      return state.authenticated ? json({ username: "Summer", csrf_token: "viewer-csrf" }) : json({ error: "未登录" }, 401);
    }
    if (url.pathname === "/api/viewer/login") {
      if (state.loginStatus !== 200) return json({ error: "account missing internal details" }, state.loginStatus);
      state.authenticated = true;
      return json({ username: "Summer" });
    }
    if (url.pathname === "/api/viewer/logout") {
      if (new Headers(init?.headers).get("x-csrf-token") !== "viewer-csrf") return json({}, 403);
      if (state.logoutStatus !== 204) return json({}, state.logoutStatus);
      state.authenticated = false; return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/viewer/password") {
      if (state.passwordStatus !== 204) return json({ error: "当前密码不正确" }, state.passwordStatus);
      state.authenticated = false;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/catalog") return state.catalogResponse ?? json({
      items: state.authenticated ? [movieCard, { ...seriesCard, is_private: true }] : [movieCard],
      total: state.authenticated ? 2 : 1, page: Number(url.searchParams.get("page") ?? 1), size: 20,
    });
    if (url.pathname.includes("/movies/")) return state.authenticated ? json({ ...movie, is_private: true }) : json({}, 404);
    if (url.pathname.includes("/series/")) return state.authenticated ? json({ ...series, is_private: true }) : json({}, 404);
    return json({}, 404);
  });
  return state;
}

async function login() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "登录" }));
  const dialog = screen.getByRole("dialog", { name: "登录" });
  await user.type(within(dialog).getByLabelText("用户名"), "Summer");
  await user.type(within(dialog).getByLabelText("密码", { exact: true }), "old-password");
  await user.click(within(dialog).getByRole("button", { name: "登录" }));
  return user;
}

it("keeps the anonymous catalog usable when the initial session returns 401", async () => {
  const state = server(); render(<App />);
  expect(await screen.findByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "登录" })).toBeEnabled();
  expect(state.requests.some(({ url }) => url.pathname === "/api/viewer/session")).toBe(true);
  expect(screen.queryByText("私密")).not.toBeInTheDocument();
});

it("keeps anonymous browsing available when session discovery has a network error", async () => {
  const state = server(); state.sessionNetworkError = true; render(<App />);
  expect(await screen.findByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "登录" })).toBeEnabled();
  expect(screen.getByText("暂时无法确认登录状态，请稍后重试。")).toBeInTheDocument();
});

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

it.each([401, 400])("uses the same login credential error for backend status %s", async (status) => {
  const state = server(); state.loginStatus = status; render(<App />); await login();
  expect(await screen.findByRole("alert")).toHaveTextContent("用户名或密码错误");
  expect(screen.queryByText(/account missing/)).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
});

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

it("does not sign out an authenticated viewer because session revalidation has a network error", async () => {
  const state = server(true); render(<App />); await screen.findByText("Summer");
  state.sessionNetworkError = true; act(() => window.dispatchEvent(new Event("focus")));
  await screen.findByText("暂时无法确认登录状态，请稍后重试。");
  expect(screen.getByText("Summer")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "星" } });
  expect(await screen.findByRole("link", { name: "查看群星之间详情" })).toBeInTheDocument();
});

it("restores anonymous catalog after session expiration discovered before a content request", async () => {
  const state = server(true); render(<App />); await screen.findByText("Summer"); await screen.findByText("私密");
  state.authenticated = false;
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "星" } });
  await screen.findByRole("button", { name: "登录" });
  expect(await screen.findByRole("link", { name: "查看远方来信详情" })).toBeInTheDocument();
  expect(screen.queryByText("私密")).not.toBeInTheDocument();
});

it.each(["/movies/movie-1", "/series/series-1"])("labels private details at %s", async (path) => {
  window.history.replaceState(null, "", path); server(true); render(<App />);
  expect(await screen.findByText("私密")).toBeInTheDocument();
});

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

it("reuses an in-flight session check when focus and visibility events arrive together", async () => {
  const state = server(true); render(<App />); await screen.findByText("私密");
  const pending = deferred<Response>(); state.sessionResponse = pending.promise;
  const before = state.requests.filter(({ url }) => url.pathname === "/api/viewer/session").length;
  act(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
  expect(state.requests.filter(({ url }) => url.pathname === "/api/viewer/session")).toHaveLength(before + 1);
  state.sessionResponse = undefined;
  await act(async () => pending.resolve(json({ username: "Summer", csrf_token: "viewer-csrf" })));
});

it("restores CSRF so a failed logout can be retried", async () => {
  const state = server(true); state.logoutStatus = 500; const user = userEvent.setup(); render(<App />);
  await screen.findByText("Summer");
  await user.click(screen.getByRole("button", { name: "退出登录" }));
  await screen.findByText("退出登录失败，请稍后重试。");
  state.logoutStatus = 204; await user.click(screen.getByRole("button", { name: "退出登录" }));
  expect(await screen.findByRole("button", { name: "登录" })).toBeInTheDocument();
});

it("detects a revoked viewer session when a private poster fails", async () => {
  window.history.replaceState(null, "", "/movies/movie-1");
  const state = server(true); render(<App />);
  const poster = await screen.findByRole("img", { name: "远方来信海报" });
  state.authenticated = false; fireEvent.error(poster);
  expect(await screen.findByRole("button", { name: "登录" })).toBeInTheDocument();
  expect(location.pathname).toBe("/");
});
