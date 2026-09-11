import { useEffect, useRef, useState, type MouseEvent } from "react";
import { CatalogPage } from "../catalog/CatalogPage";
import { MovieDetails } from "../details/MovieDetails";
import { SeriesDetails } from "../details/SeriesDetails";
import { NotFound } from "./RequestState";
import { Brand } from "./Brand";

const currentLocation = () => window.location.pathname + window.location.search;

export function App() {
  const [location, setLocation] = useState(currentLocation);
  const mainRef = useRef<HTMLElement>(null);
  const url = new URL(location, window.location.origin);
  const match = /^\/(movies|series)\/([^/]+)\/?$/.exec(url.pathname);
  let id: string | undefined;
  try { id = match ? decodeURIComponent(match[2]!) : undefined; } catch { /* Invalid paths use public 404. */ }

  useEffect(() => {
    const onPopState = () => setLocation(currentLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => { mainRef.current?.focus(); }, [url.pathname]);

  const navigate = (href: string, replace = false) => {
    if (replace) window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
    setLocation(currentLocation());
  };
  function followLink(event: MouseEvent<HTMLElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
    if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
    const target = new URL(anchor.href);
    if (target.origin !== window.location.origin || target.hash) return;
    if (target.pathname !== "/" && !/^\/(movies|series)\/[^/]+\/?$/.test(target.pathname)) return;
    event.preventDefault();
    navigate(target.pathname + target.search);
  }

  return (
    <main className="site-shell" ref={mainRef} tabIndex={-1} onClick={followLink}>
      {url.pathname === "/" ? <CatalogPage search={url.search} navigate={navigate} /> : (
        <>
          <header className="public-header"><Brand /></header>
          {match && id ? match[1] === "movies"
            ? <MovieDetails key={url.pathname} id={id} />
            : <SeriesDetails key={url.pathname} id={id} />
            : <NotFound />}
        </>
      )}
    </main>
  );
}
