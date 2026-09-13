import type { ButtonHTMLAttributes, ReactNode } from "react";

type ToolbarButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ReactNode;
  label?: string;
  active?: boolean;
  variant?: "default" | "primary" | "danger";
};

export function ToolbarButton({ icon, label, active = false, variant = "default", className, ...props }: ToolbarButtonProps) {
  const classes = ["toolbar-button", `toolbar-button--${variant}`, active ? "is-active" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <button className={classes} aria-pressed={active} {...props}>
      <span className="toolbar-button__icon" aria-hidden="true">
        {icon}
      </span>
      {label ? <span className="toolbar-button__label">{label}</span> : null}
    </button>
  );
}
