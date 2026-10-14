"use client";

import { Clock, EyeOff, Maximize2, ScanSearch, ShieldCheck } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { ConflictStatusBadge, ConflictTypeBadge, RightsTypeBadge, SeverityBadge } from "@/components/rights/badges";
import { ConflictDetail } from "@/components/rights/conflict-detail";
import { CONFLICT_STATUSES, CONFLICT_TYPE_LABELS, RIGHTS_TYPE_LABELS, SEVERITIES } from "@/components/rights/rights-format";
import { SideSheet } from "@/components/rights/side-sheet";
import { useOrg } from "@/components/session/org-provider";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { useConflict, useConflicts, useScanConflicts, type RightsConflict } from "@/lib/api/hooks/rights";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { formatDateTime, titleCase } from "@/lib/utils";

const FILTER_KEYS = ["status", "severity", "type", "rights_type", "work_id", "recording_id"] as const;
const ALL = "all";

export function ConflictsClient() {
  const { org, can } = useOrg();
  const canEdit = can("manager");
  const table = useTableQueryState({ filterKeys: FILTER_KEYS, defaultSort: { key: "severity", order: "desc" } });
  const { filters } = table;
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const openId = searchParams.get("conflict");

  const conflicts = useConflicts(org.id, {
    page: table.page,
    page_size: table.pageSize,
    sort: table.sort?.key,
    order: table.sort?.order,
    status: filters.status || undefined,
    severity: filters.severity || undefined,
    type: filters.type || undefined,
    rights_type: filters.rights_type || undefined,
    work_id: filters.work_id || undefined,
    recording_id: filters.recording_id || undefined,
  });
  const scan = useScanConflicts(org.id);

  const setOpen = (id: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("conflict", id);
    else params.delete("conflict");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const runScan = () =>
    scan.mutate(undefined, {
      onSuccess: (result) =>
        toast.success("Conflict scan complete", {
          description: `${result.scanned_assets} assets scanned · ${result.detected} detected · ${result.new} new · ${result.no_longer_detected} no longer detected`,
        }),
      onError: (error) => toast.error("Scan failed", { description: errorMessage(error) }),
    });

  const columns: DataTableColumn<RightsConflict>[] = [
    { id: "severity", header: "Severity", sortKey: "severity", cell: (conflict) => <SeverityBadge severity={conflict.severity} /> },
    {
      id: "title",
      header: "Conflict",
      cell: (conflict) => (
        <div className="min-w-0 max-w-xl">
          <p className="line-clamp-2 font-medium text-fg">{conflict.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <ConflictTypeBadge type={conflict.conflict_type} />
            {conflict.rights_type ? <RightsTypeBadge rightsType={conflict.rights_type} /> : null}
            {conflict.asset_type ? <Badge tone="neutral">{titleCase(conflict.asset_type)}</Badge> : null}
          </div>
        </div>
      ),
    },
    { id: "status", header: "Status", cell: (conflict) => <ConflictStatusBadge status={conflict.status} /> },
    {
      id: "detected",
      header: "Detection",
      sortKey: "last_detected_at",
      hideOnMobile: true,
      cell: (conflict) => (
        <div className="text-xs">
          {conflict.still_detected ? (
            <span className="inline-flex items-center gap-1 text-fg">
              <Clock className="size-3.5 text-danger" aria-hidden /> Still detected
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-info-soft-fg">
              <EyeOff className="size-3.5" aria-hidden /> No longer detected — needs confirmation
            </span>
          )}
          <p className="text-fg-subtle">{formatDateTime(conflict.last_detected_at)}</p>
        </div>
      ),
    },
  ];

  const hasFilters = FILTER_KEYS.some((key) => filters[key]);

  return (
    <>
      <PageHeader
        title="Rights conflicts"
        description="Over- and under-allocations, overlapping claims, duplicates and bad data found in your ownership records. Conflicts are never resolved automatically."
        breadcrumbs={[{ label: "Rights", href: "/rights" }, { label: "Conflicts" }]}
        actions={
          canEdit ? (
            <Button leftIcon={<ScanSearch aria-hidden />} loading={scan.isPending} onClick={runScan}>
              Run scan
            </Button>
          ) : null
        }
      />
      <Card>
        <div className="flex flex-col gap-2 border-b border-border px-5 py-3 md:flex-row md:flex-wrap md:items-center">
          <FilterSelect label="Status" allLabel="All statuses" value={filters.status} onChange={(value) => table.setFilter("status", value)} options={CONFLICT_STATUSES.map((value) => ({ value, label: titleCase(value) }))} />
          <FilterSelect label="Severity" allLabel="All severities" value={filters.severity} onChange={(value) => table.setFilter("severity", value)} options={SEVERITIES.map((value) => ({ value, label: titleCase(value) }))} />
          <FilterSelect
            label="Type"
            allLabel="All types"
            value={filters.type}
            onChange={(value) => table.setFilter("type", value)}
            options={Object.entries(CONFLICT_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
            className="md:w-48"
          />
          <FilterSelect
            label="Rights type"
            allLabel="All rights types"
            value={filters.rights_type}
            onChange={(value) => table.setFilter("rights_type", value)}
            options={Object.entries(RIGHTS_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
          />
          {filters.work_id || filters.recording_id ? (
            <Badge tone="primary" className="h-7 gap-2">
              Filtered to one {filters.work_id ? "work" : "recording"}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  const params = new URLSearchParams(searchParams.toString());
                  params.delete("work_id");
                  params.delete("recording_id");
                  params.delete("page");
                  const query = params.toString();
                  router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
                }}
              >
                Clear
              </button>
            </Badge>
          ) : null}
          {hasFilters ? (
            <Button variant="ghost" size="sm" className="md:ml-auto" onClick={table.reset}>
              Reset filters
            </Button>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <DataTable
            columns={columns}
            data={conflicts.data?.items}
            getRowId={(conflict) => conflict.id}
            getRowLabel={(conflict) => conflict.title}
            isLoading={conflicts.isLoading}
            isFetching={conflicts.isFetching}
            error={conflicts.error}
            onRetry={() => void conflicts.refetch()}
            sort={table.sort}
            onSortChange={table.setSort}
            onRowClick={(conflict) => setOpen(conflict.id)}
            rowActions={(conflict) => [{ label: "Open full page", icon: <Maximize2 aria-hidden />, onSelect: () => router.push(`/rights/conflicts/${conflict.id}`) }]}
            caption="Rights conflicts"
            emptyState={
              <EmptyState
                compact
                icon={<ShieldCheck aria-hidden />}
                title={hasFilters ? "No conflicts match these filters" : "No conflicts recorded"}
                description={hasFilters ? "Try a different status or severity." : "Run a scan to check every work and recording against your split rules."}
                action={
                  canEdit && !hasFilters ? (
                    <Button size="sm" variant="outline" onClick={runScan} loading={scan.isPending}>
                      Run scan
                    </Button>
                  ) : null
                }
              />
            }
            footer={
              conflicts.data && conflicts.data.total > 0 ? (
                <Pagination page={table.page} pageSize={table.pageSize} total={conflicts.data.total} onPageChange={table.setPage} onPageSizeChange={table.setPageSize} />
              ) : null
            }
          />
        </div>
      </Card>
      <ConflictDrawer orgId={org.id} id={openId} canEdit={canEdit} onClose={() => setOpen(null)} />
    </>
  );
}

function FilterSelect({
  label,
  allLabel,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  allLabel: string;
  value: string;
  onChange: (value: string | null) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <Select
      size="sm"
      className={className ?? "md:w-40"}
      aria-label={`Filter by ${label.toLowerCase()}`}
      value={value || ALL}
      onValueChange={(next) => onChange(next === ALL ? null : next)}
      options={[{ value: ALL, label: allLabel }, ...options]}
    />
  );
}

function ConflictDrawer({ orgId, id, canEdit, onClose }: { orgId: string; id: string | null; canEdit: boolean; onClose: () => void }) {
  const conflict = useConflict(orgId, id);
  return (
    <SideSheet
      open={Boolean(id)}
      onOpenChange={(open) => !open && onClose()}
      title={conflict.data?.title ?? "Conflict"}
      description="Review the explanation and record a decision."
      headerActions={
        id ? (
          <ButtonLink href={`/rights/conflicts/${id}`} variant="ghost" size="sm" aria-label="Open full page" title="Open full page">
            <Maximize2 aria-hidden />
          </ButtonLink>
        ) : null
      }
    >
      {conflict.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-6 w-60" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : conflict.error ? (
        <ErrorState error={conflict.error} onRetry={() => void conflict.refetch()} />
      ) : conflict.data ? (
        <ConflictDetail orgId={orgId} conflict={conflict.data} canEdit={canEdit} />
      ) : null}
    </SideSheet>
  );
}
