"use client";

import { cn } from "@/shared/utils/cn";

/* Switch. Off state is a bordered trough rather than a grey blob, so it still
   reads as a control when the surrounding surface is also grey. */
export default function Toggle({
  checked = false,
  onChange,
  label,
  description,
  disabled = false,
  size = "md",
  className,
}) {
  const sizes = {
    sm: { track: "w-8 h-[18px]", thumb: "size-3.5", on: "translate-x-[14px]", off: "translate-x-[2px]" },
    md: { track: "w-10 h-[22px]", thumb: "size-4", on: "translate-x-[19px]", off: "translate-x-[3px]" },
    lg: { track: "w-12 h-[26px]", thumb: "size-5", on: "translate-x-[23px]", off: "translate-x-[3px]" },
  };

  const handleClick = () => {
    if (!disabled && onChange) onChange(!checked);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-3",
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={handleClick}
        className={cn(
          "relative inline-flex shrink-0 items-center rounded-full border transition-colors duration-200 ease-out",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          checked
            ? "bg-primary border-primary"
            : "bg-surface-3 border-border",
          sizes[size].track,
          disabled && "cursor-not-allowed"
        )}
      >
        <span
          className={cn(
            "pointer-events-none inline-block rounded-full bg-surface shadow-[var(--shadow-elev)]",
            "transition-transform duration-200 ease-out",
            checked ? sizes[size].on : sizes[size].off,
            sizes[size].thumb
          )}
        />
      </button>
      {(label || description) && (
        <div className="flex flex-col min-w-0">
          {label && <span className="text-[13px] font-medium text-text-main">{label}</span>}
          {description && <span className="text-xs text-text-subtle">{description}</span>}
        </div>
      )}
    </div>
  );
}
