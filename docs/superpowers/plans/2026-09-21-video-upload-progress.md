# 视频上传进度条实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在电影视频和单集视频上传时展示真实、单调不倒退的上传百分比，并在请求体传输完成后明确展示服务端校验保存状态。

**架构：** 在共享 API 客户端中增加一个只服务带进度媒体上传的 `XMLHttpRequest` 传输边界，复用现有同源 URL、CSRF、响应解析和错误类型；无进度回调的海报上传继续走现有 `fetch`。电影编辑器持有电影视频进度，单集行持有各自的视频进度，共用 `VideoPicker` 的无障碍展示组件；后端接口和媒体存储逻辑不变。

**技术栈：** TypeScript 6、React 19、XMLHttpRequest/ProgressEvent、Vitest 4、Testing Library、Vite 8。

---

## 文件结构

- 修改 `frontend/packages/api-client/src/http.ts`：增加带上传进度的同源 XHR 请求，并复用现有响应与错误契约。
- 修改 `frontend/packages/api-client/src/http.test.ts`：使用可控 XHR 替身覆盖进度、处理阶段、认证头和失败映射。
- 修改 `frontend/packages/api-client/src/admin.ts`：让 `uploadMedia` 接受可选进度回调；只有传入回调时使用新上传请求。
- 修改 `frontend/packages/api-client/src/admin.test.ts`：验证媒体目标路径、版本参数和进度回调转发。
- 创建 `frontend/admin-web/src/test/uploadXhr.ts`：为管理后台测试提供可自动响应或手动推进的 XHR 替身，并继续委托现有 `fetch` fixture 生成响应。
- 修改 `frontend/admin-web/src/test/server.ts`：仅在通用测试需要时导出上传 XHR 安装辅助函数所需的请求类型；不改变生产代码。
- 修改 `frontend/admin-web/src/movies/VideoPicker.tsx`：展示待上传、确定进度、不确定进度和校验保存状态。
- 创建 `frontend/admin-web/src/movies/VideoPicker.test.tsx`：验证进度语义、文案和只读边界。
- 修改 `frontend/admin-web/src/movies/MovieEditor.tsx`：持有并清理电影视频上传状态，只为视频请求传入进度回调。
- 修改 `frontend/admin-web/src/movies/MovieEditor.test.tsx`：验证电影视频的真实进度、100% 后等待状态、成功清理和失败重试。
- 修改 `frontend/admin-web/src/series/EpisodeRow.tsx`：持有当前单集的视频上传状态并把回调传入保存动作。
- 修改 `frontend/admin-web/src/series/SeriesEditor.tsx`：把单集进度回调传给共享媒体上传函数。
- 修改 `frontend/admin-web/src/series/SeriesEditor.test.tsx`：验证进度只出现在目标单集，并回归版本刷新和发布顺序。
- 修改 `frontend/admin-web/src/styles.css`：增加与现有深色紧凑表单一致的内联进度条样式和稳定高度。

### 任务 1：建立共享的真实上传进度传输边界

**文件：**
- 修改：`frontend/packages/api-client/src/http.ts`
- 修改：`frontend/packages/api-client/src/http.test.ts`
- 修改：`frontend/packages/api-client/src/admin.ts`
- 修改：`frontend/packages/api-client/src/admin.test.ts`

- [ ] **步骤 1：为底层上传请求编写失败测试**

在 `http.test.ts` 中增加一个测试专用 `FakeXMLHttpRequest`。它需要记录 `open()` 的 method/URL、`setRequestHeader()`、`send()` 的 body，并暴露 `upload: EventTarget` 和完成响应的方法。用它先覆盖以下失败用例：

```ts
it("reports monotonic upload progress and a processing phase", async () => {
  const xhr = installFakeXhr();
  const events: ApiUploadProgress[] = [];
  const request = apiUpload<{ ok: boolean }>("/api/admin/media/movies/movie-1/video", {
    method: "POST",
    query: { version: 4 },
    body: new FormData(),
    onProgress: (event) => events.push(event),
  });

  xhr.uploadProgress({ lengthComputable: true, loaded: 40, total: 100 });
  xhr.uploadProgress({ lengthComputable: true, loaded: 30, total: 100 });
  xhr.finishUpload();
  xhr.respond(200, '{"ok":true}', { "content-type": "application/json" });

  await expect(request).resolves.toEqual({ ok: true });
  expect(events).toEqual([
    { phase: "uploading", percent: 0 },
    { phase: "uploading", percent: 40 },
    { phase: "uploading", percent: 40 },
    { phase: "processing", percent: 100 },
  ]);
});
```

