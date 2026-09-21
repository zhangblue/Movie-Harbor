# 前端明确数据类型设计规格

日期：2026-09-21

## 1. 背景

当前前端生产代码、测试辅助代码和端到端测试中，部分 JSON、错误、请求体和持久化数据边界使用了 TypeScript 的 `unknown` 类型。项目要求这些边界改用可读、可复用且能够表达实际数据范围的明确类型，不再用 `unknown` 作为数据类型。

本变更只调整 TypeScript 类型边界及必要的运行时收窄，不改变 API、页面交互、上传进度、错误文案或后端行为。

## 2. 范围

本规格覆盖：

- `frontend/` 下所有生产与测试 TypeScript、TSX 文件。
- `tests/e2e/` 下的 TypeScript helper 与测试文件。
- JSON 请求、JSON 响应、API 错误详情、异常原因、本地存储数据、测试请求体和 E2E 状态文件。

普通文本中的“unknown”不在限制范围内，例如测试名称、注释、模拟业务值和界面中“未知状态”的表达。限制对象是 TypeScript 数据类型。

## 3. 类型模型

共享 API 客户端提供递归 JSON 类型：

```ts
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject { [key: string]: JsonValue | undefined }
export interface JsonArray extends Array<JsonValue> {}
```

接口允许对象属性为 `undefined`，便于现有请求对象在序列化前表达可选字段；数组元素必须是可序列化 JSON 值。

API 错误详情使用明确联合类型：JSON 值或未提供。`ApiError.details` 不再接受任意值。API 请求的 `json` 字段也使用 JSON 类型。

网络错误和响应解析错误的 `cause` 对外统一为 `Error`。运行时捕获值通过一个规范化函数转换：已有 `Error` 原样保留；其他可表示值转换为带稳定消息的 `Error`。这样调用方只处理 `Error`，同时不假定 JavaScript 运行时只能抛出 `Error`。

## 4. 各边界处理

### 4.1 API 客户端

- `apiRequest` 不再以 `unknown` 作为默认响应类型；调用方必须指定响应类型，或使用明确的 JSON 默认类型。
- JSON 解析结果先作为 `JsonValue` 处理，再在泛型响应边界转换为调用方声明的响应类型。
- 错误响应只保留 JSON 值、字符串或未提供状态；错误消息提取使用 `JsonObject` 守卫。
- XHR、Fetch 网络异常和 JSON 解析异常均转换为 `Error` 后交给错误类。

### 4.2 React 请求状态与写操作

- 页面请求状态的错误字段使用 `Error`。
- Promise rejection 和 `catch` 捕获值在进入状态、分类函数或组件 props 前统一规范化。
- 编辑器写入错误分类函数接收 `Error`，继续识别现有 `ApiError` 状态码，不改变冲突、认证过期或媒体收尾警告语义。

### 4.3 本地存储

- 播放进度读取使用明确的 JSON 候选类型。
- 递归 JSON 对象守卫返回 `JsonObject`，字段仍逐项验证类型、有限数值和业务约束。
- 无效、损坏或不可读取的数据继续回退为空状态。

### 4.4 测试与 E2E

- 测试 JSON 响应 helper 接受 `JsonValue`。
- 模拟请求体使用 `JsonValue | FormData | BodyInit | null | undefined` 中与该 helper 实际行为匹配的联合类型。
- JSON 和 FormData 分别通过专用 helper 收窄，不在共享请求对象上使用宽泛逃逸类型。
- E2E 写请求数据与保存状态使用 JSON 类型；具体 API 响应继续由现有泛型声明。

## 5. 错误处理

类型调整不得吞掉异常或弱化现有错误分类：

- `ApiError` 保留 HTTP 状态、状态文本、消息和结构化详情。
- `ApiNetworkError` 仍识别 `AbortError` 并保留 `aborted` 标志。
- `ApiResponseParseError` 仍保留响应状态和规范化后的解析异常。
- 页面仍按现有逻辑处理 401、403、409、媒体替换收尾警告和普通网络错误。

## 6. 测试策略

先增加失败的静态契约测试，扫描 `frontend/**/*.ts(x)` 与 `tests/e2e/**/*.ts`，禁止以下数据类型写法：

- `: unknown`
- `as unknown`
- `Record<..., unknown>`
- 泛型默认值 `= unknown`

该测试不匹配字符串、测试名称、注释或业务数据中的普通单词。随后逐边界替换类型并验证：

- API 客户端测试与构建。
- 公开站测试与构建。
- 管理后台测试与构建。
- UI 共享包测试与构建。
- 根 Node 契约测试与 E2E runner 安全测试。
- `git diff --check`。

后端接口、数据库和跨服务流程不变，因此不需要新增 Rust 或 Playwright 业务验收。

## 7. 验收标准

- `frontend/` 和 `tests/e2e/` 中不再使用 `unknown` 作为 TypeScript 数据类型。
- 外部 JSON、异常、本地存储和测试请求体都有明确的命名类型及运行时收窄。
- 不以 `any`、关闭严格模式或取消校验来替代 `unknown`。
- 所有现有前端行为、错误语义和上传进度行为保持不变。
- 静态契约测试、全部前端测试、全部前端构建和根 Node 契约测试通过。
