# 前端明确数据类型实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 从全部前端生产代码、前端测试和 E2E TypeScript helper 中移除 `unknown` 数据类型，以明确的 JSON、错误、请求体和持久化类型替代，同时保持现有运行时行为。

**架构：** 共享 API 客户端提供递归 JSON 类型、运行时捕获值联合类型和统一的 `normalizeError()`；公开站与管理后台在外部数据进入业务状态前完成收窄。根 Node 契约测试使用 TypeScript AST 精确检测 `UnknownKeyword`，按任务逐步扩大扫描范围，避免把字符串、注释或业务文案中的普通单词误判为类型。

**技术栈：** TypeScript 6、React 19、Vitest 4、Node Test Runner、TypeScript Compiler API、Playwright 1.61。

---

## 文件结构

- 创建 `tests/frontend-explicit-types.test.mjs`：使用 TypeScript AST 检查指定前端目录，不允许出现 `UnknownKeyword` 类型节点。
- 创建 `frontend/packages/api-client/src/dataTypes.ts`：定义 `JsonPrimitive`、`JsonValue`、`JsonObject`、`JsonArray`、`CaughtValue` 和 `normalizeError()`。
- 修改 `frontend/packages/api-client/src/http.ts`：用明确 JSON 和错误类型替代请求、响应、错误详情与异常原因中的 `unknown`。
- 修改 `frontend/packages/api-client/src/admin.ts`：使用 `JsonObject` 读取错误码。
- 修改 `frontend/packages/api-client/src/http.test.ts`、`admin.test.ts`：让测试回调与循环 JSON 使用明确类型。
- 修改 `frontend/public-web/src/player/progressStore.ts`：以 `JsonValue` 和 `JsonObject` 校验本地存储。
- 修改 `frontend/public-web/src/app/usePublicRequest.ts`、`RequestState.tsx`：请求错误统一为 `Error`。
- 修改 `frontend/public-web/src/test/fixtures.ts`：JSON fixture 使用明确响应载荷类型。
- 修改 `frontend/admin-web/src/content/editorSupport.ts`：编辑写入错误只接收规范化后的 `Error`。
- 修改 `frontend/admin-web/src/movies/MovieEditor.tsx`、`series/SeriesEditor.tsx`、`content/ContentPage.tsx`、`genres/GenrePage.tsx`：Promise rejection 与捕获异常先规范化。
- 修改 `frontend/admin-web/src/test/server.ts`、`test/uploadXhr.ts`、`movies/MovieEditor.test.tsx`、`series/SeriesEditor.test.tsx`：测试请求体与事件详情使用明确联合类型。
- 修改 `tests/e2e/helpers.ts`：E2E 写请求和状态文件使用明确 JSON 类型。

### 任务 1：建立共享 JSON、异常和静态契约边界

**文件：**
- 创建：`tests/frontend-explicit-types.test.mjs`
- 创建：`frontend/packages/api-client/src/dataTypes.ts`
- 修改：`frontend/packages/api-client/src/index.ts`
- 修改：`frontend/packages/api-client/src/http.ts`
- 修改：`frontend/packages/api-client/src/admin.ts`
- 修改：`frontend/packages/api-client/src/http.test.ts`
- 修改：`frontend/packages/api-client/src/admin.test.ts`

- [ ] **步骤 1：编写仅扫描共享 API 客户端的失败契约测试**