再添加独立断言：

```ts
expect(events.at(-1)).toEqual({ phase: "uploading", percent: null });
expect(xhr.url).toBe("/api/admin/media/movies/movie-1/video?version=4");
expect(xhr.headers.get("accept")).toBe("application/json");
expect(xhr.headers.get("x-csrf-token")).toBe("session-csrf");
expect(xhr.headers.has("content-type")).toBe(false);
```

不可计算总量的用例必须发送 `lengthComputable: false`；另用 HTTP 415 JSON、无效成功 JSON、`error`、`timeout` 和 `abort` 事件断言分别得到现有 `ApiError`、`ApiResponseParseError` 和 `ApiNetworkError`，其中 abort 的 `aborted` 为 `true`。

- [ ] **步骤 2：运行底层测试确认失败**

运行：

```bash
npm test --workspace @movie-harbor/api-client -- src/http.test.ts
```

预期：FAIL，`ApiUploadProgress` 和 `apiUpload` 尚未导出。

- [ ] **步骤 3：实现最小上传类型和 XHR 请求**

在 `http.ts` 中定义稳定的展示事件：

```ts
export type ApiUploadProgress =
  | { phase: "uploading"; percent: number | null }
  | { phase: "processing"; percent: 100 };

export interface ApiUploadInit {
  method: "POST";
  body: FormData;
  query?: Query;
  onProgress: (progress: ApiUploadProgress) => void;
}
```

实现 `apiUpload<T>()` 时必须：

1. 用 `buildApiUrl()` 构造并验证 URL。
2. 添加 `Accept: application/json` 和当前 CSRF token，但不设置 `Content-Type`。
3. 在 `send()` 前注册 `xhr.upload` 的 `progress`、`load` 监听器以及 `xhr` 的 `load`、`error`、`timeout`、`abort` 监听器。
4. 在 `send()` 前报告 `{ phase: "uploading", percent: 0 }`。
5. 对可计算事件使用 `Math.floor(loaded / total * 100)`，限制在 0–100，并与上次百分比取最大值。
6. 对不可计算事件报告 `percent: null`；一旦获得可计算百分比，后续不可计算事件不得把已知百分比退回未知。
7. 上传 `load` 时报告 `{ phase: "processing", percent: 100 }`，但不提前 resolve。
8. 请求 `load` 时把 `responseText`、状态、状态文本和响应头转换为 `Response`，复用现有成功解析和 `responseError()`；204/205 构造 `Response` 时使用 `null` body。
9. 确保 Promise 只结算一次；`error`、`timeout` 和 `abort` 后不得再处理 `load`。

核心结构：

```ts
export function apiUpload<T>(path: string, init: ApiUploadInit): Promise<T | undefined> {
  const url = buildApiUrl(path, init.query);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastPercent: number | null = 0;
    let settled = false;

    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        if (lastPercent === 0) init.onProgress({ phase: "uploading", percent: null });
        return;
      }
      lastPercent = Math.max(lastPercent ?? 0, Math.min(100, Math.floor(event.loaded / event.total * 100)));
      init.onProgress({ phase: "uploading", percent: lastPercent });
    });
    xhr.upload.addEventListener("load", () => init.onProgress({ phase: "processing", percent: 100 }));
    // xhr load/error/timeout/abort handlers settle through existing error classes.
    xhr.open(init.method, url, true);
    xhr.setRequestHeader("Accept", "application/json");
    if (csrfToken) xhr.setRequestHeader("X-CSRF-Token", csrfToken);
    init.onProgress({ phase: "uploading", percent: 0 });
    xhr.send(init.body);
  });
}
```

不要把 `csrfToken` 导出，也不要给页面暴露 `XMLHttpRequest` 或取消句柄。

- [ ] **步骤 4：运行底层测试确认通过**

运行：

```bash
npm test --workspace @movie-harbor/api-client -- src/http.test.ts
npm run build --workspace @movie-harbor/api-client
```

预期：PASS；普通 `apiRequest` 和 `apiDownload` 测试仍通过。

- [ ] **步骤 5：为 `uploadMedia` 分流编写失败测试**

在 `admin.test.ts` 中加入两个测试：

- 未提供进度回调的海报上传仍调用现有 `fetch`。
- 提供进度回调的视频上传调用 `apiUpload`，保留编码后的目标路径与 `version` 参数，并把进度事件原样转交调用方。

目标调用签名：

