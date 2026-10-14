"use client";

import { Bell, LogOut, Monitor, Moon, Sun, UserRound } from "lucide-react";

import { useTheme, type ThemePreference } from "@/components/providers/theme-provider";
import { useSession } from "@/components/session/session-provider";
import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ThemeMenuIcon({ theme }: { theme: ThemePreference }) {
  if (theme === "dark") return <Moon aria-hidden />;
  if (theme === "light") return <Sun aria-hidden />;
  return <Monitor aria-hidden />;
}

export function UserMenu({ showNotificationsLink = true }: { showNotificationsLink?: boolean }) {
  const { user, signOut, isSigningOut } = useSession();
  const { theme, setTheme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-full p-0.5 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={`Account menu for ${user.full_name}`}
        >
          <Avatar name={user.full_name} seed={user.id} size="md" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuLabel className="normal-case tracking-normal">
          <span className="block truncate text-[13px] font-semibold text-fg">{user.full_name}</span>
          <span className="block truncate text-xs font-normal text-fg-muted">{user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem href="/settings/profile" icon={<UserRound aria-hidden />}>
          Profile & security
        </DropdownMenuLinkItem>
        {showNotificationsLink ? (
          <DropdownMenuLinkItem href="/notifications" icon={<Bell aria-hidden />}>
            Notifications
          </DropdownMenuLinkItem>
        ) : null}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger icon={<ThemeMenuIcon theme={theme} />}>Theme</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as ThemePreference)}>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<LogOut aria-hidden />} disabled={isSigningOut} onSelect={() => void signOut()}>
          {isSigningOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
