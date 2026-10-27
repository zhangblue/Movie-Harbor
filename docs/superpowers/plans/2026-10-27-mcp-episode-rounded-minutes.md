# MCP 单集整数分钟实现计划

设计依据：`../specs/2026-10-27-mcp-episode-rounded-minutes-design.md`。

1. 在 `mcp/tests/content-tools.test.ts` 为创建与更新添加秒数到整分钟的请求体断言，确认旧代码因原样写入而失败；覆盖 1、29、30、89、90、120、4395、3584 和最大合法秒数。
2. 在 `mcp/src/schemas/common.ts` 复用现有分钟换算；`mcp/src/tools/series.ts` 在参数校验后、HTTP 前执行取整，仅处理显式提交的时长。
3. 更新工具和 server 说明、使用指南；协议测试断言说明包含四舍五入与最少一分钟。
4. 同步现有 MCP E2E 调用到已发布的确认和电影分钟制契约，增加从真实后端读取单集创建、更新时长的断言。
5. 执行 `npm run test:mcp`、`npm run build:mcp`、`node --test tests/documentation.test.mjs`、`npm run test:e2e` 和 `git diff --check`。审阅 diff，仅提交本次文件到 main，推送 origin/main 并核验远端提交。
