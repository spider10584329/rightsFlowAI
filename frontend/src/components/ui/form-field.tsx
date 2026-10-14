"use client";

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
}

export interface FormFieldProps {
  label: ReactNode;
  /** Help text shown under the control. */
  hint?: ReactNode;
  /** Validation message; marks the control invalid and is announced. */
  error?: ReactNode;
  required?: boolean;
  id?: string;
  className?: string;
  /** Optional element aligned to the right of the label (e.g. a link). */
  labelAside?: ReactNode;
  /**
   * The control. Either a single element (props are injected) or a render
   * function receiving the accessibility props to spread on the control.
   */
  children: ReactElement | ((props: FieldControlProps) => ReactNode);
}

/** Label + control + hint + error, wired with `aria-describedby` / `aria-invalid`. */
export function FormField({ label, hint, error, required, id, className, labelAside, children }: FormFieldProps) {
  const generated = useId();
  const controlId = id ?? `field-${generated}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  const controlProps: FieldControlProps = {
    id: controlId,
    "aria-describedby": describedBy,
    ...(error ? { "aria-invalid": true as const } : {}),
    ...(required ? { "aria-required": true as const } : {}),
  };

  let control: ReactNode;
  if (typeof children === "function") {
    control = children(controlProps);
  } else if (isValidElement<Record<string, unknown>>(children)) {
    control = cloneElement(children, { ...controlProps });
  } else {
    control = children;
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={controlId} required={required}>
          {label}
        </Label>
        {labelAside}
      </div>
      {control}
      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-xs leading-relaxed text-fg-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
