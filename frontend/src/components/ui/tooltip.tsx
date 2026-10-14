"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

import { cn } from "@/lib/utils";

export const TooltipProvider = TooltipPrimitive.Provider;

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  delayDuration?: number;
  className?: string;
  /** Render nothing extra when disabled (e.g. expanded sidebar labels). */
  disabled?: boolean;
}

/** Hover/focus hint. The trigger must be focusable and keep its own accessible name. */
export function Tooltip({ content, children, side = "top", align = "center", delayDuration, className, disabled }: TooltipProps) {
  if (disabled) return children;
  return (
    <TooltipPrimitive.Root delayDuration={delayDuration}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            "z-70 max-w-xs rounded-md bg-fg px-2 py-1 text-xs font-medium text-bg shadow-md data-[state=delayed-open]:animate-fade-in",
            className,
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
