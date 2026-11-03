// API JSON 数据允许的字符串、数字、布尔值和 null。
export type JsonPrimitive = string | number | boolean | null;
// JSON 对象的字符串键映射，读取字段时允许缺失。
export interface JsonObject { [key: string]: JsonValue | undefined }
// 递归 JSON 值数组，供 API 响应和测试数据使用。
export interface JsonArray extends Array<JsonValue> {}
// 可递归的 JSON 基本值、对象或数组，供请求和错误详情使用。
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

// 捕获异常时允许传入错误规范化函数的各种值。
export type CaughtValue = Error | object | string | number | boolean | bigint | symbol | null | undefined;

// 将捕获的任意值转换为 Error，供网络和界面错误处理使用。
export function normalizeError(value: CaughtValue): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(String(value));
  } catch {
    return new Error("Non-Error value was thrown");
  }
}

// 判断 JSON 值是否为非数组对象，供读取对象字段前校验。
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
