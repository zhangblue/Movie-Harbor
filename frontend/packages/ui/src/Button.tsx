import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  compact?: boolean;
}

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
