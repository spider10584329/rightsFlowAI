"use client";

import { Archive, BadgeCheck, GitBranch, History, AlertTriangle } from "lucide-react";
import { useState } from "react";

import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn, type RowAction } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { useAssetHistory, useAssetShares, type AssetType, type AuditEntry, type Share } from "@/lib/api/hooks/rights";
import { formatDateTime, titleCase } from "@/lib/utils";

import { RightsTypeBadge, ShareStatusBadge, VerificationBadge } from "./badges";
import { formatPercent, periodLabel, roleLabel, territoryLabel } from "./rights-format";
import type { ShareActionTarget } from "./share-action-dialogs";

const STATUS_FILTERS = ["all", "active", "disputed", "superseded", "archived"] as const;

export function ShareRecords({
  orgId,
  assetType,
  assetId,
  canEdit,
  onShareAction,
}: {
  orgId: string;
  assetType: AssetType;
  assetId: string;
  canEdit: boolean;
  onShareAction: (target: NonNullable<ShareActionTarget>) => void;
}) {
  const shares = useAssetShares(orgId, assetType, assetId);
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const rows = shares.data?.filter((share) => status === "all" || share.status === status);

  const columns: DataTableColumn<Share>[] = [
    {
      id: "party",
      header: "Party",
      cell: (share) => (
        <div>
          <p className="font-medium">{share.party_name ?? "Unknown party"}</p>
          <p className="text-xs text-fg-subtle">
            {roleLabel(share.role)} · {share.source === "split_sheet" ? "From split sheet" : titleCase(share.source)}
          </p>
        </div>
      ),
    },
    { id: "rights", header: "Rights", cell: (share) => <RightsTypeBadge rightsType={share.rights_type} /> },
    { id: "share", header: "Share", align: "right", cell: (share) => <span className="tabular-nums">{formatPercent(share.share_percent)}</span> },
    {
      id: "scope",
      header: "Scope",
      hideOnMobile: true,
      cell: (share) => (
        <div className="text-xs text-fg-muted">
          <p>{territoryLabel(share.territories, share.excluded_territories)}</p>
          <p className="text-fg-subtle">{periodLabel(share.effective_from, share.effective_to)}</p>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (share) => (
        <div className="flex flex-col items-start gap-1">
          <ShareStatusBadge status={share.status} />
          <VerificationBadge status={share.verification_status} />
        </div>
      ),
    },
    { id: "created", header: "Created", hideOnMobile: true, cell: (share) => <span className="text-xs">{formatDateTime(share.created_at)}</span> },
  ];

  const actions = (share: Share): RowAction[] => {
    if (!canEdit || (share.status !== "active" && share.status !== "disputed")) return [];
    const list: RowAction[] = [];
    if (share.status === "active" && share.verification_status !== "verified") {
      list.push({ label: "Verify", icon: <BadgeCheck aria-hidden />, onSelect: () => onShareAction({ kind: "verify", share }) });
    }
    if (share.status === "active") list.push({ label: "Dispute", icon: <AlertTriangle aria-hidden />, onSelect: () => onShareAction({ kind: "dispute", share }) });
    list.push({ label: "Supersede", icon: <GitBranch aria-hidden />, onSelect: () => onShareAction({ kind: "supersede", share }) });
    list.push({ label: "Archive", icon: <Archive aria-hidden />, destructive: true, separated: true, onSelect: () => onShareAction({ kind: "archive", share }) });
    return list;
  };

  return (
    <Card>
      <CardHeader
        title="All share records"
        description="Every share ever recorded for this asset, including superseded and archived ones."
        actions={
          <Select
            size="sm"
            className="w-40"
            aria-label="Filter shares by status"
            value={status}
            onValueChange={setStatus}
            options={STATUS_FILTERS.map((value) => ({ value, label: value === "all" ? "All statuses" : titleCase(value) }))}
          />
        }
      />
      <div className="overflow-x-auto">
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(share) => share.id}
          getRowLabel={(share) => `${share.party_name ?? "party"} ${share.rights_type}`}
          isLoading={shares.isLoading}
          error={shares.error}
          onRetry={() => void shares.refetch()}
          rowActions={canEdit ? actions : undefined}
          caption="Share records"
          emptyState={<EmptyState compact title="No shares" description="No shares match this filter." />}
        />
      </div>
    </Card>
  );
}

export function RightsHistory({ orgId, assetType, assetId }: { orgId: string; assetType: AssetType; assetId: string }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const history = useAssetHistory(orgId, assetType, assetId, { page, page_size: pageSize });

  const columns: DataTableColumn<AuditEntry>[] = [
    { id: "when", header: "When", cell: (entry) => <span className="whitespace-nowrap text-[13px]">{formatDateTime(entry.created_at)}</span> },
    { id: "who", header: "By", cell: (entry) => entry.actor_name ?? (entry.actor_user_id ? "Team member" : "System") },
    { id: "action", header: "Action", cell: (entry) => <span className="font-medium">{titleCase(entry.action.replace(/^ownership_share\./, ""))}</span> },
    { id: "summary", header: "Details", cell: (entry) => <span className="text-[13px] text-fg-muted">{entry.summary ?? "—"}</span> },
  ];

  return (
    <Card>
      <CardHeader title="Rights history" description="Audit trail of every change to this asset's shares: who changed what, and why." />
      <div className="overflow-x-auto">
        <DataTable
          columns={columns}
          data={history.data?.items}
          getRowId={(entry) => entry.id}
          isLoading={history.isLoading}
          isFetching={history.isFetching}
          error={history.error}
          onRetry={() => void history.refetch()}
          caption="Rights history"
          emptyState={<EmptyState compact icon={<History aria-hidden />} title="No history yet" description="Changes to shares will appear here." />}
          footer={
            history.data && history.data.total > 0 ? (
              <Pagination
                page={page}
                pageSize={pageSize}
                total={history.data.total}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            ) : null
          }
        />
      </div>
    </Card>
  );
}
