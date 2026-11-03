import { forwardRef, type ButtonHTMLAttributes } from "react";

// 定义按钮样式，供相关请求、状态或组件使用。
export type ButtonVariant = "primary" | "secondary" | "danger";

// 定义按钮属性，供相关请求、状态或组件使用。
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  compact?: boolean;
}

// 由页面和共享组件渲染统一样式的按钮，并把引用转交给原生按钮。
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", compact = false, className, type = "button", ...props },
  ref,
) {
  const classes = [
    "mh-button",
    `mh-button--${variant}`,
    compact && "mh-button--compact",
    className,
  ].filter(Boolean).join(" ");
  return <button ref={ref} type={type} className={classes} {...props} />;
});
