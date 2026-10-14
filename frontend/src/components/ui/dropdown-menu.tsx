"use client";

import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;
export const DropdownMenuGroup = DropdownPrimitive.Group;
export const DropdownMenuSub = DropdownPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownPrimitive.RadioGroup;

const CONTENT =
  "z-60 min-w-[12rem] overflow-hidden rounded-lg border border-border bg-surface p-1 text-fg shadow-lg data-[state=open]:animate-scale-in";

export function DropdownMenuContent({ className, sideOffset = 6, align = "end", ...props }: ComponentProps<typeof DropdownPrimitive.Content>) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content sideOffset={sideOffset} align={align} className={cn(CONTENT, className)} {...props} />
    </DropdownPrimitive.Portal>
  );
}

const ITEM =
  "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none transition-colors data-[disabled]:pointer-events-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-subtle";

export interface DropdownMenuItemProps extends ComponentProps<typeof DropdownPrimitive.Item> {
  icon?: ReactNode;
  destructive?: boolean;
  shortcut?: string;
}

export function DropdownMenuItem({ className, icon, destructive, shortcut, children, ...props }: DropdownMenuItemProps) {
  return (
    <DropdownPrimitive.Item
      className={cn(ITEM, destructive && "text-danger data-[highlighted]:bg-danger-soft [&_svg]:text-danger", className)}
      {...props}
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {shortcut ? <span className="ml-auto text-2xs tracking-widest text-fg-subtle">{shortcut}</span> : null}
    </DropdownPrimitive.Item>
  );
}

export interface DropdownMenuLinkItemProps extends Omit<ComponentProps<typeof DropdownPrimitive.Item>, "asChild" | "children"> {
  href: string;
  icon?: ReactNode;
  children: ReactNode;
}

/** Menu item that navigates with a Next.js `<Link>`. */
export function DropdownMenuLinkItem({ href, icon, children, className, ...props }: DropdownMenuLinkItemProps) {
  return (
    <DropdownPrimitive.Item asChild className={cn(ITEM, className)} {...props}>
      <Link href={href}>
        {icon}
        <span className="flex-1 truncate">{children}</span>
      </Link>
    </DropdownPrimitive.Item>
  );
}

export function DropdownMenuCheckboxItem({ className, children, ...props }: ComponentProps<typeof DropdownPrimitive.CheckboxItem>) {
  return (
    <DropdownPrimitive.CheckboxItem className={cn(ITEM, "pl-8", className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <DropdownPrimitive.ItemIndicator>
          <Check className="size-4 text-primary" aria-hidden />
        </DropdownPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownPrimitive.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof DropdownPrimitive.RadioItem>) {
  return (
    <DropdownPrimitive.RadioItem className={cn(ITEM, "pl-8", className)} {...props}>
      <span className="absolute left-2 flex size-4 items-center justify-center">
        <DropdownPrimitive.ItemIndicator>
          <Circle className="size-2 fill-current text-primary" aria-hidden />
        </DropdownPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof DropdownPrimitive.Label>) {
  return <DropdownPrimitive.Label className={cn("px-2 py-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof DropdownPrimitive.Separator>) {
  return <DropdownPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export function DropdownMenuSubTrigger({ className, children, icon, ...props }: ComponentProps<typeof DropdownPrimitive.SubTrigger> & { icon?: ReactNode }) {
  return (
    <DropdownPrimitive.SubTrigger className={cn(ITEM, "data-[state=open]:bg-surface-2", className)} {...props}>
      {icon}
      <span className="flex-1">{children}</span>
      <ChevronRight className="ml-auto" aria-hidden />
    </DropdownPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({ className, ...props }: ComponentProps<typeof DropdownPrimitive.SubContent>) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.SubContent className={cn(CONTENT, "min-w-[10rem]", className)} {...props} />
    </DropdownPrimitive.Portal>
  );
}
