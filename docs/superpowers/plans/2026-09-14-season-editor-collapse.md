# 剧集编辑页季折叠与按钮对齐实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让剧集编辑页的已有季默认紧凑折叠、新建季自动展开，并使“保存季序号”和“删除本季”在所有布局下严格等高且底边对齐。

**架构：** `SeriesEditor` 维护已展开季 ID 集合，使展开选择不受服务端层级刷新影响；`SeasonCard` 作为受控视图，用原生按钮、`aria-expanded`、`aria-controls` 和常驻 React 树的 `hidden` 内容区呈现折叠。按钮对齐使用管理后台局部 CSS 类，不修改共享 `Button` 尺寸或任何后端接口。

**技术栈：** React 19、TypeScript、Vitest、Testing Library、CSS。

---

## 文件结构

- 修改 `frontend/admin-web/src/series/SeriesEditor.tsx`：拥有展开季集合，在加载、新建、刷新和删除过程中维护季 ID。
- 修改 `frontend/admin-web/src/series/SeasonCard.tsx`：呈现紧凑折叠标题栏、可访问切换按钮和不卸载的季内容区。
- 修改 `frontend/admin-web/src/series/SeriesEditor.test.tsx`：锁定默认折叠、独立展开、输入保留、新季自动展开、刷新保持、权限与按钮样式契约。
- 修改 `frontend/admin-web/src/styles.css`：提供季标题、内容区、控制区和等高操作按钮的局部样式。

## 全局约束

- 设计规格是 `docs/superpowers/specs/2026-09-14-season-editor-collapse-design.md`。
- 只修改上述四个管理后台文件；不修改 API、后端、数据库、公开站、Demo 或部署文件。
- 已有季默认折叠；当前流程中新创建或恢复的空季自动展开；多个季可以同时展开。
- 季内容必须始终保留在 React 树中，只使用 `hidden` 控制可见性，折叠不得丢失未保存输入。
- 折叠按钮不受业务编辑权限限制；所有现有保存、删除、添加、生命周期与错误处理权限保持不变。
- 两个任务分别由不同的全新子代理顺序执行并独立提交；Task 2 基于已审查通过的 Task 1。

### 任务 1：实现季的受控折叠交互

**文件：**
- 修改：`frontend/admin-web/src/series/SeriesEditor.tsx`
- 修改：`frontend/admin-web/src/series/SeasonCard.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.test.tsx`
- 修改：`frontend/admin-web/src/styles.css`

- [ ] **步骤 1：编写默认折叠、独立展开和输入保留的失败测试**

在 `frontend/admin-web/src/series/SeriesEditor.test.tsx` 增加多季测试。第二季的单集必须使用不同 ID 和 `season_id`：

```tsx
it("defaults existing seasons to independent accessible collapses without losing input", async () => {
  fixture(detail({ seasons: [
    { id: "s1", number: 1, episodes: [episode()] },
    { id: "s2", number: 2, episodes: [episode({ id: "e2", season_id: "s2", name: "回声" })] },
  ] }));
  const user = userEvent.setup();
  editor();

  const first = await screen.findByRole("button", { name: "展开第 1 季" });
  const second = screen.getByRole("button", { name: "展开第 2 季" });
  const firstCard = screen.getByRole("article", { name: "第 1 季" });
  expect(first).toHaveAttribute("aria-expanded", "false");
  expect(first).toHaveAttribute("aria-controls");
  expect(second).toHaveAttribute("aria-expanded", "false");
  expect(screen.getAllByText("1 集")).toHaveLength(2);
  expect(within(firstCard).getByLabelText("季序号")).not.toBeVisible();

  await user.click(first);
  expect(screen.getByRole("button", { name: "折叠第 1 季" })).toHaveAttribute("aria-expanded", "true");
  const name = within(firstCard).getByLabelText("单集名称");
  await user.type(name, "未保存");
  await user.click(second);
  expect(screen.getByRole("button", { name: "折叠第 2 季" })).toHaveAttribute("aria-expanded", "true");

  await user.click(screen.getByRole("button", { name: "折叠第 1 季" }));
  expect(screen.getByRole("button", { name: "折叠第 2 季" })).toHaveAttribute("aria-expanded", "true");
  await user.click(screen.getByRole("button", { name: "展开第 1 季" }));
  expect(within(firstCard).getByLabelText("单集名称")).toHaveValue("来信未保存");
});
```

