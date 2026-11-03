// Rust str::trim uses Unicode White_Space, which includes U+0085 but not U+FEFF.
// 按服务端规则去除用户输入两端空白，提交用户信息前调用。
export function trimViewerWhitespace(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}
