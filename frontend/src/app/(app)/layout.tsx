import type { ReactNode } from "react";

import { AppShell } from "@/components/app-shell/app-shell";

/**
 * Authenticated area. The shell is a client component: it loads the session
 * and organizations through the BFF, so this layout reads no request data
 * and its skeleton is prerendered into the static shell.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
