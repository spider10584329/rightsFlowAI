"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";

import { activeNavHref, NAV_GROUPS } from "@/components/app-shell/nav-config";
import { Logo, LogoMark } from "@/components/brand/logo";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface SidebarNavProps {
  collapsed?: boolean;
  onNavigate?: () => void;
}

/**
 * Navigation list shared by the desktop sidebar and the mobile drawer.
 *
 * The pathname is URL data, so with Cache Components it must be read below a
 * Suspense boundary; the fallback renders the same list with nothing active.
 */
export function SidebarNav(props: SidebarNavProps) {
  return (
    <Suspense fallback={<NavList {...props} active={null} />}>
      <ActiveSidebarNav {...props} />
    </Suspense>
  );
}

function ActiveSidebarNav(props: SidebarNavProps) {
  const pathname = usePathname();
  return <NavList {...props} active={activeNavHref(pathname)} />;
}

function NavList({ collapsed = false, onNavigate, active }: SidebarNavProps & { active: string | null }) {
  return (
    <nav aria-label="Primary" className="scrollbar-thin flex-1 overflow-y-auto px-3 pb-6">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="mt-5 first:mt-2">
          {collapsed ? (
            <div className="mx-auto mb-2 h-px w-6 bg-border" aria-hidden />
          ) : (
            <p className="mb-1.5 px-2.5 text-2xs font-semibold uppercase tracking-[0.08em] text-fg-subtle">{group.label}</p>
          )}
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const isActive = item.href === active;
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Tooltip content={item.label} side="right" disabled={!collapsed}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={isActive ? "page" : undefined}
                      aria-label={collapsed ? item.label : undefined}
                      className={cn(
                        "group relative flex h-8 items-center gap-2.5 rounded-md text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                        collapsed ? "justify-center px-0" : "px-2.5",
                        isActive
                          ? "bg-primary-soft text-primary-soft-fg"
                          : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                      )}
                    >
                      {isActive && !collapsed ? (
                        <span className="absolute -left-3 top-1.5 h-5 w-[3px] rounded-r-full bg-primary" aria-hidden />
                      ) : null}
                      <Icon className={cn("size-4 shrink-0", isActive ? "text-primary" : "text-fg-subtle group-hover:text-fg-muted")} aria-hidden />
                      {collapsed ? null : <span className="truncate">{item.label}</span>}
                    </Link>
                  </Tooltip>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function SidebarBrand({ collapsed }: { collapsed?: boolean }) {
  return (
    <Link
      href="/dashboard"
      className={cn("flex h-14 shrink-0 items-center rounded-md focus-visible:outline-2 focus-visible:outline-ring", collapsed ? "justify-center" : "px-2")}
      aria-label="RightsFlow AI home"
    >
      {collapsed ? <LogoMark /> : <Logo />}
    </Link>
  );
}
