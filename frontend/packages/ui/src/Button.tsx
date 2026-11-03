import { forwardRef, type ButtonHTMLAttributes } from "react";

// 共享按钮的主要、次要和危险样式，供调用页面选择视觉层级。
export type ButtonVariant = "primary" | "secondary" | "danger";

// 共享按钮接受的原生按钮属性及样式、紧凑布局选项。
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
