"use client";

import { ChevronDown, ChevronRight, ScrollText } from "lucide-react";
import { useState } from "react";

import { useOrg } from "@/components/session/org-provider";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import { useActivity } from "@/lib/api/hooks/organizations";
import type { AuditChange, AuditLogEntry } from "@/lib/api/types";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { formatDateTime, titleCase } from "@/lib/utils";

const ACTION_PREFIXES = [
  { value: "all", label: "All activity" },
  { value: "organization.", label: "Organization" },
  { value: "membership.", label: "Members" },
  { value: "invitation.", label: "Invitations" },
  { value: "auth.", label: "Security & sign-in" },
  { value: "user.", label: "User profiles" },
  { value: "catalog.", label: "Catalog" },
  { value: "rights.", label: "Rights" },
  { value: "contract.", label: "Contracts" },
  { value: "royalt", label: "Royalties" },
  { value: "payout.", label: "Payouts" },
  { value: "billing.", label: "Billing" },
] as const;

const ADMIN_ONLY_PREFIXES = new Set(["auth.", "membership.", "invitation."]);

function isChange(value: unknown): value is AuditChange {
  return Boolean(value) && typeof value === "object" && value !== null && "from" in value && "to" in value;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function ChangesTable({ changes }: { changes: Record<string, unknown> }) {
  const entries = Object.entries(changes);
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-[13px]">
        <caption className="sr-only">Field changes</caption>
        <thead className="bg-surface-2/70 text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">
              Field
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Before
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              After
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map(([field, change]) => (
            <tr key={field} className="align-top">
              <td className="whitespace-nowrap px-3 py-2 font-medium text-fg">{titleCase(field)}</td>
              {isChange(change) ? (
                <>
                  <td className="px-3 py-2">
                    <span className="break-all rounded bg-danger-soft px-1.5 py-0.5 font-mono text-xs text-danger-soft-fg line-through decoration-danger/40">
                      {renderValue(change.from)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="break-all rounded bg-success-soft px-1.5 py-0.5 font-mono text-xs text-success-soft-fg">
                      {renderValue(change.to)}
                    </span>
                  </td>
                </>
              ) : (
                <td colSpan={2} className="break-all px-3 py-2 font-mono text-xs text-fg-muted">
                  {renderValue(change)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AuditClient() {
  const { org, can } = useOrg();
  const isAdmin = can("admin");
  const table = useTableQueryState<"action" | "entity_type">({
    defaultPageSize: 25,
    defaultSort: { key: "created_at", order: "desc" },
    filterKeys: ["action", "entity_type"],
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const actionFilter = table.filters.action ?? "";
  const activity = useActivity(org.id, {
    page: table.page,
    page_size: table.pageSize,
    order: table.sort?.order ?? "desc",
    action: actionFilter || undefined,
    entity_type: table.filters.entity_type || undefined,
  });

  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns: DataTableColumn<AuditLogEntry>[] = [
    {
      id: "created_at",
      header: "When",
      sortKey: "created_at",
      cell: (entry) => <span className="whitespace-nowrap text-fg-muted tabular-nums">{formatDateTime(entry.created_at)}</span>,
    },
    {
      id: "actor",
      header: "Actor",
      cell: (entry) => (
        <div className="flex items-center gap-2">
          <Avatar name={entry.actor_name ?? "System"} seed={entry.actor_user_id ?? "system"} size="sm" />
          <span className="truncate">{entry.actor_name ?? (entry.actor_user_id ? "Former member" : "System")}</span>
        </div>
      ),
    },
    {
      id: "action",
      header: "Action",
      cell: (entry) => (
        <Badge tone={entry.action.startsWith("auth.") ? "warning" : "neutral"} className="font-mono">
          {entry.action}
        </Badge>
      ),
    },
    {
      id: "summary",
      header: "Details",
      cell: (entry) => (
        <div className="min-w-0 max-w-md">
          <p className="truncate">{entry.summary ?? (entry.entity_type ? titleCase(entry.entity_type) : "—")}</p>
          {entry.entity_type ? (
            <p className="truncate font-mono text-2xs text-fg-subtle">
              {entry.entity_type}
              {entry.entity_id ? ` · ${entry.entity_id}` : ""}
            </p>
          ) : null}
        </div>
      ),
    },
    ...(isAdmin
      ? [
          {
            id: "ip",
            header: "IP address",
            hideOnMobile: true,
            cell: (entry: AuditLogEntry) => <span className="font-mono text-xs text-fg-muted">{entry.ip_address ?? "—"}</span>,
          },
        ]
      : []),
    {
      id: "changes",
      header: <span className="sr-only">Changes</span>,
      align: "right",
      cell: (entry) => {
        const count = entry.changes ? Object.keys(entry.changes).length : 0;
        if (count === 0) return null;
        const open = expanded.has(entry.id);
        return (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => toggle(entry.id)}
            aria-expanded={open}
            leftIcon={open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          >
            {count} change{count === 1 ? "" : "s"}
          </Button>
        );
      },
    },
  ];

  const prefixOptions = ACTION_PREFIXES.filter((option) => isAdmin || !ADMIN_ONLY_PREFIXES.has(option.value));
  const knownPrefix = prefixOptions.some((option) => option.value === actionFilter);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="An immutable record of changes made in this organization."
        breadcrumbs={[{ label: "Admin" }, { label: "Audit log" }]}
      />
      {!isAdmin ? (
        <Alert tone="info" className="mb-4">
          Security events (sign-ins, membership and invitation changes) and IP addresses are visible to admins only.
        </Alert>
      ) : null}
      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 md:flex-row md:items-center">
          <Select
            size="sm"
            className="md:w-52"
            aria-label="Filter by area"
            value={knownPrefix ? actionFilter || "all" : "all"}
            onValueChange={(value) => table.setFilter("action", value === "all" ? null : value)}
            options={prefixOptions.map((option) => ({ value: option.value, label: option.label }))}
          />
          <SearchInput
            value={knownPrefix ? "" : actionFilter}
            onChange={(value) => table.setFilter("action", value.trim() || null)}
            placeholder="Action starts with… e.g. organization.updated"
            aria-label="Filter by action prefix"
            className="md:w-80"
          />
          <SearchInput
            value={table.filters.entity_type ?? ""}
            onChange={(value) => table.setFilter("entity_type", value.trim() || null)}
            placeholder="Entity type, e.g. membership"
            aria-label="Filter by entity type"
            className="md:w-60"
          />
        </div>
        <DataTable
          columns={columns}
          data={activity.data?.items}
          getRowId={(entry) => entry.id}
          getRowLabel={(entry) => `${entry.action} at ${formatDateTime(entry.created_at)}`}
          isLoading={activity.isLoading}
          isFetching={activity.isFetching}
          error={activity.error}
          onRetry={() => void activity.refetch()}
          sort={table.sort}
          onSortChange={(sort) => table.setSort(sort ?? { key: "created_at", order: "desc" })}
          skeletonRows={8}
          caption="Organization activity"
          renderExpanded={(entry) =>
            expanded.has(entry.id) && entry.changes && Object.keys(entry.changes).length > 0 ? (
              <ChangesTable changes={entry.changes} />
            ) : null
          }
          emptyState={
            <EmptyState
              compact
              icon={<ScrollText aria-hidden />}
              title="No activity found"
              description={actionFilter || table.filters.entity_type ? "Try clearing the filters." : "Changes to this organization will appear here."}
              action={
                actionFilter || table.filters.entity_type ? (
                  <Button size="sm" variant="outline" onClick={table.reset}>
                    Clear filters
                  </Button>
                ) : null
              }
            />
          }
          footer={
            activity.data ? (
              <Pagination
                page={table.page}
                pageSize={table.pageSize}
                total={activity.data.total}
                onPageChange={table.setPage}
                onPageSizeChange={table.setPageSize}
                disabled={activity.isFetching}
              />
            ) : null
          }
        />
      </Card>
    </>
  );
}