- [ ] **步骤 2：编写新季自动展开和层级刷新保持展开的失败测试**

继续在同一测试文件增加：

```tsx
it("opens only a newly added season and keeps opened seasons across hierarchy updates", async () => {
  fixture();
  const user = userEvent.setup();
  editor();

  await user.click(await screen.findByRole("button", { name: "展开第 1 季" }));
  await user.click(screen.getByRole("button", { name: "保存单集草稿" }));
  await screen.findByText("单集草稿已保存。");
  expect(screen.getByRole("button", { name: "折叠第 1 季" })).toHaveAttribute("aria-expanded", "true");

  await user.click(screen.getByRole("button", { name: "添加一季" }));
  expect(await screen.findByRole("button", { name: "折叠第 2 季" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: "折叠第 1 季" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("0 集")).toBeInTheDocument();
  expect(screen.getByRole("form", { name: "新单集草稿" })).toBeVisible();
});
```

在现有 `locks published series fields and seasons with published episodes while permitting new drafts` 测试中，先点击“展开第 1 季”，再执行原有禁用态断言，证明折叠控制没有改变业务权限。

- [ ] **步骤 3：运行测试确认 RED**

```bash
npm test --workspace @movie-harbor/admin-web -- src/series/SeriesEditor.test.tsx
```

预期：FAIL。页面没有“展开第 N 季”按钮；季内容默认可见；新季也没有受控展开语义。现有测试如果因默认折叠而找不到单集或季操作，应只在那些测试的首次操作前显式展开对应季，不得削弱原断言。

- [ ] **步骤 4：在 `SeriesEditor` 实现展开季集合**

在现有 `newSeasons` 状态旁新增：

```tsx
const [expandedSeasons, setExpandedSeasons] = useState<Set<string>>(() => new Set());
```

让 `accept` 在每次接收层级时只清理已不存在的 ID，不收起仍存在的季：

```tsx
function accept(value: SeriesResponse, resetFields = false) {
  current.current = value; setSeries(value);
  setExpandedSeasons((ids) => new Set([...ids].filter((id) => value.seasons.some((season) => season.id === id))));
  if (resetFields) setFields(fieldsOf(value));
}
```

在加载 effect 开始时同时重置集合：

```tsx
setNewSeasons([]); setExpandedSeasons(new Set());
```

恢复当前新建流程中的空季时，共用同一组 ID 初始化未保存单集和展开集合：

```tsx
if (resumeCreation) {
  const seasonIds = value.seasons.filter((season) => season.episodes.length === 0).map((season) => season.id);
  setNewSeasons(seasonIds);
  setExpandedSeasons(new Set(seasonIds));
}
```

创建新剧的首季成功后，用响应中的季 ID 同时初始化两个集合：

```tsx
const saved = await createSeason(created.id, 1, created.version);
if (!mounted.current) return;
const seasonIds = saved.seasons.map((season) => season.id);
setNewSeasons(seasonIds);
setExpandedSeasons(new Set(seasonIds));
accept(saved);
```

添加一季成功后先计算真正新增的 ID，再保留已有集合并加入新 ID：

```tsx
const createdIds = saved.seasons.filter((candidate) => !series.seasons.some((old) => old.id === candidate.id)).map((candidate) => candidate.id);
accept(saved);
setNewSeasons((ids) => [...ids, ...createdIds]);
setExpandedSeasons((ids) => new Set([...ids, ...createdIds]));
```

给每个 `SeasonCard` 传入受控状态和切换回调：

```tsx
expanded={expandedSeasons.has(season.id)}
onToggle={() => setExpandedSeasons((ids) => {
  const next = new Set(ids);
  if (next.has(season.id)) next.delete(season.id); else next.add(season.id);
  return next;
})}
```

- [ ] **步骤 5：在 `SeasonCard` 实现可访问折叠视图**

从 React 导入 `useId`，扩展 props：

```tsx
expanded: boolean;
onToggle: () => void;
```

生成无冲突内容 ID：

```tsx
const bodyId = useId();
```

把现有季操作和单集内容移动到始终渲染的 body 中；不要用条件渲染移除 body。完整的 `return` 结构改为：

