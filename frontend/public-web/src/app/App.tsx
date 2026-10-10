import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { CatalogPage } from "../catalog/CatalogPage";
import { MovieDetails } from "../details/MovieDetails";
import { SeriesDetails } from "../details/SeriesDetails";
import { NotFound } from "./RequestState";
import { Brand } from "./Brand";
import { MoviePlayerPage, SeriesPlayerPage } from "../player/PlayerPage";
import { ApiError, clearCsrfToken, getViewerSession, viewerLogout } from "@movie-harbor/api-client";
import { ViewerContext } from "../auth/ViewerContext";
import { ViewerLoginDialog } from "../auth/ViewerLoginDialog";
import { ViewerPasswordDialog } from "../auth/ViewerPasswordDialog";

const currentLocation = () => window.location.pathname + window.location.search;
const contentPath = (path: string) => /^\/(movies|series)\/[^/]+/.exec(path)?.[0];

export function App() {
  const [location, setLocation] = useState(currentLocation);
  const mainRef = useRef<HTMLElement>(null);
  const [viewer, setViewer] = useState<{ status: "loading" | "anonymous" | "authenticated" | "error"; username?: string }>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<"login" | "password">();
  const [message, setMessage] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const identity = useRef(0);
  const privateContent = useRef(false);
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
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
  } catch { /* Invalid paths use public 404. */ }

  useEffect(() => {
    const onPopState = () => {
      if (!contentPath(window.location.pathname)) privateContent.current = false;
      setLocation(currentLocation());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => { mainRef.current?.focus(); }, [url.pathname]);

  const navigate = useCallback((href: string, replace = false) => {
    if (contentPath(window.location.pathname) !== contentPath(href)) privateContent.current = false;
    if (replace) window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
    setLocation(currentLocation());
  }, []);
  const becomeAnonymous = useCallback((notice = "") => {
    identity.current += 1;
    validation.current = undefined;
    clearCsrfToken();
    viewerRef.current = { status: "anonymous" };
    setViewer(viewerRef.current);
    setDialog(undefined); setMessage(notice);
    setRevision((value) => value + 1);
    if (privateContent.current) navigate("/", true);
    privateContent.current = false;
  }, [navigate]);
  const expire = useCallback(() => becomeAnonymous("登录已失效，请重新登录。"), [becomeAnonymous]);
  const recordScope = useCallback((isPrivate: boolean) => { privateContent.current = isPrivate; }, []);
  const validate = useCallback(() => {
    if (viewerRef.current.status !== "authenticated") return Promise.resolve(true);
    if (validation.current) return validation.current;
    const startedAt = identity.current;
    const request = getViewerSession().then(() => {
      if (startedAt !== identity.current) {
        if (viewerRef.current.status !== "authenticated") clearCsrfToken();
        return false;
      }
      setMessage("");
      return true;
    }, (cause: unknown) => {
      if (startedAt !== identity.current) return false;
      if (cause instanceof ApiError && cause.status === 401) { expire(); return false; }
      setMessage("暂时无法确认登录状态，请稍后重试。");
      return true;
    }).finally(() => { if (validation.current === request) validation.current = undefined; });
    validation.current = request;
    return request;
  }, [expire]);
  useEffect(() => {
    let ignore = false;
    const startedAt = identity.current;
    getViewerSession().then((session) => {
      if (ignore || startedAt !== identity.current) return;
      setViewer({ status: "authenticated", username: session.username });
      setRevision((value) => value + 1);
    }, (cause: unknown) => {
      if (ignore || startedAt !== identity.current) return;
      clearCsrfToken();
      if (cause instanceof ApiError && cause.status === 401) setViewer({ status: "anonymous" });
      else { setViewer({ status: "error" }); setMessage("暂时无法确认登录状态，请稍后重试。"); }
    });
    return () => { ignore = true; };
  }, []);
  useEffect(() => {
    const onFocus = () => { void validate(); };
    const onVisible = () => { if (document.visibilityState === "visible") void validate(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVisible); };
  }, [validate]);
  const authenticated = viewer.status === "authenticated";
  const account = <div className="viewer-account" aria-label="用户账号">
    {authenticated ? <><span className="viewer-username">{viewer.username}</span>
      <button className="pill" type="button" disabled={loggingOut} onClick={() => setDialog("password")}>修改密码</button>
      <button className="pill" type="button" disabled={loggingOut} onClick={async () => {
        setLoggingOut(true);
        try {
          if (!(await validate())) return;
          await viewerLogout(); becomeAnonymous();
        }
        catch (cause) {
          if (cause instanceof ApiError && cause.status === 401) expire();
          else setMessage("退出登录失败，请稍后重试。");
        } finally { setLoggingOut(false); }
      }}>{loggingOut ? "正在退出…" : "退出登录"}</button></>
      : <button className="pill" type="button" disabled={viewer.status === "loading"} onClick={() => setDialog("login")}>登录</button>}
  </div>;
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
    {dialog === "login" && <ViewerLoginDialog onClose={() => setDialog(undefined)} onLogin={(username) => {
      identity.current += 1; validation.current = undefined;
      viewerRef.current = { status: "authenticated", username };
      setViewer(viewerRef.current); setMessage(""); setDialog(undefined);
      setRevision((value) => value + 1);
      if (privateContent.current) navigate("/", true);
      privateContent.current = false;
    }} />}
    {dialog === "password" && <ViewerPasswordDialog onClose={() => setDialog(undefined)} onChanged={() => becomeAnonymous("密码已修改，请重新登录")} />}
    </ViewerContext.Provider>
  );
}
