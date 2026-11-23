import { Button } from "@movie-harbor/ui";

// 展示当前页选择数量和三类批量入口，在内容列表可见时使用。
export function BulkActionBar({ count, disabled, onAction }: {
  count: number;
  disabled: boolean;
  onAction: (action: "privacy" | "genres" | "archive") => void;
}) {
  const unavailable = disabled || count === 0;
  return <div className="bulk-action-bar" aria-label="批量操作">
    <strong>已选择 {count} 项</strong>
    <div>
      <Button disabled={unavailable} onClick={() => onAction("privacy")}>批量设置访问范围</Button>
      <Button disabled={unavailable} onClick={() => onAction("genres")}>批量调整题材</Button>
      <Button disabled={unavailable} variant="danger" onClick={() => onAction("archive")}>批量归档</Button>
    </div>
  </div>;
}
