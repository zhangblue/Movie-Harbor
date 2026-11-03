import { ApiError, getSession } from "@movie-harbor/api-client";

// 表示写入遭拒后的会话恢复结果，供调用方决定登录或提示。
type Recovery = { expired: true } | { expired: false; message: string };

// A different tab can replace the Cookie while this tab retains its old in-memory CSRF token.
// Refresh only the session; the user must explicitly retry the rejected write.
// 恢复被拒写入后的会话与令牌状态，在收到 403 后调用且不重放写入。
export async function recoverForbiddenWrite(): Promise<Recovery> {
  try {
    await getSession();
    return { expired: false, message: "请求被拒绝（403）。已重新确认会话，请重新执行操作；若仍被拒绝，请检查站点配置。" };
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) return { expired: true };
    return { expired: false, message: "请求被拒绝（403），且无法确认会话。请检查网络后重试。" };
  }
}
