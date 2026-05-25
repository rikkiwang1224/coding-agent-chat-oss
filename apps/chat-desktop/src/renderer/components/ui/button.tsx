import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/20 focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:translate-y-px active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-accent text-[#fffdf9] shadow-[0_10px_22px_rgba(23,21,20,0.18)] hover:bg-accent/90 hover:shadow-[0_14px_28px_rgba(23,21,20,0.22)]",
        destructive:
          "bg-error text-[#fffdf9] shadow-[0_10px_22px_rgba(143,52,52,0.16)] hover:bg-error/90 hover:shadow-[0_14px_28px_rgba(143,52,52,0.2)]",
        outline:
          "border border-line-strong bg-white/70 shadow-sm hover:border-accent/20 hover:bg-white hover:text-text hover:shadow-card",
        secondary:
          "bg-surface text-text shadow-sm hover:bg-white hover:shadow-card",
        ghost: "text-muted hover:bg-line-strong hover:text-text hover:shadow-sm",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
