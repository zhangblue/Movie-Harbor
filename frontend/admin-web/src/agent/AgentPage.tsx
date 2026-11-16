import { createMovie, createSeries, type AgentDraft } from "@movie-harbor/api-client";
import { AgentLauncher } from "@movie-harbor/ui";

// 在管理员页头挂载助手，并将确认操作交给已有的内容创建接口。
export function AgentPage({ onExpired, onCreated }: { onExpired: () => void; onCreated: () => void }) {
  // 成功创建草稿后通知内容列表刷新，失败留给助手浮层处理。
  async function confirmDraft(draft: AgentDraft) {
    if (draft.kind === "movie") await createMovie(draft.name, false);
    else await createSeries(draft.name, false);
    onCreated();
  }

  return <AgentLauncher role="admin" onExpired={onExpired} onConfirmDraft={confirmDraft} />;
}
