// 共享提示支持的信息、成功和错误状态，决定样式与播报方式。
export type ToastVariant = "info" | "success" | "error";

// 共享提示的消息、状态样式和可选类名。
export interface ToastProps {
  message: string;
  variant?: ToastVariant;
  className?: string;
}

// 由调用方渲染操作提示并呈现对应状态样式。
export function Toast({ message, variant = "info", className }: ToastProps) {
  if (!message) return null;
  const isError = variant === "error";
  return (
    <div
      className={["mh-toast", `mh-toast--${variant}`, className].filter(Boolean).join(" ")}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
    >
      {message}
    </div>
  );
}