创建 `tests/frontend-explicit-types.test.mjs`，递归读取 `.ts` 和 `.tsx` 文件，并通过 Compiler API 查找真实类型节点：

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist"].includes(entry.name)) return sourceFiles(path);
    if (entry.isDirectory()) return [];
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function unknownTypeLocations(directory) {
  const failures = [];
  for (const path of sourceFiles(resolve(root, directory))) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (node.kind === ts.SyntaxKind.UnknownKeyword) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        failures.push(`${relative(root, path)}:${position.line + 1}:${position.character + 1}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return failures;
}

test("api-client uses explicit data types", () => {
  assert.deepEqual(unknownTypeLocations("frontend/packages/api-client"), []);
});
```

- [ ] **步骤 2：运行契约测试确认失败**

运行：

```bash
node --test tests/frontend-explicit-types.test.mjs
```

预期：FAIL，并列出 `http.ts`、`admin.ts` 和对应测试中当前使用 `unknown` 类型的位置。

- [ ] **步骤 3：定义明确的共享数据类型和异常规范化函数**

创建 `dataTypes.ts`：

```ts
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
```

从 `index.ts` 导出该文件。`CaughtValue` 覆盖 JavaScript 可抛出的值；所有 `catch` 变量在跨出捕获块前通过 `as CaughtValue` 进入规范化函数，不把宽泛值存入领域状态。

- [ ] **步骤 4：改造 API 请求和错误类型**

在 `http.ts` 中：

```ts
import { normalizeError, type CaughtValue, type JsonObject, type JsonValue } from "./dataTypes";

export interface ApiRequestInit<JsonBody extends object = Record<string, never>>
  extends Omit<RequestInit, "body"> {
  body?: BodyInit | null;
  json?: JsonBody;
  query?: Query;
}

export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly details: JsonValue | undefined;

  constructor(status: number, statusText: string, message: string, details: JsonValue | undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
    this.details = details;
  }
}

export class ApiNetworkError extends Error {
  readonly aborted: boolean;
  override readonly cause: Error;
  constructor(cause: Error) {
    const aborted = cause instanceof DOMException && cause.name === "AbortError";
    super(aborted ? "Request was aborted" : "Unable to reach the server", { cause });
    this.name = "ApiNetworkError";
    this.aborted = aborted;
    this.cause = cause;
  }
}

export async function apiRequest<ResponseBody = JsonValue, JsonBody extends object = Record<string, never>>(
  path: string,
  init: ApiRequestInit<JsonBody> = {},
): Promise<ResponseBody | undefined> {
  const response = await performApiFetch(path, init);
  if (response.status === 204 || response.status === 205) return undefined;
  return parseApiResponse<ResponseBody>(response);
}
```

JSON 解析使用 `JSON.parse(text) as JsonValue`；捕获分支使用 `normalizeError(cause as CaughtValue)`。`errorMessage()` 接收 `JsonValue | undefined`，并使用 `isJsonObject(value): value is JsonObject` 读取 `error` 和 `message`。`apiRequest` 的请求体泛型由调用点自动推断，现有 DTO 不需要增加索引签名。

在 `admin.ts` 中删除 `Record<string, unknown>` 断言，通过 `JsonObject` 守卫或 `typeof error.details.code === "string"` 返回错误码。把不需要响应体的 `apiRequest()` 调用保持为默认 `JsonValue` 响应。

- [ ] **步骤 5：更新 API 客户端测试的明确类型**

在 `http.test.ts` 中：

- 循环 JSON fixture 使用 `JsonObject`。
- `.catch((value: unknown) => value)` 改为 `.catch((error: Error) => error)`。
- 保留“unknown progress”测试名称，因为它描述不可计算进度，不是 TypeScript 类型。

在 `admin.test.ts` 中保留查询对象中的 `unknown: "ignored"` 属性，因为它是模拟的运行时字段名，不是类型节点。

- [ ] **步骤 6：验证共享边界通过**

运行：

```bash
node --test tests/frontend-explicit-types.test.mjs
npm test --workspace @movie-harbor/api-client
npm run build --workspace @movie-harbor/api-client
git diff --check
```

预期：契约测试通过；API 客户端测试 39 项及类型构建通过。

- [ ] **步骤 7：提交**

```bash
git add tests/frontend-explicit-types.test.mjs frontend/packages/api-client/src
git commit -m "refactor: 明确 API 客户端数据类型"
```

### 任务 2：明确公开站请求与本地存储类型

**文件：**
- 修改：`tests/frontend-explicit-types.test.mjs`
- 修改：`frontend/public-web/src/player/progressStore.ts`
- 修改：`frontend/public-web/src/app/usePublicRequest.ts`
- 修改：`frontend/public-web/src/app/RequestState.tsx`
- 修改：`frontend/public-web/src/test/fixtures.ts`

- [ ] **步骤 1：扩展契约测试并确认公开站失败**

在契约测试加入：

```js
test("public web uses explicit data types", () => {
  assert.deepEqual(unknownTypeLocations("frontend/public-web"), []);
});
```

运行：

```bash
node --test --test-name-pattern="public web" tests/frontend-explicit-types.test.mjs
```

预期：FAIL，列出 `progressStore.ts`、`usePublicRequest.ts`、`RequestState.tsx` 和 `fixtures.ts` 的类型位置。

- [ ] **步骤 2：明确本地存储的 JSON 候选类型**

在 `progressStore.ts` 中导入 `JsonObject` 和 `JsonValue`：

```ts
function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const value = JSON.parse(raw) as JsonValue;
```

继续逐字段验证版本号、进度数值、更新时间和最近单集 ID；不要直接把解析结果断言为 `ProgressState`。

- [ ] **步骤 3：让请求状态只保存 Error**

在 `usePublicRequest.ts` 中把错误分支改为：

```ts
type Result<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: Error };

load().then(
  (data) => {
    if (!ignore) setResult({ load, attempt, value: { status: "ready", data } });
  },
  (cause: CaughtValue) => {
    if (!ignore) setResult({ load, attempt, value: { status: "error", error: normalizeError(cause) } });
  },
);
```

`RequestError` 的 `error` prop 改为 `Error`，现有 404 与通用重试行为不变。

- [ ] **步骤 4：明确公开站测试响应载荷**

在 `fixtures.ts` 定义测试允许返回的载荷：

```ts
type PublicFixturePayload = JsonValue | CatalogPage | MovieDetail | SeriesDetail;

export function json(value: PublicFixturePayload, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
```

如果现有 fixture 还传递数组，则把对应明确数组类型加入联合；不得改为 `any` 或无约束泛型。

- [ ] **步骤 5：验证公开站边界通过**

运行：

```bash
node --test tests/frontend-explicit-types.test.mjs
npm test --workspace @movie-harbor/public-web
npm run build --workspace @movie-harbor/public-web
git diff --check
```

预期：API 客户端与公开站契约子测试均通过；公开站测试 48 项及构建通过。

- [ ] **步骤 6：提交**

```bash
git add tests/frontend-explicit-types.test.mjs frontend/public-web/src
git commit -m "refactor: 明确公开站数据边界"
```

### 任务 3：明确管理端、测试工具和 E2E 类型

**文件：**
- 修改：`tests/frontend-explicit-types.test.mjs`
- 修改：`frontend/admin-web/src/content/editorSupport.ts`
- 修改：`frontend/admin-web/src/movies/MovieEditor.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.tsx`
- 修改：`frontend/admin-web/src/content/ContentPage.tsx`
- 修改：`frontend/admin-web/src/genres/GenrePage.tsx`
- 修改：`frontend/admin-web/src/test/server.ts`
- 修改：`frontend/admin-web/src/test/uploadXhr.ts`
- 修改：`frontend/admin-web/src/movies/MovieEditor.test.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.test.tsx`
- 修改：`tests/e2e/helpers.ts`

- [ ] **步骤 1：扩展契约测试并确认管理端与 E2E 失败**

在契约测试加入：

```js
test("admin web and e2e helpers use explicit data types", () => {
  assert.deepEqual([
    ...unknownTypeLocations("frontend/admin-web"),
    ...unknownTypeLocations("frontend/packages/ui"),
    ...unknownTypeLocations("tests/e2e"),
  ], []);
});
```

运行：

```bash
node --test --test-name-pattern="admin web" tests/frontend-explicit-types.test.mjs
```

预期：FAIL，列出管理端组件、测试 helper、编辑器测试和 `tests/e2e/helpers.ts` 的现有类型位置。

- [ ] **步骤 2：规范化管理端错误值**

把 `classifyEditorWriteError(cause: unknown)` 改为 `classifyEditorWriteError(cause: Error)`。在四个页面组件中：

- Promise rejection 回调明确接收 `CaughtValue`，立即调用 `normalizeError()`。
- `catch (cause)` 分支在判断前执行 `const error = normalizeError(cause as CaughtValue)`。
- 后续只把 `error` 传给 `ApiError` 判断或 `classifyEditorWriteError()`。

不得改变 401、403、409、422、媒体删除失败、媒体替换失败或媒体内容不匹配的现有分支。

- [ ] **步骤 3：明确管理端测试请求体和上传事件类型**

在 `server.ts` 定义：

```ts
export type TestRequestBody = JsonValue | FormData | undefined;
export type Request = {
  url: string;
  method: string;
  body: TestRequestBody;
  headers: Headers;
  credentials: RequestCredentials | undefined;
};
```

Fetch stub 把字符串 JSON 解析为 `JsonValue`；FormData 原样保存。`requestJson<T extends object>()` 继续完成对象检查后返回 `T`，`requestFormData()` 继续检查实例。

在 `uploadXhr.ts` 中把事件 detail 改为明确结构：

```ts
type UploadEventDetail = {
  lengthComputable?: boolean;
  loaded?: number;
  total?: number;
};
```

电影与剧集测试中的手工 `Request` 构造使用 `JsonValue | FormData | undefined`，不使用类型逃逸。

- [ ] **步骤 4：明确 E2E 请求和状态类型**

在 `tests/e2e/helpers.ts` 导入 `JsonObject`、`JsonValue`，并改为：

```ts
async write<T>(
  method: "post" | "patch" | "put" | "delete",
  path: string,
  data?: JsonObject,
): Promise<T> {
  const response = await this.request[method](path, { data, headers: this.headers() });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.status() === 204 ? undefined as T : response.json();
}

export function saveState(state: Record<string, JsonValue>) {
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
}
```

登录会话 JSON 通过明确的 `{ csrf_token: string }` 类型读取；`loadState<T>()` 保留调用方必须指定结果结构的泛型契约。

- [ ] **步骤 5：运行完整验证**

运行：

```bash
node --test tests/frontend-explicit-types.test.mjs
npm test --workspaces
npm run build --workspaces
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
git diff --check
```

预期：所有契约子测试、前端测试、前端构建和根 Node 测试通过。扫描范围内没有 `UnknownKeyword`；普通字符串、注释和测试名称中的 “unknown” 不影响结果。

- [ ] **步骤 6：提交**

```bash
git add tests/frontend-explicit-types.test.mjs frontend/admin-web/src tests/e2e/helpers.ts
git commit -m "refactor: 明确管理端和 E2E 数据类型"
```