```ts
uploadMedia(
  { kind: "movies", id: "movie/1", slot: "video" },
  new File(["video"], "one.mp4", { type: "video/mp4" }),
  7,
  (progress) => events.push(progress),
);
```

预期 URL：

```text
/api/admin/media/movies/movie%2F1/video?version=7
```

- [ ] **步骤 6：实现 `uploadMedia` 的可选进度回调**

在 `admin.ts` 中保持三参数调用兼容，并增加第四个可选参数：

```ts
export async function uploadMedia(
  target: MediaUploadTarget,
  file: File,
  version: number,
  onProgress?: (progress: ApiUploadProgress) => void,
): Promise<MediaAssetResponse> {
  const form = new FormData();
  form.append("file", file);
  const path = apiPath("admin", "media", target.kind, target.id, target.slot);
  const response = onProgress
    ? await apiUpload<MediaAssetResponse>(path, { method: "POST", query: { version }, body: form, onProgress })
    : await apiRequest<MediaAssetResponse>(path, { method: "POST", query: { version }, body: form });
  return requiredResponse(response);
}
```

这样电影海报和剧集海报不传回调，继续走现有 `fetch`；电影视频和单集视频接入回调后才走 XHR。

- [ ] **步骤 7：验证共享客户端并提交**

运行：

```bash
npm test --workspace @movie-harbor/api-client
npm run build --workspace @movie-harbor/api-client
git diff --check
```

预期：共享客户端全部测试和类型检查通过。

提交：

```bash
git add frontend/packages/api-client/src/http.ts frontend/packages/api-client/src/http.test.ts frontend/packages/api-client/src/admin.ts frontend/packages/api-client/src/admin.test.ts
git commit -m "feat: 添加可跟踪进度的媒体上传请求"
```

### 任务 2：展示进度并接入电影视频上传

**文件：**
- 创建：`frontend/admin-web/src/test/uploadXhr.ts`
- 修改：`frontend/admin-web/src/test/server.ts`
- 修改：`frontend/admin-web/src/movies/VideoPicker.tsx`
- 创建：`frontend/admin-web/src/movies/VideoPicker.test.tsx`
- 修改：`frontend/admin-web/src/movies/MovieEditor.tsx`
- 修改：`frontend/admin-web/src/movies/MovieEditor.test.tsx`
- 修改：`frontend/admin-web/src/styles.css`

- [ ] **步骤 1：创建管理后台测试用 XHR 控制器**

在 `src/test/uploadXhr.ts` 实现测试专用替身。默认模式把 `open()`、headers 和 `FormData` 转交给当前已 stub 的 `fetch`，再把返回的 `Response` 写回 XHR 字段并触发 `load`，使现有 fixture 不必复制业务响应逻辑。

同时提供手动模式，返回当前上传控制器：

```ts
const uploads = installUploadXhr({ manual: true });
const current = uploads.next();
current.progress(68, 100);
current.finishUpload();
await current.respondFromFetch();
```

控制器必须支持不可计算进度、网络失败和只完成上传但暂不返回接口响应。测试替身只放在管理后台测试目录，不从生产入口导出。

- [ ] **步骤 2：为 `VideoPicker` 编写失败的展示测试**

创建 `VideoPicker.test.tsx`，逐一断言：

```tsx
render(<VideoPicker {...baseProps} progress={{ phase: "uploading", percent: 68 }} />);
expect(screen.getByText("正在上传视频…")).toBeInTheDocument();
expect(screen.getByText("68%")).toBeInTheDocument();
expect(screen.getByRole("progressbar", { name: "视频上传进度" })).toHaveAttribute("value", "68");
```

```tsx
render(<VideoPicker {...baseProps} progress={{ phase: "uploading", percent: null }} />);
expect(screen.getByRole("progressbar", { name: "视频上传进度" })).not.toHaveAttribute("value");
expect(screen.queryByText(/%/)).not.toBeInTheDocument();
```

```tsx
render(<VideoPicker {...baseProps} progress={{ phase: "processing", percent: 100 }} />);
expect(screen.getByText("上传完成，正在校验并保存…")).toBeInTheDocument();
expect(screen.getByRole("progressbar", { name: "视频上传进度" })).toHaveAttribute("value", "100");
```

还要验证 `progress={null}` 不显示进度区域，只读模式不出现文件输入或待上传信息。

- [ ] **步骤 3：运行组件测试确认失败**

运行：

```bash
npm test --workspace @movie-harbor/admin-web -- src/movies/VideoPicker.test.tsx
```

