export type ToastVariant = "info" | "success" | "error";

export interface ToastProps {
  message: string;
  variant?: ToastVariant;
  className?: string;
}

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
