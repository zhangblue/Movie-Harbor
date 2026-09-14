# 已发布或归档剧集查看态季折叠实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 进入已发布或已归档剧集查看态时折叠所有已有季，同时保留新建和新增季的自动展开。

**架构：** `SeriesEditor` 计算 `viewOnly = !!series && series.status !== "draft"`，以只依赖该布尔值的 effect 在进入查看态时清空 `expandedSeasons`。现有 `accept` 继续只移除已不存在的季 ID，故查看态内刷新、`published`/ `archived` 互转和新季创建不会重复折叠。

**技术栈：** React 19、TypeScript、Vitest、Testing Library、Playwright。

---

## 文件结构

- 修改 `frontend/admin-web/src/series/SeriesEditor.tsx`：仅在进入查看态时重置展开集合。
- 修改 `frontend/admin-web/src/series/SeriesEditor.test.tsx`：覆盖发布转换 RED，以及经 `App` 的已发布/已归档“查看”入口。
- 修改 `tests/e2e/series.spec.ts`：覆盖真实发布后、已发布列表查看和已归档列表查看。

### 任务 1：进入查看态时折叠已有季

**文件：**
- 修改：`frontend/admin-web/src/series/SeriesEditor.tsx:35-50`
- 修改：`frontend/admin-web/src/series/SeriesEditor.test.tsx:111-127, 553-563`
- 修改：`tests/e2e/series.spec.ts:37-75`

- [ ] **步骤 1：编写发布转换的失败测试**

在 `SeriesEditor.test.tsx` 的现有折叠测试后新增。此测试的 RED 是当前真实缺口，不重复已有“初始加载已折叠”测试：

```tsx
it("collapses existing seasons when a draft enters view mode without resetting later view refreshes", async () => {
  fixture();
  const user = userEvent.setup();
  editor();
  await user.click(await screen.findByRole("button", { name: "展开第 1 季" }));
  expect(screen.getByRole("button", { name: "折叠第 1 季" })).toHaveAttribute("aria-expanded", "true");

  await user.click(screen.getByRole("button", { name: "发布剧集" }));
  await screen.findByRole("heading", { name: "查看剧集" });
  expect(await screen.findByRole("button", { name: "展开第 1 季" })).toHaveAttribute("aria-expanded", "false");

  await user.click(screen.getByRole("button", { name: "展开第 1 季" }));
  await user.click(screen.getByRole("button", { name: "归档剧集" }));
  expect(await screen.findByRole("button", { name: "折叠第 1 季" })).toHaveAttribute("aria-expanded", "true");
});
```

- [ ] **步骤 2：运行测试验证 RED**

运行：

```bash
npm test --workspace @movie-harbor/admin-web -- src/series/SeriesEditor.test.tsx
```

预期：FAIL。发布后的 `refresh` 只调用 `accept`，而当前 `accept` 仅过滤失效 ID，因此“折叠第 1 季”仍存在，期望的“展开第 1 季”不存在。

- [ ] **步骤 3：添加列表“查看”入口集成回归**

在同一文件增加参数化 `App` 测试；它分别覆盖已发布和已归档行进入同一编辑器。该测试可在实现前通过，作为入口防回归覆盖：

```tsx
it.each(["published", "archived"] as const)("opens a %s series from the content list with its seasons collapsed", async (status) => {
  fixture(detail({ status }));
  const user = userEvent.setup();
  render(<App />);
  const row = within(await screen.findByRole("row", { name: /长夜航线/ }));
  await user.click(row.getByRole("button", { name: "查看" }));
  expect(await screen.findByRole("heading", { name: "查看剧集" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "展开第 1 季" })).toHaveAttribute("aria-expanded", "false");
});
```

- [ ] **步骤 4：实现最小查看态重置**

紧接 `expandedSeasons` state 声明加入以下代码：

```tsx
const [expandedSeasons, setExpandedSeasons] = useState<Set<string>>(() => new Set());
const viewOnly = !!series && series.status !== "draft";
useEffect(() => {
  if (viewOnly) setExpandedSeasons(new Set());
}, [viewOnly]);
```

保留现有 `accept` 的 ID 过滤，不在发布处理器中直接重置，也不得把 `series.status`、版本、季数组、`series` 或 `accept` 放入依赖数组。不得重建编辑器、改动 `newSeasons` 或修改 `SeasonCard`。

- [ ] **步骤 5：运行 GREEN、管理后台回归和构建**

```bash
npm test --workspace @movie-harbor/admin-web -- src/series/SeriesEditor.test.tsx
npm test --workspace @movie-harbor/admin-web
npm run build --workspace @movie-harbor/admin-web
```

预期：全部通过。发布后显示“展开第 1 季”；手动展开后归档仍显示“折叠第 1 季”；两类列表“查看”均折叠，首季/新增季的既有自动展开测试继续通过。

- [ ] **步骤 6：扩展 E2E，并先 RED 后 GREEN**

在 `series.spec.ts` 的发布成功后替换为以下入口流程，再继续原有“添加一集”操作：

```tsx
await page.getByRole("button", { name: "发布剧集" }).click();
await expect(page.getByRole("heading", { name: "查看剧集" })).toBeVisible();
const publishedSeason = page.getByRole("article", { name: "第 1 季" });
await expect(publishedSeason.getByRole("button", { name: "展开第 1 季" })).toHaveAttribute("aria-expanded", "false");
await page.getByRole("button", { name: "返回列表" }).click();
const publishedRow = page.getByRole("row", { name: new RegExp(name) });
await publishedRow.getByRole("button", { name: "查看" }).click();
const seasonCard = page.getByRole("article", { name: "第 1 季" });
await expect(seasonCard.getByRole("button", { name: "展开第 1 季" })).toHaveAttribute("aria-expanded", "false");
await seasonCard.getByRole("button", { name: "展开第 1 季" }).click();
```

保留归档后列表“查看”中的“展开第 1 季”断言和点击；不删除公开目录 404、单集状态转换、确认删除或媒体文件删除断言，也不增加超时。先在步骤 4 前运行：

```bash
npm run test:e2e -- --grep "a series publishes episodes incrementally and archives immediately"
```

预期：RED，发布后的页面找不到“展开第 1 季”。步骤 4 后重跑同一命令，预期 PASS；随后运行：

```bash
npm run test:e2e
node --test tests/e2e/run-safety.test.mjs
```

- [ ] **步骤 7：运行完整相关验证**

```bash
docker compose -f docker-compose.test.yml up -d postgres
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/movie_harbor_test' cargo test --workspace
npm test --workspaces
npm run build --workspaces
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
npm run test:e2e
git diff --check
git status --short
```

预期：全部退出码为 0；无 diff 空白错误；没有生成的生产或 E2E 数据目录进入 Git。

- [ ] **步骤 8：提交**

```bash
git add frontend/admin-web/src/series/SeriesEditor.tsx frontend/admin-web/src/series/SeriesEditor.test.tsx tests/e2e/series.spec.ts docs/superpowers/plans/2026-09-14-published-series-view-collapse.md
git commit -m "fix: 折叠剧集查看态已有季"
git status --short
```

预期：提交后没有未提交的实现文件。

## 完成定义

- 草稿发布后在同一编辑器内查看已有季时全部折叠。
- 已发布和已归档剧集从内容列表“查看”进入时全部折叠。
- 查看态内刷新或状态互转不会再次收起管理员手动展开的季；新增季仍自动展开。
