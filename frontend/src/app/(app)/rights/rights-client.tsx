"use client";

import { AlertTriangle, BadgeCheck, Disc3, ExternalLink, FileText, History, Layers, PencilRuler, Scale, ScanSearch, ShieldAlert, SlidersHorizontal, Split } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";

import { AssetPicker, type PickedRef } from "@/components/rights/pickers";
import { OwnershipView } from "@/components/rights/ownership-view";
import { formatPercent, todayIso } from "@/components/rights/rights-format";
import { RightsHistory, ShareRecords } from "@/components/rights/rights-history";
import { ShareActionDialogs, type ShareActionTarget } from "@/components/rights/share-action-dialogs";
import { SplitsEditor } from "@/components/rights/splits-editor";
import { useOrg } from "@/components/session/org-provider";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { useAssetOwnership, useRightsSummary, useScanConflicts, type AssetType } from "@/lib/api/hooks/rights";
import { cn } from "@/lib/utils";

const TABS = ["ownership", "splits", "history"] as const;
type Tab = (typeof TABS)[number];

export function RightsClient() {
  const { org, can } = useOrg();
  const canEdit = can("manager");
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const assetTypeParam = searchParams.get("asset_type");
  const assetType: AssetType = assetTypeParam === "recording" ? "recording" : "work";
  const assetId = searchParams.get("asset_id");
  const tabParam = searchParams.get("tab");
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "ownership";
  const onDate = searchParams.get("on_date") ?? "";
  const territory = searchParams.get("territory") ?? "";

  const [pickerType, setPickerType] = useState<AssetType>(assetType);
  const [actionTarget, setActionTarget] = useState<ShareActionTarget>(null);
  const [selectedLabel, setSelectedLabel] = useState<PickedRef | null>(null);

  const update = useCallback(
    (changes: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const effectiveDate = onDate || todayIso();
  // Title for the picker when arriving through a deep link.
  const ownership = useAssetOwnership(org.id, assetId ? assetType : null, assetId, { on_date: onDate || undefined, territory: territory || undefined });
  const assetLabel =
    assetId && selectedLabel?.id === assetId ? selectedLabel : assetId && ownership.data ? { id: assetId, label: ownership.data.asset_title } : assetId ? { id: assetId, label: "Loading…" } : null;

  return (
    <>
      <PageHeader
        title="Rights ownership"
        description="Who owns what share of each work and recording, per rights type, territory and period — with validation against your split rules."
        breadcrumbs={[{ label: "Rights" }, { label: "Ownership" }]}
        actions={
          <>
            <ButtonLink href="/rights/conflicts" variant="outline" leftIcon={<ShieldAlert aria-hidden />}>
              Conflicts
            </ButtonLink>
            <ButtonLink href="/rights/split-sheets" variant="outline" leftIcon={<Split aria-hidden />}>
              Split sheets
            </ButtonLink>
            <ButtonLink href="/rights/rules" variant="outline" leftIcon={<SlidersHorizontal aria-hidden />}>
              Split rules
            </ButtonLink>
          </>
        }
      />

      <SummaryRow orgId={org.id} canScan={canEdit} />

      <Card className="mt-6">
        <div className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center">
          <div className="flex items-center gap-2">
            <Layers className="size-4 text-fg-subtle" aria-hidden />
            <h2 className="text-[15px] font-semibold">Asset</h2>
          </div>
          <div role="radiogroup" aria-label="Asset type" className="inline-flex rounded-md bg-surface-2 p-0.5 text-[13px] font-medium">
            {(["work", "recording"] as const).map((type) => (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={pickerType === type}
                onClick={() => setPickerType(type)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded px-3 py-1.5 transition-colors",
                  pickerType === type ? "bg-surface text-fg shadow-xs" : "text-fg-muted hover:text-fg",
                )}
              >
                {type === "work" ? <FileText className="size-3.5" aria-hidden /> : <Disc3 className="size-3.5" aria-hidden />}
                {type === "work" ? "Work" : "Recording"}
              </button>
            ))}
          </div>
          <AssetPicker
            orgId={org.id}
            assetType={pickerType}
            value={pickerType === assetType ? assetLabel : null}
            onChange={(value) => {
              setSelectedLabel(value);
              update({ asset_type: value ? pickerType : null, asset_id: value?.id ?? null, tab: null });
            }}
            aria-label={pickerType === "work" ? "Select a work" : "Select a recording"}
            className="lg:w-[28rem]"
          />
          {assetId ? (
            <Link
              href={`/catalog/${assetType === "work" ? "works" : "recordings"}/${assetId}`}
              className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline lg:ml-auto"
            >
              Open in catalog <ExternalLink className="size-3.5" aria-hidden />
            </Link>
          ) : null}
        </div>
      </Card>

      <div className="mt-6">
        {!assetId ? (
          <Card>
            <EmptyState
              icon={<Scale aria-hidden />}
              title="Select a work or recording"
              description="Search the catalog above to see effective ownership, validate totals and edit splits. Catalog pages link here directly."
            />
          </Card>
        ) : ownership.error && !ownership.data ? (
          <Card>
            <ErrorState error={ownership.error} onRetry={() => void ownership.refetch()} />
          </Card>
        ) : (
          <Tabs value={tab} onValueChange={(value) => update({ tab: value === "ownership" ? null : value })}>
            <TabsList>
              <TabsTrigger value="ownership">
                <Scale aria-hidden /> Ownership
              </TabsTrigger>
              <TabsTrigger value="splits">
                <PencilRuler aria-hidden /> {canEdit ? "Edit splits" : "Splits"}
              </TabsTrigger>
              <TabsTrigger value="history">
                <History aria-hidden /> History
              </TabsTrigger>
            </TabsList>
            <TabsContent value="ownership">
              <OwnershipView
                orgId={org.id}
                assetType={assetType}
                assetId={assetId}
                onDate={effectiveDate}
                territory={territory}
                onDateChange={(value) => update({ on_date: value || null })}
                onTerritoryChange={(value) => update({ territory: value || null })}
                canEdit={canEdit}
                onShareAction={setActionTarget}
                onEditSplits={() => update({ tab: "splits" })}
              />
            </TabsContent>
            <TabsContent value="splits">
              <SplitsEditor key={`${assetType}:${assetId}`} orgId={org.id} assetType={assetType} assetId={assetId} canEdit={canEdit} />
            </TabsContent>
            <TabsContent value="history" className="space-y-5">
              <ShareRecords orgId={org.id} assetType={assetType} assetId={assetId} canEdit={canEdit} onShareAction={setActionTarget} />
              <RightsHistory orgId={org.id} assetType={assetType} assetId={assetId} />
            </TabsContent>
          </Tabs>
        )}
      </div>

      <ShareActionDialogs orgId={org.id} target={actionTarget} onClose={() => setActionTarget(null)} />
    </>
  );
}

function SummaryRow({ orgId, canScan }: { orgId: string; canScan: boolean }) {
  const summary = useRightsSummary(orgId);
  const scan = useScanConflicts(orgId);
  if (summary.error) {
    return (
      <Card>
        <ErrorState compact error={summary.error} onRetry={() => void summary.refetch()} />
      </Card>
    );
  }
  const data = summary.data;
  const bySeverity = data?.unresolved_conflicts_by_severity ?? {};
  const severityHint = ["critical", "high", "medium", "low"]
    .filter((key) => bySeverity[key])
    .map((key) => `${bySeverity[key]} ${key}`)
    .join(" · ");
  return (
    <div className="space-y-3">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active shares" icon={<Layers aria-hidden />} loading={summary.isLoading} value={data?.active_shares.toLocaleString() ?? "—"} hint={data ? `${data.shares_total.toLocaleString()} recorded in total` : undefined} />
        <StatCard
          label="Verified"
          icon={<BadgeCheck aria-hidden />}
          loading={summary.isLoading}
          value={data ? formatPercent(data.verified_percent) : "—"}
          hint={data ? `${data.verified_active_shares.toLocaleString()} of ${data.active_shares.toLocaleString()} active shares` : undefined}
        />
        <StatCard
          label="Unresolved conflicts"
          icon={<ShieldAlert aria-hidden />}
          loading={summary.isLoading}
          value={
            data ? (
              <Link href="/rights/conflicts" className="hover:text-primary">
                {data.unresolved_conflicts.toLocaleString()}
              </Link>
            ) : (
              "—"
            )
          }
          hint={severityHint || (data ? "Nothing to review" : undefined)}
        />
        <StatCard
          label="Missing ownership"
          icon={<AlertTriangle aria-hidden />}
          loading={summary.isLoading}
          value={data?.assets_missing_ownership.toLocaleString() ?? "—"}
          hint={data ? `${data.works_missing_ownership} works · ${data.recordings_missing_ownership} recordings` : undefined}
        />
      </div>
      {canScan ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<ScanSearch aria-hidden />}
            loading={scan.isPending}
            onClick={() =>
              scan.mutate(undefined, {
                onSuccess: (result) =>
                  toast.success("Conflict scan complete", {
                    description: `${result.scanned_assets} assets scanned · ${result.detected} detected · ${result.new} new · ${result.no_longer_detected} no longer detected`,
                  }),
                onError: (error) => toast.error("Scan failed", { description: errorMessage(error) }),
              })
            }
          >
            Re-scan all assets for conflicts
          </Button>
        </div>
      ) : null}
    </div>
  );
}
