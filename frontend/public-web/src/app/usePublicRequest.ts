import { useEffect, useState } from "react";
import { ApiError, normalizeError, type CaughtValue } from "@movie-harbor/api-client";
import { useViewer } from "../auth/ViewerContext";

// 定义结果，供相关请求、状态或组件使用。
type Result<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: Error };

// 在查询或身份变化时加载公开数据，处理过期会话、错误和过时响应。
export function usePublicRequest<T>(load: () => Promise<T>) {
  const { revision, authenticated, discoveryPending, validate, expire, recordScope } = useViewer();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ load: typeof load; attempt: number; revision: number; value: Result<T> }>();
  useEffect(() => {
    let ignore = false;
    // 执行公开请求，先验证已登录会话再加载数据并记录私密范围。
    const request = async () => {
      // 在加载可能含私密内容的数据前校验会话，失效时不继续请求。
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
        // 已登录请求遇到 401 时让身份层关闭私密内容；其他错误交给页面重试。
        if (authenticated && cause instanceof ApiError && cause.status === 401) { expire(); return; }
        setResult({ load, attempt, revision, value: { status: "error", error: normalizeError(cause) } });
      },
    );
    return () => { ignore = true; };
  }, [load, attempt, revision, authenticated, validate, expire, recordScope]);
  // 查询或身份变化后立即显示加载状态，避免 Effect 执行前短暂展示旧结果。
  let state: Result<T> = result?.load === load && result.attempt === attempt && result.revision === revision ? result.value : { status: "loading" };
  if (state.status === "ready" && !authenticated && typeof state.data === "object" && state.data !== null
    && "is_private" in state.data && state.data.is_private === true) {
    state = discoveryPending ? { status: "loading" } : { status: "error", error: new ApiError(404, "Not Found", "content not found", undefined) };
  }
  return { state, retry: () => setAttempt((value) => value + 1) };
}
