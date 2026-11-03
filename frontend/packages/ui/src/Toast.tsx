// 定义提示样式，供相关请求、状态或组件使用。
export type ToastVariant = "info" | "success" | "error";

// 定义提示属性，供相关请求、状态或组件使用。
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
