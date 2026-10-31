# 任务 2：共享 API 客户端明确查询类型

## 状态

已完成。

## 提交 SHA

实现提交：`6e42f33e833d561a282b42288f2b83bcc144069f`（`feat: expose private catalog query`）。

## 改动摘要

- `CatalogQuery.privacy` 明确为可选字面量类型 `"private"`。
- `listCatalog` 显式转发 `privacy`，仍忽略调用对象上的无关属性。
- 新增客户端契约测试，检查 URL 查询参数以及隐私查询的精确类型。

## 红灯验证

命令：`npm test --prefix frontend/packages/api-client -- --run src/public.test.ts`

测试文件首次运行时因尚未安装依赖而未能启动（`vitest: command not found`）。安装锁定依赖后重跑，同一命令得到预期失败：URL 实际值缺少 `privacy=private`；另一项运行时类型测试通过。该差异确认了请求转发缺失。

## 绿灯验证

- `npm test --prefix frontend/packages/api-client -- --run src/public.test.ts`：通过，2 项测试。
- `npm run build --prefix frontend/packages/api-client`：通过，`tsc --noEmit`。
- `git diff --check`：通过，无空白错误。

## 自审

改动仅限共享 API 客户端类型、查询转发、对应测试与本报告。隐私字段没有使用 `unknown`、开放字符串或索引签名；契约测试同时确认查询对象的多余 `include_private` 不会进入 URL。

## 疑虑

无。首次测试受缺失依赖影响；安装锁定依赖后已完成红灯与绿灯验证。
