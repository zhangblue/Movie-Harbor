import { useEffect, useState } from "react";
import { normalizeError, type CaughtValue } from "@movie-harbor/api-client";

type Result<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: Error };

export function usePublicRequest<T>(load: () => Promise<T>) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ load: typeof load; attempt: number; value: Result<T> }>();
  useEffect(() => {
    let ignore = false;
    load().then(
      (data) => {
        if (!ignore) setResult({ load, attempt, value: { status: "ready", data } });
      },
      (cause: CaughtValue) => {
        if (!ignore) setResult({ load, attempt, value: { status: "error", error: normalizeError(cause) } });
      },
    );
    return () => { ignore = true; };
  }, [load, attempt]);
  // A changed query must never render the previous query's results, even before its Effect runs.
  const state: Result<T> = result?.load === load && result.attempt === attempt ? result.value : { status: "loading" };
  return { state, retry: () => setAttempt((value) => value + 1) };
}
