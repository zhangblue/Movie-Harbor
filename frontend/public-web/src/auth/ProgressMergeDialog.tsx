import { useState } from "react";
import { Button, Dialog } from "@movie-harbor/ui";
import { mergeAnonymousProgress } from "../player/progressSync";

// 登录后询问是否把当前浏览器的匿名进度合并到已确认账号。
export function ProgressMergeDialog({ viewerId, isCurrent, onClose }: {
  viewerId: string; isCurrent: () => boolean; onClose: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // 用户确认时发起匿名批量合并，失败则保留数据和重试入口。
  async function merge() {
    if (pending) return;
    setPending(true); setError("");
    const merged = await mergeAnonymousProgress(viewerId, isCurrent);
    if (merged && isCurrent()) onClose();
    else if (isCurrent()) setError("合并失败，匿名进度已保留，请稍后重试。");
    setPending(false);
  }
  return <Dialog open title="合并观看进度" className="viewer-dialog" onClose={() => { if (!pending) onClose(); }}>
    <p className="viewer-dialog-description">检测到此浏览器有未登录时的观看进度，是否合并到当前账号？</p>
    {error && <p role="alert" className="viewer-error">{error}</p>}
    <div className="viewer-dialog-actions">
      <Button disabled={pending} onClick={onClose}>暂不合并</Button>
      <Button variant="primary" disabled={pending} onClick={() => { void merge(); }}>{pending ? "正在合并…" : "合并进度"}</Button>
    </div>
  </Dialog>;
}
