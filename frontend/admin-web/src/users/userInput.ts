// Rust 的 str::trim 遵循 Unicode White_Space，包含 U+0085 但不包含 U+FEFF。
// 按服务端规则去除用户输入两端空白，提交用户信息前调用。
export function trimViewerWhitespace(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}
