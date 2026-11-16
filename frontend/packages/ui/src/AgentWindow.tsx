import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

// 使用浏览器视口内的坐标保存浮窗位置和拖动起点。
interface Point { x: number; y: number }
// 提供浮窗内容和关闭回调，供助手入口打开时传入。
interface AgentWindowProps { children: ReactNode; onClose: () => void }

// 将浮窗限制在可见区域，拖动或窗口尺寸变化时调用。
function clampPosition(element: HTMLElement, position: Point): Point {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8)),
    y: Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8)),
  };
}

// 在独立的非模态浮窗中显示聊天，背景保持可点击和键盘可达。
export function AgentWindow({ children, onClose }: AgentWindowProps) {
  const [position, setPosition] = useState<Point>();
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement>(null);
  const drag = useRef<{ pointerId: number; offset: Point }>(null);
  const titleId = useId();

  // 打开时记录入口并将焦点移到浮窗，便于马上用键盘操作。
  useEffect(() => {
    if (document.activeElement instanceof HTMLElement && !panel.current?.contains(document.activeElement)) {
      opener.current = document.activeElement;
    }
    panel.current?.focus();
  }, []);

  // 通过浮窗内部操作关闭时，把焦点还给仍在页面上的入口。
  function close() {
    if (opener.current?.isConnected) opener.current.focus();
    onClose();
  }

  // 窗口尺寸改变或聊天内容增长后重新约束拖动位置，避免标题或操作区离开视口。
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const keepVisible = () => setPosition((current) => {
      if (!current) return current;
      const next = clampPosition(element, current);
      return next.x === current.x && next.y === current.y ? current : next;
    });
    window.addEventListener("resize", keepVisible);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(keepVisible);
    observer?.observe(element);
    return () => {
      window.removeEventListener("resize", keepVisible);
      observer?.disconnect();
    };
  }, []);

  // 从标题开始捕获指针，使鼠标、触控笔和触摸离开标题后仍可继续拖动。
  function start(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !panel.current || drag.current) return;
    const rect = panel.current.getBoundingClientRect();
    drag.current = { pointerId: event.pointerId, offset: { x: event.clientX - rect.left, y: event.clientY - rect.top } };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  // 拖动期间根据指针位置更新浮窗坐标，忽略其他指针。
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || !panel.current) return;
    setPosition(clampPosition(panel.current, { x: event.clientX - current.offset.x, y: event.clientY - current.offset.y }));
  }

  // 指针释放或系统取消后清除拖动状态，以接受下一次拖动。
  function stop(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  // 允许键盘用户在标题把手上用方向键移动浮窗。
  function moveByKey(event: KeyboardEvent<HTMLButtonElement>) {
    const element = panel.current;
    if (!element) return;
    const dx = event.key === "ArrowLeft" ? -24 : event.key === "ArrowRight" ? 24 : 0;
    const dy = event.key === "ArrowUp" ? -24 : event.key === "ArrowDown" ? 24 : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    const rect = element.getBoundingClientRect();
    setPosition(clampPosition(element, { x: rect.left + dx, y: rect.top + dy }));
  }

  // 仅在浮窗内处理 Escape，背景页面仍可响应自己的键盘操作。
  function dismiss(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }

  return createPortal(
    <section ref={panel} className="mh-dialog mh-agent-panel" role="dialog" aria-labelledby={titleId} tabIndex={-1}
      style={position ? { left: position.x, top: position.y, right: "auto" } : undefined} onKeyDown={dismiss}>
      <header className="mh-agent-titlebar">
        <h2 id={titleId}>
          <button type="button" className="mh-agent-drag" aria-label="移动影片助手" title="拖动标题，或使用方向键移动"
            onPointerDown={start} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop} onKeyDown={moveByKey}>
            影片助手
          </button>
        </h2>
        <button className="mh-dialog__close" type="button" aria-label="关闭影片助手" onClick={close}>×</button>
      </header>
      <div className="mh-dialog__body mh-agent-body">{children}</div>
    </section>,
    document.body,
  );
}
