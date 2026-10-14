"use client";

import * as LabelPrimitive from "@radix-ui/react-label";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

export interface LabelProps extends ComponentProps<typeof LabelPrimitive.Root> {
  required?: boolean;
}

export function Label({ className, children, required, ...props }: LabelProps) {
  return (
    <LabelPrimitive.Root
      className={cn("text-[13px] font-medium leading-5 text-fg peer-disabled:opacity-70", className)}
      {...props}
    >
      {children}
      {required ? (
        <span className="ml-0.5 text-danger" aria-hidden="true">
          *
        </span>
      ) : null}
    </LabelPrimitive.Root>
  );
}
