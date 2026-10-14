"use client";

import { AlertTriangle } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DialogBody, DialogContent, DialogFooter, DialogHeader, DialogRoot } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/errors";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Extra content rendered above the confirmation input. */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  /**
   * When set, the user must type this exact text to enable the confirm
   * button (for irreversible actions).
   */
  confirmText?: string;
  /** Called on confirm. A returned promise keeps the dialog busy; a rejection keeps it open and shows the error. */
  onConfirm: () => unknown | Promise<unknown>;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  confirmText,
  onConfirm,
}: ConfirmDialogProps) {
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTyped("");
    setError(null);
    setPending(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (pending) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const matches = !confirmText || typed.trim() === confirmText;

  const handleConfirm = async () => {
    if (!matches || pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      reset();
      onOpenChange(false);
    } catch (cause) {
      setError(errorMessage(cause));
      setPending(false);
    }
  };

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="sm" role="alertdialog" hideClose={pending}>
        <DialogHeader
          title={
            <span className="flex items-center gap-2">
              {tone === "danger" ? <AlertTriangle className="size-4 text-danger" aria-hidden /> : null}
              {title}
            </span>
          }
          description={description}
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleConfirm();
          }}
        >
          {children || confirmText || error ? (
            <DialogBody className="space-y-4">
              {children}
              {confirmText ? (
                <div className="space-y-1.5">
                  <label htmlFor={inputId} className="text-[13px] text-fg-muted">
                    Type <span className="rounded bg-surface-2 px-1 py-0.5 font-mono text-fg">{confirmText}</span> to confirm
                  </label>
                  <Input
                    id={inputId}
                    value={typed}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setTyped(event.target.value)}
                    disabled={pending}
                  />
                </div>
              ) : null}
              {error ? (
                <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger-soft-fg">
                  {error}
                </p>
              ) : null}
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
              {cancelLabel}
            </Button>
            <Button type="submit" variant={tone === "danger" ? "danger" : "primary"} loading={pending} disabled={!matches}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
