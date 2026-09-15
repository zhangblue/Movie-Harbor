# 任务 4：共享前端 API 响应体校验

## 状态

已完成。

## 实现

- 在 `frontend/packages/api-client/src/http.ts` 导出共享 `requiredResponse`，仅将 `undefined` 判定为缺失响应体，并保留 `null` 等合法值。
- `admin.ts` 与 `public.ts` 改为导入并使用共享函数，删除本地重复实现。
- 在 `http.test.ts` 增加响应体校验测试。
- 未改变任何请求路径、HTTP method、query、错误类型或返回类型。

## RED/GREEN

- RED：新增测试首次运行失败，原因为 `requiredResponse is not a function`。
- GREEN：实现共享函数并替换调用方后测试通过。

## 验证

- `npm test --workspace @movie-harbor/api-client`：24 tests passed（2 test files）。
- `npm run build --workspace @movie-harbor/api-client`：通过（`tsc --noEmit`）。
- `git diff --check`：通过。

## 疑虑

无。
