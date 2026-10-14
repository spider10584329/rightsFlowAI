"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { useRestoreFocus } from "@/lib/hooks/use-restore-focus";
import { cn } from "@/lib/utils";

export const DialogRoot = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  size?: "sm" | "md" | "lg";
  hideClose?: boolean;
}

const SIZES = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl" } as const;

export function DialogContent({ className, children, size = "md", hideClose, onOpenAutoFocus, onCloseAutoFocus, ...props }: DialogContentProps) {
  const restoreFocus = useRestoreFocus({ onOpenAutoFocus, onCloseAutoFocus });
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface text-fg shadow-lg outline-none data-[state=open]:animate-scale-in",
          SIZES[size],
          className,
        )}
        {...restoreFocus}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            className="absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ title, description, className }: { title: ReactNode; description?: ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1 px-6 pb-2 pt-5 pr-12", className)}>
      <DialogPrimitive.Title className="text-base font-semibold tracking-tight text-fg">{title}</DialogPrimitive.Title>
      {description ? (
        <DialogPrimitive.Description className="text-[13px] leading-relaxed text-fg-muted">{description}</DialogPrimitive.Description>
      ) : (
        <DialogPrimitive.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</DialogPrimitive.Description>
      )}
    </div>
  );
}

export function DialogBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("scrollbar-thin flex-1 overflow-y-auto px-6 py-4", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col-reverse gap-2 border-t border-border bg-surface-2/60 px-6 py-3 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: DialogContentProps["size"];
  trigger?: ReactNode;
}

/** Convenience wrapper: controlled dialog with header, body and footer. */
export function Dialog({ open, onOpenChange, title, description, children, footer, size, trigger }: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogContent size={size}>
        <DialogHeader title={title} description={description} />
        {children ? <DialogBody>{children}</DialogBody> : null}
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </DialogPrimitive.Root>
  );
}
