import type { AdminContentListItem } from "@movie-harbor/api-client";
import { Button } from "@movie-harbor/ui";

export type ContentAction = "edit" | "view" | "publish" | "archive" | "draft" | "delete";
export type ContentRow = AdminContentListItem;
const actions: Record<string, ContentAction[]> = {
  draft: ["edit", "publish", "delete"],
  published: ["view", "archive"],
  archived: ["view", "publish", "draft", "delete"],
};
export function availableActions(row: ContentRow): ContentAction[] {
  return actions[row.status] ?? [];
}

export function ActionButtons({ row, disabled, onAction }: {
  row: ContentRow; disabled: boolean; onAction: (row: ContentRow, action: ContentAction) => void;
}) {
  const labels: Record<ContentAction, string> = { edit: "编辑", view: "查看", publish: row.status === "archived" ? "原样发布" : "发布", archive: "归档", draft: "转为草稿", delete: "永久删除" };
  return <div className="row-actions">
    {availableActions(row).map((action) => <Button key={action} compact disabled={disabled}
      variant={action === "delete" ? "danger" : "secondary"} onClick={() => onAction(row, action)}>{labels[action]}</Button>)}
  </div>;
}
