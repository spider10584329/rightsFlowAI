"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { Suspense, useState, type ReactNode } from "react";

import { NotificationsBell } from "@/components/app-shell/notifications-bell";
import { OrgSwitcher } from "@/components/app-shell/org-switcher";
import { SidebarBrand, SidebarNav } from "@/components/app-shell/sidebar";
import { UserMenu } from "@/components/app-shell/user-menu";
import { OrgProvider } from "@/components/session/org-provider";
import { SessionProvider, useSession } from "@/components/session/session-provider";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocalStorageFlag } from "@/lib/hooks/use-local-storage-flag";
import { useRestoreFocus } from "@/lib/hooks/use-restore-focus";
import { cn } from "@/lib/utils";

/**
 * Authenticated application chrome. The sidebar and page segments render
 * immediately (and are prerendered); session-dependent pieces suspend until
 * the session and active organization are loaded on the client.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <OrgProvider>
        <ShellLayout>{children}</ShellLayout>
      </OrgProvider>
    </SessionProvider>
  );
}

/** Mounts the bell only once signed in, so it never polls anonymously. */
function SessionNotificationsBell() {
  useSession();
  return <NotificationsBell />;
}

function ShellLayout({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useLocalStorageFlag("rf-sidebar-collapsed", false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const restoreNavFocus = useRestoreFocus();

  return (
    <div className="flex min-h-dvh bg-bg">
      <a
        href="#main-content"
        className="sr-only z-[100] rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-fg focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>

      <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 lg:flex",
          collapsed ? "w-16" : "w-[15.5rem]",
        )}
        aria-label="Sidebar"
      >
        <div className={cn("px-3", collapsed && "px-2")}>
          <SidebarBrand collapsed={collapsed} />
        </div>
        <SidebarNav collapsed={collapsed} />
        <div className={cn("border-t border-border p-3", collapsed && "flex justify-center px-2")}>
          <IconButton
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            icon={collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
            size="sm"
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
          />
        </div>
      </aside>

      <DialogPrimitive.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in lg:hidden" />
          <DialogPrimitive.Content
            className="fixed inset-y-0 left-0 z-50 flex w-[17rem] max-w-[85vw] flex-col border-r border-border bg-sidebar shadow-lg outline-none data-[state=open]:animate-slide-in-left lg:hidden"
            aria-describedby={undefined}
            {...restoreNavFocus}
          >
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <div className="flex items-center justify-between px-3">
              <SidebarBrand />
              <DialogPrimitive.Close asChild>
                <IconButton label="Close navigation" icon={<X aria-hidden />} size="sm" />
              </DialogPrimitive.Close>
            </div>
            <SidebarNav onNavigate={() => setMobileOpen(false)} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border bg-surface/85 px-3 backdrop-blur-md sm:px-5">
          <IconButton
            label="Open navigation"
            icon={<Menu aria-hidden />}
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-expanded={mobileOpen}
          />
          <Suspense fallback={<Skeleton className="h-9 w-44 rounded-lg" />}>
            <OrgSwitcher />
          </Suspense>
          <div className="flex-1" />
          <Suspense fallback={<Skeleton className="size-9 rounded-md" />}>
            <SessionNotificationsBell />
          </Suspense>
          <Suspense fallback={<Skeleton className="size-9 rounded-full" />}>
            <UserMenu />
          </Suspense>
        </header>
        <main id="main-content" tabIndex={-1} className="flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
