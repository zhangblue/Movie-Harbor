import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { CatalogPage } from "../catalog/CatalogPage";
import { MovieDetails } from "../details/MovieDetails";
import { SeriesDetails } from "../details/SeriesDetails";
import { NotFound } from "./RequestState";
import { Brand } from "./Brand";
import { MoviePlayerPage, SeriesPlayerPage } from "../player/PlayerPage";
import { ApiError, clearCsrfToken, getViewerSession, viewerLogout, type CaughtValue, type ViewerSessionResponse } from "@movie-harbor/api-client";
import { ViewerContext } from "../auth/ViewerContext";
import { ViewerLoginDialog } from "../auth/ViewerLoginDialog";
import { ViewerPasswordDialog } from "../auth/ViewerPasswordDialog";

// 读取当前路径和查询参数，在初始化及浏览器历史变化时同步界面。
const currentLocation = () => window.location.pathname + window.location.search;
// 提取电影或剧集路径，在导航时判断是否离开当前内容。
const contentPath = (path: string) => /^\/(movies|series)\/[^/]+/.exec(path)?.[0];
// 公开站当前身份的加载、匿名、已认证或错误状态及可选用户名。
type ViewerState = { status: "loading" | "anonymous" | "authenticated" | "error"; username?: string };

// 作为公开站根组件管理路由、普通用户身份和页面切换。
export function App() {
  const [location, setLocation] = useState(currentLocation);
  const mainRef = useRef<HTMLElement>(null);
  const [viewer, setViewer] = useState<ViewerState>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<"login" | "password">();
  const [message, setMessage] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const identity = useRef(0);
  const privateContent = useRef(false);
  const viewerRef = useRef(viewer);
  const validation = useRef<Promise<boolean> | undefined>(undefined);
  const url = new URL(location, window.location.origin);
  const detailsMatch = /^\/(movies|series)\/([^/]+)\/?$/.exec(url.pathname);
  const moviePlayerMatch = /^\/movies\/([^/]+)\/play\/?$/.exec(url.pathname);
  const seriesPlayerMatch = /^\/series\/([^/]+)\/play(?:\/([^/]+))?\/?$/.exec(url.pathname);
  let id: string | undefined;
  let episodeId: string | undefined;
  try {
    const encodedId = moviePlayerMatch?.[1] ?? seriesPlayerMatch?.[1] ?? detailsMatch?.[2];
    const decodedId = encodedId ? decodeURIComponent(encodedId) : undefined;
    const decodedEpisodeId = seriesPlayerMatch?.[2] ? decodeURIComponent(seriesPlayerMatch[2]) : undefined;
    id = decodedId;
    episodeId = decodedEpisodeId;
  } catch { /* 路径解码失败时不设置内容 ID，统一进入公开 404 页面。 */ }

  useEffect(() => {
    // 在浏览器历史变化时同步路由，并在离开内容页时清除私密标记。
    const onPopState = () => {
      if (!contentPath(window.location.pathname)) privateContent.current = false;
      setLocation(currentLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  // 切换页面路径后将焦点移到主内容，避免键盘焦点停留在已离开的视图。
  useEffect(() => { mainRef.current?.focus(); }, [url.pathname]);

  // 在站内导航时更新浏览器历史和当前页面，必要时清除私密内容标记。
  const navigate = useCallback((href: string, replace = false) => {
    if (contentPath(window.location.pathname) !== contentPath(href)) privateContent.current = false;
    if (replace) window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
    setLocation(currentLocation());
  }, []);
  // 切换用户身份并清理旧会话状态，必要时退出私密页面并刷新数据。
  const transitionViewer = useCallback((next: ViewerState, notice = "") => {
    const wasAuthenticated = viewerRef.current.status === "authenticated";
    const closePrivateContent = wasAuthenticated && privateContent.current;
    identity.current += 1;
    validation.current = undefined;
    clearCsrfToken();
    viewerRef.current = next;
    setViewer(viewerRef.current);
    setLoggingOut(false);
    setDialog(undefined); setMessage(notice);
    setRevision((value) => value + 1);
    if (closePrivateContent) navigate("/", true);
    if (closePrivateContent || next.status !== "authenticated") privateContent.current = false;
  }, [navigate]);
  // 在退出或会话失效时切换为匿名状态并显示提示。
  const becomeAnonymous = useCallback((notice = "") => transitionViewer({ status: "anonymous" }, notice), [transitionViewer]);
  // 只接受当前身份代次的会话结果，防止过期请求覆盖新身份。
  const acceptSession = useCallback((session: ViewerSessionResponse, generation: number) => {
    if (generation !== identity.current) return false;
    if (viewerRef.current.status !== "authenticated" || viewerRef.current.username !== session.username) {
      transitionViewer({ status: "authenticated", username: session.username });
    } else setMessage("");
    return true;
  }, [transitionViewer]);
  // 在会话失效时转为匿名并提示重新登录。
  const expire = useCallback(() => becomeAnonymous("登录已失效，请重新登录。"), [becomeAnonymous]);
  // 记录当前内容是否私密，供身份切换时决定是否离开页面。
  const recordScope = useCallback((isPrivate: boolean) => { privateContent.current = isPrivate; }, []);
  // 在访问受保护数据或页面重新可见时复用会话校验，失效则退出登录。
  const validate = useCallback((discoverAnonymous = false) => {
    const startedStatus = viewerRef.current.status;
    if (startedStatus !== "authenticated" && !(discoverAnonymous && startedStatus === "anonymous")) return Promise.resolve(true);
    if (validation.current) return validation.current;
    const startedAt = identity.current;
    // 校验结果只作用于发起时的身份；请求中的校验由并发调用复用。
    const request = getViewerSession((session) => acceptSession(session, startedAt)).then(
      () => startedAt === identity.current,
      (cause: CaughtValue) => {
        // 身份已变化或匿名发现失败时返回 false，阻止依赖这次校验的后续操作。
        if (startedAt !== identity.current || startedStatus === "anonymous") return false;
        // 明确的 401 代表会话已失效，关闭私密内容并阻止当前公开数据请求。
        if (cause instanceof ApiError && cause.status === 401) { expire(); return false; }
        // 网络等非 401 失败无法证明会话失效：保留登录并允许公开请求继续，由其自身处理失败。
        setMessage("暂时无法确认登录状态，请稍后重试。");
        return true;
      },
    ).finally(() => { /* 只清除本次共享校验，避免旧请求收尾时抹去新身份的校验。 */ if (validation.current === request) validation.current = undefined; });
    validation.current = request;
    return request;
  }, [acceptSession, expire]);
  useEffect(() => {
    let ignore = false;
    const startedAt = identity.current;
    // 首次渲染时恢复已有会话；忽略卸载或身份切换后的迟到结果。
    getViewerSession((session) => !ignore && acceptSession(session, startedAt)).catch((cause: CaughtValue) => {
      if (ignore || startedAt !== identity.current) return;
      // 初始发现得到 401 时转匿名；其他失败显示提示，匿名浏览仍可继续。
      if (cause instanceof ApiError && cause.status === 401) transitionViewer({ status: "anonymous" });
      else transitionViewer({ status: "error" }, "暂时无法确认登录状态，请稍后重试。");
    });
    return () => { ignore = true; };
  }, [acceptSession, transitionViewer]);
  useEffect(() => {
    // 窗口重新获得焦点时检查普通用户会话。
    const onFocus = () => { void validate(true); };
    // 页面重新可见时检查普通用户会话。
    const onVisible = () => { if (document.visibilityState === "visible") void validate(true); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisible); };
  }, [validate]);
  const authenticated = viewer.status === "authenticated";
  const account = <div className="viewer-account" aria-label="用户账号">
    {authenticated ? <><span className="viewer-username">{viewer.username}</span>
      <button className="pill" type="button" disabled={loggingOut} onClick={() => setDialog("password")}>修改密码</button>
      <button className="pill" type="button" disabled={loggingOut} onClick={async () => {
        // 用户主动退出时记录身份代次；验证、退出及收尾均只作用于这一代会话。
        const startedAt = identity.current;
        // 异步操作完成时检查身份代次，避免旧结果改变新会话。
        const isCurrent = () => startedAt === identity.current;
        setLoggingOut(true);
        try {
          // 先确认会话仍属于当前用户，避免旧退出操作清除新登录的身份。
          if (!(await validate()) || !isCurrent()) return;
          await viewerLogout(isCurrent);
          if (isCurrent()) becomeAnonymous();
        }
        catch (cause) {
          if (!isCurrent()) return;
          if (cause instanceof ApiError && cause.status === 401) expire();
          else setMessage("退出登录失败，请稍后重试。");
        } finally { if (isCurrent()) setLoggingOut(false); }
      }}>{loggingOut ? "正在退出…" : "退出登录"}</button></>
      : <button className="pill" type="button" disabled={viewer.status === "loading"} onClick={() => setDialog("login")}>登录</button>}
  </div>;
  // 拦截站内普通链接并交给应用导航，保留外部链接和浏览器快捷操作。
  function followLink(event: MouseEvent<HTMLElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
    if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
    const target = new URL(anchor.href);
    if (target.origin !== window.location.origin || target.hash) return;
    if (target.pathname !== "/" && !/^\/(movies|series)\/[^/]+(?:\/play(?:\/[^/]+)?)?\/?$/.test(target.pathname)) return;
    event.preventDefault();
    navigate(target.pathname + target.search);
  }

  const loginGeneration = identity.current;
  return (
    <ViewerContext.Provider value={{ revision, authenticated, discoveryPending: viewer.status === "loading", validate, expire, recordScope }}>
    <main className="site-shell" ref={mainRef} tabIndex={-1} onClick={followLink} onErrorCapture={() => { void validate(); }}>
      {message && <p className="viewer-notice" role="status">{message}</p>}
      {url.pathname === "/" ? <CatalogPage search={url.search} navigate={navigate} account={account} /> : (
        <>
          <header className="public-header"><Brand />{account}</header>
          {moviePlayerMatch && id ? <MoviePlayerPage key={`movie-player:${id}`} id={id} />
            : seriesPlayerMatch && id ? <SeriesPlayerPage key={`series-player:${id}`} id={id} episodeId={episodeId} navigate={navigate} />
            : detailsMatch && id ? detailsMatch[1] === "movies"
            ? <MovieDetails key={url.pathname} id={id} />
            : <SeriesDetails key={url.pathname} id={id} />
            : <NotFound />}
        </>
      )}
    </main>
    {dialog === "login" && <ViewerLoginDialog onClose={() => setDialog(undefined)} onLogin={(session) => acceptSession(session, loginGeneration)} />}
    {dialog === "password" && <ViewerPasswordDialog isCurrent={() => loginGeneration === identity.current} onClose={() => setDialog(undefined)} onChanged={() => becomeAnonymous("密码已修改，请重新登录")} />}
    </ViewerContext.Provider>
  );
}
