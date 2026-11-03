import { ApiError, getSession } from "@movie-harbor/api-client";

// 表示写入遭拒后的会话恢复结果，供调用方决定登录或提示。
type Recovery = { expired: true } | { expired: false; message: string };

// 其他标签页可能更新 Cookie，而当前标签页仍保留内存中的旧 CSRF 令牌。
// 只刷新会话；被拒绝的写入必须由用户明确重试。
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