```tsx
return <article className="series-season" aria-label={`第 ${season.number} 季`}>
  <div className="series-season-summary">
    <button type="button" className="series-season-toggle"
      aria-expanded={expanded} aria-controls={bodyId}
      aria-label={`${expanded ? "折叠" : "展开"}第 ${season.number} 季`}
      onClick={onToggle}><span aria-hidden="true">{expanded ? "⌄" : "›"}</span></button>
    <h3>第 {season.number} 季</h3>
    <span className="series-season-count">{season.episodes.length} 集</span>
  </div>
  <div id={bodyId} className="series-season-body" hidden={!expanded}>
    <div className="series-season-controls">
      <form className="movie-inline-fields" onSubmit={(event) => { event.preventDefault(); update(Number(number)); }}>
        <Field label="季序号" className="movie-field-short"><input type="number" min="1" required value={number} disabled={disabled || !canChangeSeason(series, season, "edit")} onChange={(event) => setNumber(event.target.value)} /></Field>
        <Button type="submit" disabled={disabled || !canChangeSeason(series, season, "edit")}>保存季序号</Button>
      </form>
      <Button variant="danger" disabled={disabled || !canChangeSeason(series, season, "delete")} onClick={remove}>删除本季</Button>
    </div>
    {!canChangeSeason(series, season, "edit") && <p>存在已发布单集或权限受限，季序号与删除已锁定。</p>}
    {season.episodes.map((episode) => <EpisodeRow key={episode.id} episode={episode} disabled={disabled || !knownStatus(series.status)} actions={actions} />)}
    {drafts.map((draft) => <NewEpisode key={draft.key} number={draft.number} disabled={disabled || !canAdd} create={create} changeNumber={(value) => setDrafts((values) => values.map((candidate) => candidate.key === draft.key ? { ...candidate, number: value } : candidate))} remove={() => setDrafts((values) => values.filter((candidate) => candidate.key !== draft.key))} />)}
    <Button disabled={disabled || !canAdd} onClick={() => setDrafts((values) => [...values, { key: next.current++, number: Math.max(0, ...season.episodes.map((episode) => episode.number), ...values.map((episode) => episode.number)) + 1 }])}>添加一集</Button>
  </div>
</article>;
```

在 `frontend/admin-web/src/styles.css` 添加最少布局样式；本 Task 不加入按钮等高规则：

```css
.series-season { overflow: hidden; padding: 0; }
.series-season-summary { display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 12px 16px; background: #1b2636; }
.series-season-summary h3 { margin: 0; font-size: 16px; }
.series-season-count { margin-left: auto; color: var(--mh-color-text-muted); font-size: 12px; }
.series-season-toggle { display: grid; width: 38px; height: 38px; flex: none; padding: 0; place-items: center; border: 1px solid var(--mh-color-border-strong); border-radius: var(--mh-radius-sm); background: #242c3c; color: var(--mh-color-text); font: inherit; font-size: 20px; }
.series-season-toggle:hover { background: var(--mh-color-surface-hover); }
.series-season-toggle:focus-visible { outline: none; box-shadow: var(--mh-focus-ring); }
.series-season-body { padding: 18px; border-top: 1px solid var(--mh-color-border); }
.series-season-controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.series-season-controls .movie-inline-fields { align-items: end; }
```

移除被新类替代的旧 `.series-season-header` 规则，避免两套季标题布局并存。

- [ ] **步骤 6：运行 GREEN、相关回归和构建**

```bash
npm test --workspace @movie-harbor/admin-web -- src/series/SeriesEditor.test.tsx
npm test --workspace @movie-harbor/admin-web
npm run build --workspace @movie-harbor/admin-web
git diff --check
git status --short
```

预期：测试和构建全部通过；状态只包含 Task 1 的四个文件；折叠测试经过 RED/GREEN；现有权限、删除、保存和错误恢复测试不被删除或弱化。

- [ ] **步骤 7：独立提交 Task 1**

```bash
git add frontend/admin-web/src/series/SeriesEditor.tsx frontend/admin-web/src/series/SeasonCard.tsx frontend/admin-web/src/series/SeriesEditor.test.tsx frontend/admin-web/src/styles.css
git commit -m "feat: 添加剧集季折叠交互"
```

### 任务 2：修正季操作按钮等高和底部对齐

**文件：**
- 修改：`frontend/admin-web/src/series/SeasonCard.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.test.tsx`
- 修改：`frontend/admin-web/src/styles.css`

