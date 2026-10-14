"use client";

import { Check, Eye, EyeOff, X } from "lucide-react";
import { useState } from "react";

import { Input, type InputProps } from "@/components/ui/input";
import { PASSWORD_RULES } from "@/lib/password";
import { cn } from "@/lib/utils";

/** Password field with a show/hide toggle. */
export function PasswordInput(props: Omit<InputProps, "type" | "trailing">) {
  const [visible, setVisible] = useState(false);
  return (
    <Input
      {...props}
      type={visible ? "text" : "password"}
      trailing={
        <button
          type="button"
          onClick={() => setVisible((value) => !value)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          className="inline-flex size-7 items-center justify-center rounded text-fg-subtle hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
        >
          {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      }
    />
  );
}

/** Live checklist of the backend password rules. */
export function PasswordChecklist({ password, id }: { password: string; id?: string }) {
  return (
    <ul id={id} className="grid gap-1 sm:grid-cols-2" aria-label="Password requirements">
      {PASSWORD_RULES.map((rule) => {
        const ok = rule.test(password);
        return (
          <li key={rule.id} className={cn("flex items-center gap-1.5 text-xs", ok ? "text-success" : "text-fg-subtle")}>
            {ok ? <Check className="size-3.5" aria-hidden /> : <X className="size-3.5 opacity-60" aria-hidden />}
            <span>{rule.label}</span>
            <span className="sr-only">{ok ? "(met)" : "(not met)"}</span>
          </li>
        );
      })}
    </ul>
  );
}
