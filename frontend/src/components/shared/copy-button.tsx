"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";

export function CopyButton({ value, label = "Copy", ...props }: { value: string; label?: string } & Omit<ButtonProps, "onClick" | "children">) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant="outline"
      size="sm"
      leftIcon={copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          toast.error("Copy failed", { description: "Select the text and copy it manually." });
        }
      }}
      {...props}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}
