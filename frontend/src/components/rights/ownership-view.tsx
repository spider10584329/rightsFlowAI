"use client";

import { AlertTriangle, ArrowRight, BadgeCheck, CalendarDays, Ban, Archive, GitBranch, PieChart, Scale } from "lucide-react";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn, type RowAction } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { useReferenceList } from "@/lib/api/hooks/reference";
import { useAssetOwnership, type AssetType, type OwnershipRights, type OwnershipShareLine, type RightsType } from "@/lib/api/hooks/rights";
import { cn } from "@/lib/utils";

import { ConflictStatusBadge, SeverityBadge, TotalStatusBadge, VerificationBadge, ShareStatusBadge } from "./badges";
import { formatPercent, periodLabel, RIGHTS_TYPE_HINTS, rightsTypeLabel, roleLabel, territoryLabel } from "./rights-format";
import type { ShareActionTarget } from "./share-action-dialogs";
import { IssueList } from "./validation-report";



export interface OwnershipViewProps {
  orgId: string;
  assetType: AssetType;
  assetId: string;
  onDate: string;
  territory: string;
  onDateChange: (value: string) => void;
  onTerritoryChange: (value: string) => void;
  canEdit: boolean;
  onShareAction: (target: NonNullable<ShareActionTarget>) => void;
  onEditSplits: () => void;
}

