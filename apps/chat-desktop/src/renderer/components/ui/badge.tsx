import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border border-line px-2.5 py-0.5 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "bg-surface text-muted",
        secondary: "bg-panel-solid text-text",
        success: "bg-[rgba(227,247,235,0.95)] text-positive border-positive/20",
        warning: "bg-[rgba(255,245,221,0.95)] text-warning border-warning/20",
        destructive: "bg-[rgba(252,235,232,0.95)] text-error border-error/20",
        outline: "text-muted",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