- [ ] **步骤 1：编写按钮实际计算样式的失败测试**

`SeriesEditor.test.tsx` 已通过 `App` 加载真实管理后台样式。在该文件增加测试，直接验证渲染按钮及其布局容器的浏览器计算样式，不读取或匹配 CSS 源码文本：

```tsx
it("renders the season save and delete actions at the same explicit height and bottom alignment", async () => {
  fixture();
  const user = userEvent.setup();
  editor();
  await user.click(await screen.findByRole("button", { name: "展开第 1 季" }));

  const save = screen.getByRole("button", { name: "保存季序号" });
  const remove = screen.getByRole("button", { name: "删除本季" });
  const numberForm = save.closest("form");
  const controls = numberForm?.parentElement;

  expect(numberForm).not.toBeNull();
  expect(controls).not.toBeNull();
  expect(getComputedStyle(save).height).toBe("38px");
  expect(getComputedStyle(remove).height).toBe("38px");
  expect(getComputedStyle(numberForm as HTMLElement).alignItems).toBe("flex-end");
  expect(getComputedStyle(controls as HTMLElement).alignItems).toBe("flex-end");
});
```

- [ ] **步骤 2：运行测试确认 RED**

```bash
npm test --workspace @movie-harbor/admin-web -- src/series/SeriesEditor.test.tsx
```

预期：FAIL。两个按钮还没有明确的 `38px` 计算高度，控制区也没有两层底部对齐。失败来自真实渲染结果，而不是对 CSS 源码文本的检查。

- [ ] **步骤 3：实现最小按钮对齐修复**

把 Task 1 中季控制区的表单开始标签精确替换为：

```tsx
<form className="movie-inline-fields series-season-number-form" onSubmit={(event) => { event.preventDefault(); update(Number(number)); }}>
```

季序号 `Field` 保持不变；把表单内保存按钮精确替换为：

```tsx
<Button className="series-season-action" type="submit" disabled={disabled || !canChangeSeason(series, season, "edit")}>保存季序号</Button>
```

把表单后的删除按钮精确替换为：

```tsx
<Button className="series-season-action" variant="danger" disabled={disabled || !canChangeSeason(series, season, "delete")} onClick={remove}>删除本季</Button>
```

更新局部 CSS：

```css
.series-season-controls { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
.series-season-number-form { align-items: flex-end; }
.series-season-action { height: 38px; }
```

不得修改 `frontend/packages/ui/src/Button.tsx` 或全局 `.mh-button`，不得改变危险色、禁用条件和事件处理。

- [ ] **步骤 4：运行 GREEN 和管理后台回归**

```bash
npm test --workspace @movie-harbor/admin-web -- src/series/SeriesEditor.test.tsx
npm test --workspace @movie-harbor/admin-web
npm run build --workspace @movie-harbor/admin-web
git diff --check
git status --short
```

预期：所有命令退出码为 0；状态只包含本 Task 的三个文件；测试通过真实计算样式锁定两个按钮的 `38px` 高度及两层底部对齐。

- [ ] **步骤 5：独立提交 Task 2**

```bash
git add frontend/admin-web/src/series/SeasonCard.tsx frontend/admin-web/src/series/SeriesEditor.test.tsx frontend/admin-web/src/styles.css
git commit -m "fix: 对齐剧集季操作按钮"
```

## 最终集成验证

两个 Task 分别审查通过后，在整个分支上运行：

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

预期：所有命令退出码为 0；Playwright 验证现有剧集创建、发布与删除流程没有回归；工作树只保留被 Git 忽略的头脑风暴原型，不包含未提交实现文件。

## 完成定义

- 已有季首次进入编辑器时全部折叠，新创建或当前创建流程恢复出的空季自动展开。
- 多季可独立展开，折叠和服务端层级刷新不会丢失输入或无故收起当前季。
- 折叠标题准确显示季序号和已保存单集数量，0 集显示“0 集”。
- 折叠按钮具备正确的键盘、`aria-expanded`、`aria-controls` 和动态名称语义，只读季也可以展开查看。
- “保存季序号”和“删除本季”共享局部 `38px` 高度契约并底部对齐，窄屏换行时高度仍一致。
- 现有业务权限、生命周期、删除确认、媒体上传、错误恢复、后端接口和公开站行为均保持不变。