export function OwnershipView({ orgId, assetType, assetId, onDate, territory, onDateChange, onTerritoryChange, canEdit, onShareAction, onEditSplits }: OwnershipViewProps) {
  const ownership = useAssetOwnership(orgId, assetType, assetId, { on_date: onDate, territory });
  const territories = useReferenceList("territories");

  return (
    <div className="space-y-5">
      <Card>
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start">
          <FormField label="Ownership on date" className="sm:w-48">
            <Input type="date" value={onDate} onChange={(event) => onDateChange(event.target.value)} />
          </FormField>
          <FormField label="Territory" className="sm:w-64" hint="Leave on “All territories” to see totals per territory group.">
            <NativeSelect value={territory} onChange={(event) => onTerritoryChange(event.target.value)}>
              <option value="">All territories</option>
              {(territories.data ?? [])
                .filter((item) => item.code !== "WORLD")
                .map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.name} ({item.code})
                  </option>
                ))}
            </NativeSelect>
          </FormField>
          <p className="flex items-center gap-1.5 text-xs text-fg-subtle sm:ml-auto sm:mt-8">
            <CalendarDays className="size-3.5" aria-hidden /> Only shares effective on this date are counted.
          </p>
        </div>
      </Card>

      {ownership.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 2 }, (_, index) => (
            <Card key={index} className="p-5">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="mt-4 h-10 w-full" />
              <Skeleton className="mt-3 h-24 w-full" />
            </Card>
          ))}
        </div>
      ) : ownership.error ? (
        <Card>
          <ErrorState error={ownership.error} onRetry={() => void ownership.refetch()} />
        </Card>
      ) : ownership.data ? (
        <>
          {ownership.data.open_conflicts.length > 0 ? (
            <Card>
              <CardHeader
                title={`${ownership.data.open_conflicts.length} unresolved ${ownership.data.open_conflicts.length === 1 ? "conflict" : "conflicts"}`}
                description="Conflicts are never auto-resolved. Review each one and record what was decided."
                actions={
                  <Link
                    href={`/rights/conflicts?${assetType === "work" ? "work_id" : "recording_id"}=${assetId}`}
                    className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline"
                  >
                    All conflicts for this asset <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                }
              />
              <ul className="divide-y divide-border">
                {ownership.data.open_conflicts.map((conflict) => (
                  <li key={conflict.id}>
                    <Link href={`/rights/conflicts/${conflict.id}`} className="flex flex-wrap items-center gap-2 px-5 py-3 text-[13px] hover:bg-surface-2">
                      <SeverityBadge severity={conflict.severity} />
                      <ConflictStatusBadge status={conflict.status} />
                      <span className="min-w-0 flex-1 truncate text-fg">{conflict.title}</span>
                      <ArrowRight className="size-3.5 text-fg-subtle" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          <div className="grid gap-5 xl:grid-cols-2">
            {ownership.data.rights.map((rights) => (
              <RightsCard
                key={rights.rights_type}
                rights={rights}
                canEdit={canEdit}
                onShareAction={onShareAction}
                onEditSplits={onEditSplits}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function RightsCard({
  rights,
  canEdit,
  onShareAction,
  onEditSplits,
}: {
  rights: OwnershipRights;
  canEdit: boolean;
  onShareAction: (target: NonNullable<ShareActionTarget>) => void;
  onEditSplits: () => void;
}) {
  const single = rights.totals.length === 1 ? rights.totals[0] : null;
  const controlled = Number(rights.controlled_percent ?? single?.controlled_percent ?? 0);
  const nonControlled = Number(rights.non_controlled_percent ?? single?.non_controlled_percent ?? 0);
  const blocking = rights.issues.filter((issue) => issue.blocking).length;

  const columns: DataTableColumn<OwnershipShareLine>[] = [
    {
      id: "party",
      header: "Party",
      cell: (line) => (
        <div className="min-w-0">
          <Link href={`/catalog/parties/${line.party_id}`} className="font-medium text-fg hover:text-primary hover:underline">
            {line.party_name ?? "Unknown party"}
          </Link>
          <p className="text-xs text-fg-subtle">
            {roleLabel(line.role)} · {line.is_controlled ? "Controlled" : "Not controlled"}
          </p>
        </div>
      ),
    },
    { id: "share", header: "Share", align: "right", cell: (line) => <span className="font-medium tabular-nums">{formatPercent(line.share_percent)}</span> },
    {
      id: "scope",
      header: "Scope",
      hideOnMobile: true,
      cell: (line) => (
        <div className="text-xs text-fg-muted">
          <p>{territoryLabel(line.territories, line.excluded_territories)}</p>
          <p className="text-fg-subtle">{periodLabel(line.effective_from, line.effective_to)}</p>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (line) => (
        <div className="flex flex-col items-start gap-1">
          <VerificationBadge status={line.verification_status} />
          {line.status !== "active" ? <ShareStatusBadge status={line.status} /> : null}
        </div>
      ),
    },
  ];

  const actions = (line: OwnershipShareLine): RowAction[] => {
    if (!canEdit) return [];
    const share = {
      id: line.share_id,
      party_id: line.party_id,
      party_name: line.party_name,
      role: line.role,
      share_percent: line.share_percent,
      territories: line.territories,
      excluded_territories: line.excluded_territories,
      effective_from: line.effective_from,
      effective_to: line.effective_to,
      is_controlled: line.is_controlled,
      rights_type: rights.rights_type,
      verification_status: line.verification_status,
    };
    const list: RowAction[] = [];
    if (line.verification_status !== "verified" && line.status === "active") {
      list.push({ label: "Verify", icon: <BadgeCheck aria-hidden />, onSelect: () => onShareAction({ kind: "verify", share }) });
    }
    if (line.status === "active") {
      list.push({ label: "Dispute", icon: <AlertTriangle aria-hidden />, onSelect: () => onShareAction({ kind: "dispute", share }) });
    }
    list.push({ label: "Supersede", icon: <GitBranch aria-hidden />, onSelect: () => onShareAction({ kind: "supersede", share }) });
    list.push({ label: "Archive", icon: <Archive aria-hidden />, destructive: true, separated: true, onSelect: () => onShareAction({ kind: "archive", share }) });
    return list;
  };

  return (
    <Card className="flex flex-col">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Scale className="size-4 text-fg-subtle" aria-hidden />
            {rightsTypeLabel(rights.rights_type)}
          </span>
        }
        description={RIGHTS_TYPE_HINTS[rights.rights_type as RightsType] ?? undefined}
        actions={
          single ? (
            <TotalStatusBadge status={single.status} />
          ) : rights.totals.length > 1 ? (
            <Badge tone="info">{rights.totals.length} territory groups</Badge>
          ) : (
            <Badge tone="neutral">No shares</Badge>
          )
        }
      />
      <CardBody className="flex-1 space-y-4">
        {rights.totals.length === 0 ? (
          <EmptyState
            compact
            icon={<PieChart aria-hidden />}
            title="No effective ownership"
            description="No active share covers this date and territory."
            action={
              canEdit ? (
                <button type="button" className="text-[13px] font-medium text-primary hover:underline" onClick={onEditSplits}>
                  Add splits
                </button>
              ) : null
            }
          />
        ) : (
          <>
            {single ? (
              <div>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-2xl font-semibold tabular-nums">{formatPercent(single.total)}</p>
                  <p className="text-xs text-fg-muted">expected {formatPercent(single.expected_total)} · {single.territory_label}</p>
                </div>
                <ControlBar controlled={controlled} nonControlled={nonControlled} />
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-[13px]">
                  <caption className="sr-only">Totals per territory group</caption>
                  <thead className="bg-surface-2/60 text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">Territories</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Total</th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">Controlled</th>
                      <th scope="col" className="px-3 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rights.totals.map((total, index) => (
                      <tr key={index}>
                        <td className="max-w-[14rem] px-3 py-2">
                          <span className="line-clamp-2" title={total.territory_label}>
                            {total.territory_label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">{formatPercent(total.total)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-fg-muted">{formatPercent(total.controlled_percent)}</td>
                        <td className="px-3 py-2">
                          <TotalStatusBadge status={total.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="-mx-5 overflow-x-auto border-y border-border">
              <DataTable
                columns={columns}
                data={rights.shares}
                getRowId={(line) => line.share_id}
                getRowLabel={(line) => `${line.party_name ?? "party"} ${roleLabel(line.role)}`}
                rowActions={canEdit ? actions : undefined}
                caption={`${rightsTypeLabel(rights.rights_type)} shares`}
              />
            </div>
          </>
        )}
        {rights.issues.length > 0 ? (
          <div className="space-y-2">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold">
              {blocking > 0 ? <Ban className="size-4 text-danger" aria-hidden /> : <AlertTriangle className="size-4 text-warning" aria-hidden />}
              {rights.issues.length} validation {rights.issues.length === 1 ? "issue" : "issues"}
            </h3>
            <IssueList issues={rights.issues} />
          </div>
        ) : rights.totals.length > 0 ? (
          <Alert tone="success">Totals match the split rules on this date.</Alert>
        ) : null}
      </CardBody>
    </Card>
  );
}

function ControlBar({ controlled, nonControlled }: { controlled: number; nonControlled: number }) {
  const total = Math.max(100, controlled + nonControlled);
  return (
    <div className="mt-3 space-y-1.5">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <div className="h-full bg-primary" style={{ width: `${(controlled / total) * 100}%` }} />
        <div className={cn("h-full bg-accent")} style={{ width: `${(nonControlled / total) * 100}%` }} />
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-primary" aria-hidden />
          <dt>Controlled</dt>
          <dd className="font-medium tabular-nums text-fg">{formatPercent(String(controlled))}</dd>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-accent" aria-hidden />
          <dt>Not controlled</dt>
          <dd className="font-medium tabular-nums text-fg">{formatPercent(String(nonControlled))}</dd>
        </div>
      </dl>
    </div>
  );
}
