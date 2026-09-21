export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject { [key: string]: JsonValue | undefined }
export interface JsonArray extends Array<JsonValue> {}
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type CaughtValue = Error | object | string | number | boolean | bigint | symbol | null | undefined;

export function normalizeError(value: CaughtValue): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(String(value));
  } catch {
    return new Error("Non-Error value was thrown");
  }
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
