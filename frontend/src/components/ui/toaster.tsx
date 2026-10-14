"use client";

import { Toaster as SonnerToaster } from "sonner";

import { useTheme } from "@/components/providers/theme-provider";

export { toast } from "sonner";

export function Toaster() {
  const { resolvedTheme } = useTheme();
  return (
    <SonnerToaster
      theme={resolvedTheme}
      position="bottom-right"
      closeButton
      richColors
      toastOptions={{
        classNames: {
          toast: "!rounded-lg !border !border-border !shadow-lg !font-sans",
          title: "!text-[13px] !font-semibold",
          description: "!text-[12px]",
        },
      }}
    />
  );
}
