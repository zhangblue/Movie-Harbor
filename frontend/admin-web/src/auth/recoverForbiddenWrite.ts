import { ApiError, getSession } from "@movie-harbor/api-client";

type Recovery = { expired: true } | { expired: false; message: string };

// A different tab can replace the Cookie while this tab retains its old in-memory CSRF token.
// Refresh only the session; the user must explicitly retry the rejected write.
export async function recoverForbiddenWrite(): Promise<Recovery> {
  try {
    await getSession();
    return { expired: false, message: "请求被拒绝（403）。已重新确认会话，请重新执行操作；若仍被拒绝，请检查站点配置。" };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) return { expired: true };
    return { expired: false, message: "请求被拒绝（403），且无法确认会话。请检查网络后重试。" };
  }
}
