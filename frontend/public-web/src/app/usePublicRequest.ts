import { useEffect, useState } from "react";
import { ApiError, normalizeError, type CaughtValue } from "@movie-harbor/api-client";
import { useViewer } from "../auth/ViewerContext";

type Result<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: Error };

export function usePublicRequest<T>(load: () => Promise<T>) {
  const { revision, authenticated, discoveryPending, validate, expire, recordScope } = useViewer();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ load: typeof load; attempt: number; revision: number; value: Result<T> }>();
  useEffect(() => {
    let ignore = false;
    const request = async () => {
      if (authenticated && !(await validate())) return;
      if (ignore) return;
      const data = await load();
      if (!ignore) {
        if (typeof data === "object" && data !== null && "is_private" in data) recordScope(data.is_private === true);
        setResult({ load, attempt, revision, value: { status: "ready", data } });
      }
    };
    request().then(
      () => {},
      (cause: CaughtValue) => {
        if (ignore) return;
        if (authenticated && cause instanceof ApiError && cause.status === 401) { expire(); return; }
        setResult({ load, attempt, revision, value: { status: "error", error: normalizeError(cause) } });
      },
    );
    return () => { ignore = true; };
  }, [load, attempt, revision, authenticated, validate, expire, recordScope]);
  // A changed query must never render the previous query's results, even before its Effect runs.
  let state: Result<T> = result?.load === load && result.attempt === attempt && result.revision === revision ? result.value : { status: "loading" };
  if (state.status === "ready" && !authenticated && typeof state.data === "object" && state.data !== null
    && "is_private" in state.data && state.data.is_private === true) {
    state = discoveryPending ? { status: "loading" } : { status: "error", error: new ApiError(404, "Not Found", "content not found", undefined) };
  }
  return { state, retry: () => setAttempt((value) => value + 1) };
}
