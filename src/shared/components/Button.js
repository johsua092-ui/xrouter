"use client";

import { cn } from "@/shared/utils/cn";

/* Solid fills only. The upstream gradient button read as decoration, not
   affordance — a flat warm fill with one hairline top-light is enough, and
   white-on-fill contrast stays guaranteed in both themes. */
const variants = {
  primary:
    "bg-primary hover:bg-primary-hover text-white " +
    "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.16),0_1px_2px_rgba(0,0,0,0.16)] " +
    "hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.20),0_2px_6px_rgba(0,0,0,0.18)] " +
    "disabled:bg-surface-3 disabled:text-text-subtle disabled:shadow-none",
  secondary:
    "bg-surface-2 hover:bg-surface-3 text-text-main border border-border " +
    "hover:border-primary/40 disabled:opacity-50",
  outline:
    "bg-transparent border border-border text-text-main " +
    "hover:bg-surface-2 hover:border-primary/50",
  ghost: "text-text-muted hover:bg-surface-2 hover:text-text-main",
  danger:
    "bg-danger-solid hover:brightness-110 text-white " +
    "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12)] disabled:bg-surface-3 disabled:text-text-subtle disabled:shadow-none",
  success:
    "bg-success-solid hover:brightness-110 text-white " +
    "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12)] disabled:bg-surface-3 disabled:text-text-subtle disabled:shadow-none",
};

/* Tighter than the upstream scale (7/9/11 -> 7/9/10). Controls sit on a
   8px radius so cards (12px) read as a different layer. */
const sizes = {
  sm: "h-7 px-2.5 text-xs rounded-[6px] gap-1.5",
  md: "h-9 px-3.5 text-[13px] rounded-[8px] gap-1.5",
  lg: "h-10 px-5 text-sm rounded-[8px] gap-2",
};

export default function Button({
  children,
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  disabled = false,
  loading = false,
  fullWidth = false,
  className,
  ...props
}) {
  const iconSize = size === "sm" ? "text-[15px]" : "text-[17px]";

  return (
    <button
      className={cn(
        "inline-flex items-center justify-center font-semibold whitespace-nowrap",
        "transition-[background-color,box-shadow,border-color,transform] duration-150 ease-out",
        "active:scale-[0.98] disabled:opacity-100 disabled:cursor-not-allowed disabled:active:scale-100",
        variants[variant],
        sizes[size],
        fullWidth && "w-full",
        className
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span className={cn("material-symbols-outlined animate-spin leading-none", iconSize)}>
          progress_activity
        </span>
      ) : icon ? (
        <span className={cn("material-symbols-outlined leading-none", iconSize)}>{icon}</span>
      ) : null}
      {children}
      {iconRight && !loading && (
        <span className={cn("material-symbols-outlined leading-none", iconSize)}>{iconRight}</span>
      )}
    </button>
  );
}
