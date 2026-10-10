// Rust str::trim uses Unicode White_Space, which includes U+0085 but not U+FEFF.
export function trimViewerWhitespace(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}