预期：FAIL，`VideoPicker` 尚无 `progress` 属性和进度语义。

- [ ] **步骤 4：实现无障碍内联进度组件和样式**

给 `VideoPicker` 增加：

```ts
progress: ApiUploadProgress | null;
```

在待上传文件之后渲染：

```tsx
{file && <div className="video-upload-progress-slot">
  {progress && <div className="video-upload-progress" aria-live="polite">
    <div className="video-upload-progress__label">
      <span>{progress.phase === "processing" ? "上传完成，正在校验并保存…" : "正在上传视频…"}</span>
      {progress.phase === "uploading" && progress.percent !== null && <strong>{progress.percent}%</strong>}
    </div>
    <progress
      aria-label="视频上传进度"
      max={100}
      value={progress.phase === "processing" ? 100 : progress.percent ?? undefined}
    />
  </div>}
</div>}
```

在 `styles.css` 中为 slot 设置稳定最小高度，为进度条设置 100% 宽度、与现有蓝灰主题一致的轨道和强调色；保留原生 `progress` 语义，不用纯装饰 `div` 代替。

- [ ] **步骤 5：运行 `VideoPicker` 测试确认通过**

运行：

```bash
npm test --workspace @movie-harbor/admin-web -- src/movies/VideoPicker.test.tsx
```

预期：PASS，确定、不确定、校验保存和隐藏状态全部通过。

- [ ] **步骤 6：为电影上传状态编写失败测试**

在 `MovieEditor.test.tsx` 的 `beforeEach` 安装自动响应 XHR 替身，确保现有视频测试仍委托给 `fixture()` 的 `fetch` 响应。

新增手动推进测试：选择视频并保存后，先发出 `68/100`，断言文件区域显示“68%”；再发出一个较小的 `50/100`，断言仍显示“68%”；触发上传完成但暂不返回响应，断言显示“上传完成，正在校验并保存…”且保存/发布按钮和视频输入仍禁用；最终返回成功响应后断言进度消失、待上传文件清空、已保存视频出现。

另加失败用例：在 68% 后返回结构化 415，断言进度消失、中文内容不匹配提示出现、`待上传：文件名` 仍存在。

- [ ] **步骤 7：接入电影视频进度并保持海报路径不变**

在 `MovieEditor` 中增加：

```ts
const [videoUploadProgress, setVideoUploadProgress] = useState<ApiUploadProgress | null>(null);
```

只在 `slot === "video"` 时传入回调，并确保任何退出路径都清理状态：

```ts
try {
  uploaded = await uploadMedia(
    { kind: "movies", id: saved.id, slot },
    file,
    saved.version,
    slot === "video" ? setVideoUploadProgress : undefined,
  );
} finally {
  if (slot === "video" && mounted.current) setVideoUploadProgress(null);
}
```

注意不能用外层 `finally` 清除待上传 `video` 文件；只有现有成功路径或已提交但收尾失败的既有特殊路径可以清空文件。把 `progress={videoUploadProgress}` 传给 `VideoPicker`，页面首次加载、重新加载和切换内容时也重置进度。

- [ ] **步骤 8：验证电影编辑器并提交**

运行：

```bash
npm test --workspace @movie-harbor/admin-web -- src/movies/VideoPicker.test.tsx src/movies/MovieEditor.test.tsx
npm run build --workspace @movie-harbor/admin-web
git diff --check
```

预期：新进度测试与既有电影上传、替换、冲突、发布和删除测试全部通过。

提交：

```bash
git add frontend/admin-web/src/test/uploadXhr.ts frontend/admin-web/src/test/server.ts frontend/admin-web/src/movies/VideoPicker.tsx frontend/admin-web/src/movies/VideoPicker.test.tsx frontend/admin-web/src/movies/MovieEditor.tsx frontend/admin-web/src/movies/MovieEditor.test.tsx frontend/admin-web/src/styles.css
git commit -m "feat: 展示电影视频上传进度"
```

### 任务 3：接入单集视频进度并完成回归

**文件：**
- 修改：`frontend/admin-web/src/series/EpisodeRow.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.tsx`
- 修改：`frontend/admin-web/src/series/SeriesEditor.test.tsx`

- [ ] **步骤 1：为单集隔离进度编写失败测试**

在 `SeriesEditor.test.tsx` 安装任务 2 的 XHR 测试替身，并创建包含两个草稿单集的剧集。选择第一集视频、点击第一集“保存单集草稿”，手动发出 42% 进度后断言：

