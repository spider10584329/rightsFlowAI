"use client";

import { Check, ChevronsUpDown, Plus } from "lucide-react";

import { useOrg } from "@/components/session/org-provider";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { isRole, ROLE_LABELS } from "@/lib/roles";

export function OrgSwitcher() {
  const { org, organizations, switchOrganization, isSwitching } = useOrg();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-9 min-w-0 max-w-[16rem] items-center gap-2 rounded-lg border border-border bg-surface px-2 text-left shadow-xs transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={`${org.name}, switch organization`}
        >
          <Avatar name={org.name} seed={org.id} size="xs" shape="square" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold leading-tight text-fg">{org.name}</span>
          </span>
          {isSwitching ? <Spinner size="xs" /> : <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {organizations.map((item) => {
          const active = item.id === org.id;
          return (
            <DropdownMenuItem
              key={item.id}
              onSelect={() => void switchOrganization(item.id)}
              icon={<Avatar name={item.name} seed={item.id} size="xs" shape="square" />}
              className="py-2"
            >
              <span className="flex items-center gap-2">
                <span className="truncate">{item.name}</span>
                {isRole(item.role) ? <Badge tone={active ? "primary" : "neutral"}>{ROLE_LABELS[item.role]}</Badge> : null}
                {active ? <Check className="ml-auto !text-primary" aria-label="Current organization" /> : null}
              </span>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem href="/onboarding" icon={<Plus aria-hidden />}>
          Create or join organization
        </DropdownMenuLinkItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
