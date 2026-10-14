"use client";

import type { ReactNode } from "react";

import { QueryProvider } from "@/components/providers/query-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

/** Global client providers mounted once in the root layout. */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <QueryProvider>
        <TooltipProvider delayDuration={300}>
          {children}
          <Toaster />
        </TooltipProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}