```ts
const firstEpisode = screen.getByRole("form", { name: /第 1 集/ });
const secondEpisode = screen.getByRole("form", { name: /第 2 集/ });
expect(within(firstEpisode).getByText("42%")).toBeInTheDocument();
expect(within(firstEpisode).getByRole("progressbar", { name: "视频上传进度" })).toBeInTheDocument();
expect(within(secondEpisode).queryByRole("progressbar", { name: "视频上传进度" })).not.toBeInTheDocument();
```

触发上传完成但暂不返回响应，断言第一集显示“上传完成，正在校验并保存…”；返回成功响应后断言进度消失、第一集出现新视频、第二集未保存输入仍保留。

新增失败测试：上传响应为 415 时，目标单集的进度消失但待上传文件保留，发布接口未被调用。

- [ ] **步骤 2：运行单集测试确认失败**

运行：

```bash
npm test --workspace @movie-harbor/admin-web -- src/series/SeriesEditor.test.tsx
```

预期：FAIL，`EpisodeActions.save` 尚未传递进度回调，单集行也没有进度状态。

- [ ] **步骤 3：让 `EpisodeRow` 持有进度并扩展保存边界**

扩展 `EpisodeActions.save`：

```ts
save: (
  episode: EpisodeResponse,
  fields: EpisodeFields,
  file: File | null,
  publish: boolean,
  onUploaded: () => void,
  onProgress: (progress: ApiUploadProgress) => void,
) => Promise<boolean>;
```

`EpisodeRow` 增加本地状态，并在提交 Promise 收尾时清理：

```ts
const [uploadProgress, setUploadProgress] = useState<ApiUploadProgress | null>(null);

void actions.save(
  episode,
  values,
  file,
  publish,
  () => setFile(null),
  setUploadProgress,
).finally(() => setUploadProgress(null));
```

把 `progress={uploadProgress}` 传给该行的 `VideoPicker`。当单集变为非草稿或文件被成功清空时同步清理进度；兄弟行不共享此状态。

- [ ] **步骤 4：让 `SeriesEditor` 只跟踪单集视频请求**

给 `saveEpisode` 增加 `onProgress` 参数，并仅把它传给单集视频上传：

```ts
uploaded = await uploadMedia(
  { kind: "episodes", id: episode.id, slot: "video" },
  file,
  saved.episode.version,
  onProgress,
);
```

保持既有顺序和所有守卫不变：先 `updateEpisode`，再上传视频，再核对 `series_version` 与单集版本，最后才允许发布。剧集海报仍不传进度回调并继续走 `fetch`。

- [ ] **步骤 5：运行目标测试确认通过**

运行：

```bash
npm test --workspace @movie-harbor/admin-web -- src/series/SeriesEditor.test.tsx src/movies/VideoPicker.test.tsx
```

预期：单集进度隔离、处理状态、成功刷新、失败保留和既有层级行为全部通过。

- [ ] **步骤 6：执行前端完整回归**

运行：

```bash
npm test --workspace @movie-harbor/api-client
npm test --workspace @movie-harbor/admin-web
npm run build --workspace @movie-harbor/api-client
npm run build --workspace @movie-harbor/admin-web
npm test --workspaces
npm run build --workspaces
node --test tests/*.test.mjs tests/e2e/run-safety.test.mjs
git diff --check
```

预期：全部命令退出码为 0；公开站和其他共享包不受影响。后端契约、Rust 代码、数据库和 Docker Compose 均未修改，因此本计划不要求数据库或跨服务 E2E 验证。

- [ ] **步骤 7：提交单集接入**

```bash
git add frontend/admin-web/src/series/EpisodeRow.tsx frontend/admin-web/src/series/SeriesEditor.tsx frontend/admin-web/src/series/SeriesEditor.test.tsx
git commit -m "feat: 展示单集视频上传进度"
```

## 完成定义

- 电影视频和单集视频在对应文件区域展示真实上传进度。
- 可计算进度显示不倒退的整数百分比；不可计算进度不伪造百分比。
- 请求体传输完成到接口响应之间显示“上传完成，正在校验并保存…”。
- 成功后清除进度和待上传文件；失败后清除进度但保留文件供重试。
- 进度使用原生无障碍语义，且只出现在目标电影或目标单集。
- 海报上传、普通 API 请求、后端接口、媒体校验、版本一致性和同步替换语义保持不变。
- 共享 API 客户端与管理后台测试、全部前端工作区测试和构建、Node 契约测试及 `git diff --check` 全部通过。
