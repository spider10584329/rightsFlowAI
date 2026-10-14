"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { useRestoreFocus } from "@/lib/hooks/use-restore-focus";
import { cn } from "@/lib/utils";

export interface SideSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Extra header content (e.g. an "open full page" link). */
  headerActions?: ReactNode;
  className?: string;
}

/** Right-hand drawer built on Radix Dialog (focus trap, Esc to close, labelled). */
export function SideSheet({ open, onOpenChange, title, description, children, footer, headerActions, className }: SideSheetProps) {
  const restoreFocus = useRestoreFocus();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-surface text-fg shadow-lg outline-none data-[state=open]:animate-fade-in",
            className,
          )}
          {...restoreFocus}
        >
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 space-y-1">
              <DialogPrimitive.Title className="text-base font-semibold tracking-tight">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="text-[13px] text-fg-muted">{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">Details</DialogPrimitive.Description>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {headerActions}
              <DialogPrimitive.Close
                className="inline-flex size-8 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
                aria-label="Close"
              >
                <X className="size-4" aria-hidden />
              </DialogPrimitive.Close>
            </div>
          </div>
          <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-5">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-surface-2/60 px-5 py-3">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
