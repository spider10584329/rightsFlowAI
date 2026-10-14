"use client";

import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface SelectOption<V extends string = string> {
  value: V;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> {
  value: V | undefined;
  onValueChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true | boolean;
  "aria-required"?: true | boolean;
}

/** Accessible single-select built on Radix Select. */
export function Select<V extends string = string>({
  value,
  onValueChange,
  options,
  placeholder = "Select…",
  disabled,
  id,
  name,
  className,
  size = "md",
  ...aria
}: SelectProps<V>) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={(next) => onValueChange(next as V)} disabled={disabled} name={name}>
      <SelectTrigger id={id} size={size} className={className} {...aria}>
        <SelectPrimitive.Value placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled} description={option.description}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectPrimitive.Root>
  );
}

export function SelectTrigger({
  className,
  children,
  size = "md",
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger> & { size?: "sm" | "md" }) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-surface px-3 text-left text-sm text-fg shadow-xs transition-[border-color,box-shadow] hover:border-fg-subtle/60 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger data-[placeholder]:text-fg-subtle [&>span]:truncate",
        size === "sm" ? "h-8 text-[13px]" : "h-9",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown className="size-4 shrink-0 text-fg-subtle" aria-hidden />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({ className, children, position = "popper", ...props }: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={4}
        className={cn(
          "relative z-60 max-h-[min(22rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-surface text-fg shadow-lg data-[state=open]:animate-scale-in",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-fg-subtle">
          <ChevronUp className="size-4" aria-hidden />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center text-fg-subtle">
          <ChevronDown className="size-4" aria-hidden />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  description,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item> & { description?: ReactNode }) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex w-full cursor-default select-none flex-col rounded-md py-1.5 pl-8 pr-3 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 top-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check className="size-4 text-primary" aria-hidden />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      {description ? <span className="text-xs text-fg-subtle">{description}</span> : null}
    </SelectPrimitive.Item>
  );
}
