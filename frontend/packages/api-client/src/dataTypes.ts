// 定义JSON基本值，供相关请求、状态或组件使用。
export type JsonPrimitive = string | number | boolean | null;
// 定义JSON对象，供相关请求、状态或组件使用。
export interface JsonObject { [key: string]: JsonValue | undefined }
// 定义JSON数组，供相关请求、状态或组件使用。
export interface JsonArray extends Array<JsonValue> {}
// 定义JSON值，供相关请求、状态或组件使用。
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
