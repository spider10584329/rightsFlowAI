"use client";

import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  Copy,
  Disc3,
  Download,
  FileText,
  Gauge,
  GitMerge,
  History,
  Mic2,
  Plus,
  ShieldCheck,
  Upload,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { StatusBadge } from "@/components/catalog/catalog-badges";
import { MergeDialog, type MergeCandidate } from "@/components/catalog/merge-dialog";
import { BAND_META, codeLabel, completenessBand, ENTITY_LABEL, entityHref, issueCodeLabel, missingLabel, MISSING_IDENTIFIER_META, SEVERITY_TONE, type CompletenessBand } from "@/components/catalog/labels";
import { useOrg } from "@/components/session/org-provider";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuLinkItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatCard } from "@/components/ui/stat-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import {
  downloadCatalogExport,
  useCatalogCompleteness,
  useCatalogSummary,
  useDuplicates,
  useValidationIssues,
  type CatalogEntityType,
  type IssueSeverity,
} from "@/lib/api/hooks/catalog";
import { cn, formatRelative, pluralize, titleCase } from "@/lib/utils";

const ENTITY_ICON: Record<CatalogEntityType, typeof FileText> = { work: FileText, recording: Mic2, release: Disc3, party: UsersRound };
const ENTITIES: CatalogEntityType[] = ["work", "recording", "release", "party"];
const ALL = "__all";

export function CatalogOverviewClient() {
  const { org, can } = useOrg();
  const [exporting, setExporting] = useState<CatalogEntityType | null>(null);

  const exportCsv = async (entity: CatalogEntityType) => {
    setExporting(entity);
    try {
      await downloadCatalogExport(org.id, entity);
      toast.success(`${ENTITY_LABEL[entity].plural} exported`);
    } catch (error) {
      toast.error("Export failed", { description: errorMessage(error) });
    } finally {
      setExporting(null);
    }
  };

  return (
    <>
      <PageHeader
        title="Catalog"
        description="Works, recordings, releases and the people behind them — with the metadata health that drives accurate royalties."
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" leftIcon={<Download aria-hidden />} rightIcon={<ChevronDown aria-hidden />} loading={exporting !== null}>
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Download CSV</DropdownMenuLabel>
                {ENTITIES.map((entity) => {
                  const Icon = ENTITY_ICON[entity];
                  return (
                    <DropdownMenuItem key={entity} icon={<Icon aria-hidden />} onSelect={() => void exportCsv(entity)}>
                      {ENTITY_LABEL[entity].plural}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            {can("manager") ? (
              <>
                <ButtonLink href="/catalog/import" variant="outline" leftIcon={<Upload aria-hidden />}>
                  Import
                </ButtonLink>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button leftIcon={<Plus aria-hidden />} rightIcon={<ChevronDown aria-hidden />}>
                      New
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    {ENTITIES.map((entity) => {
                      const Icon = ENTITY_ICON[entity];
                      return (
                        <DropdownMenuLinkItem key={entity} href={`${entityHref(entity)}/new`} icon={<Icon aria-hidden />}>
                          {entity === "party" ? "Artist or contributor" : ENTITY_LABEL[entity].singular}
                        </DropdownMenuLinkItem>
                      );
                    })}
                    <DropdownMenuSeparator />
                    <DropdownMenuLinkItem href="/catalog/import" icon={<Upload aria-hidden />}>
                      Import from CSV/XLSX
                    </DropdownMenuLinkItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : null}
          </>
        }
      />
      <div className="space-y-6">
        <SummarySection orgId={org.id} />
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <CompletenessPanel orgId={org.id} />
          <IssuesPanel orgId={org.id} />
        </div>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <DuplicatesPanel orgId={org.id} canMerge={can("admin")} />
          <RecentPanel orgId={org.id} />
        </div>
      </div>
    </>
  );
}

// ----------------------------------------------------------------- summary

function SummarySection({ orgId }: { orgId: string }) {
  const summary = useCatalogSummary(orgId);
  if (summary.error) {
    return (
      <Card>
        <ErrorState error={summary.error} compact onRetry={() => void summary.refetch()} />
      </Card>
    );
  }
  const data = summary.data;
  const counts: Record<CatalogEntityType, number | undefined> = { work: data?.works, recording: data?.recordings, release: data?.releases, party: data?.parties };
  const roles = Object.entries(data?.parties_by_role ?? {}).sort((a, b) => b[1] - a[1]);
  const maxRole = roles.reduce((max, [, count]) => Math.max(max, count), 0);
  const missing = Object.entries(data?.missing_identifiers ?? {});

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {ENTITIES.map((entity) => {
          const Icon = ENTITY_ICON[entity];
          const archived = data?.archived[entity] ?? 0;
          return (
            <Link key={entity} href={entityHref(entity)} className="group rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              <StatCard
                label={ENTITY_LABEL[entity].plural}
                value={(counts[entity] ?? 0).toLocaleString()}
                icon={<Icon aria-hidden />}
                loading={summary.isLoading}
                hint={archived > 0 ? `${archived.toLocaleString()} archived` : "Active & draft"}
                className="transition-shadow group-hover:shadow-md"
              />
            </Link>
          );
        })}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Missing identifiers" description="Gaps that block registration, matching or delivery." />
          {summary.isLoading ? (
            <CardBody className="space-y-2">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-7 w-full" />
              ))}
            </CardBody>
          ) : (
            <ul className="divide-y divide-border">
              {missing.map(([key, count]) => {
                const meta = MISSING_IDENTIFIER_META[key] ?? { label: titleCase(key) };
                const content = (
                  <>
                    <span className="flex items-center gap-2 text-[13px] text-fg">
                      {count > 0 ? <AlertTriangle className="size-3.5 text-warning" aria-hidden /> : <ShieldCheck className="size-3.5 text-success" aria-hidden />}
                      {meta.label}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className={cn("text-sm font-semibold tabular-nums", count > 0 ? "text-fg" : "text-fg-subtle")}>{count.toLocaleString()}</span>
                      {meta.href && count > 0 ? <ArrowRight className="size-3.5 text-fg-subtle" aria-hidden /> : null}
                    </span>
                  </>
                );
                return (
                  <li key={key}>
                    {meta.href && count > 0 ? (
                      <Link href={meta.href} className="flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-surface-2">
                        {content}
                      </Link>
                    ) : (
                      <div className="flex items-center justify-between gap-3 px-5 py-2.5">{content}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Parties by role" description="Active artists, writers, publishers and labels. A party can hold several roles." />
          <CardBody>
            {summary.isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 5 }, (_, index) => (
                  <Skeleton key={index} className="h-5 w-full" />
                ))}
              </div>
            ) : roles.length === 0 ? (
              <EmptyState compact icon={<UsersRound aria-hidden />} title="No parties yet" description="Add artists and writers to credit them on works and recordings." />
            ) : (
              <ul className="space-y-2.5">
                {roles.map(([role, count]) => (
                  <li key={role}>
                    <Link href={`/catalog/parties?role=${role}`} className="group grid grid-cols-[7.5rem_minmax(0,1fr)_2.5rem] items-center gap-3 rounded text-[13px]">
                      <span className="truncate text-fg-muted group-hover:text-fg">{codeLabel(role)}</span>
                      <span className="h-2 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                        <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(4, (count / maxRole) * 100)}%` }} />
                      </span>
                      <span className="text-right font-medium tabular-nums text-fg">{count}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

// ----------------------------------------------------------------- completeness

const BANDS: CompletenessBand[] = ["complete", "high", "medium", "low"];

function CompletenessPanel({ orgId }: { orgId: string }) {
  const completeness = useCatalogCompleteness(orgId);
  const data = completeness.data;
  return (
    <Card>
      <CardHeader title="Metadata completeness" description="Weighted score across works, recordings and releases (archived items excluded)." />
      {completeness.isLoading ? (
        <CardBody className="space-y-3">
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-32 w-full" />
        </CardBody>
      ) : completeness.error ? (
        <ErrorState error={completeness.error} compact onRetry={() => void completeness.refetch()} />
      ) : !data || data.count === 0 ? (
        <EmptyState compact icon={<Gauge aria-hidden />} title="Nothing to score yet" description="Add works, recordings or releases to see completeness." />
      ) : (
        <CardBody className="space-y-5">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <p className="text-[34px] font-semibold leading-none tracking-tight tabular-nums text-fg">
                {data.average_score.toFixed(1)}
                <span className="text-lg text-fg-subtle">%</span>
              </p>
              <p className="mt-1 text-xs text-fg-muted">Average across {pluralize(data.count, "item")}</p>
            </div>
            <dl className="flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
              {Object.entries(data.by_entity_type).map(([type, group]) => (
                <div key={type}>
                  <dt className="text-xs text-fg-subtle">{titleCase(type)}s</dt>
                  <dd className="font-medium tabular-nums text-fg">
                    {group.average_score.toFixed(1)}% <span className="text-xs font-normal text-fg-subtle">· {group.count}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="space-y-2">
            <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={`Completeness bands: ${BANDS.map((band) => `${BAND_META[band].label} ${data.bands[band] ?? 0}`).join(", ")}`}>
              {BANDS.filter((band) => (data.bands[band] ?? 0) > 0).map((band) => (
                <span
                  key={band}
                  className={cn("h-full first:rounded-l-full last:rounded-r-full", BAND_META[band].bar)}
                  style={{ width: `${((data.bands[band] ?? 0) / data.count) * 100}%` }}
                  title={`${BAND_META[band].label} (${BAND_META[band].range}%): ${data.bands[band]}`}
                />
              ))}
            </div>
            <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              {BANDS.map((band) => (
                <li key={band} className="flex items-center gap-1.5 text-fg-muted">
                  <span className={cn("size-2 rounded-full", BAND_META[band].bar)} aria-hidden />
                  {BAND_META[band].label} <span className="text-fg-subtle">{BAND_META[band].range}%</span>
                  <span className="font-medium tabular-nums text-fg">{data.bands[band] ?? 0}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Least complete</h3>
            {data.least_complete.length === 0 ? null : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {data.least_complete.slice(0, 8).map((item) => (
                  <li key={`${item.entity_type}-${item.id}`} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-10 shrink-0 text-right text-sm font-semibold tabular-nums text-fg">{item.score}%</span>
                    <div className="min-w-0 flex-1">
                      <Link href={entityHref(item.entity_type, item.id)} className="block truncate text-[13px] font-medium text-fg hover:text-primary hover:underline">
                        {item.title}
                      </Link>
                      <p className="truncate text-xs text-fg-subtle">
                        {ENTITY_LABEL[item.entity_type].singular} · missing {item.missing.map(missingLabel).join(", ").toLowerCase() || "nothing"}
                      </p>
                    </div>
                    <Badge tone={BAND_META[completenessBand(item.score)].tone}>{BAND_META[completenessBand(item.score)].label}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardBody>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------- validation issues

function IssuesPanel({ orgId }: { orgId: string }) {
  const [entity, setEntity] = useState<CatalogEntityType | "">("");
  const [severity, setSeverity] = useState<IssueSeverity | "">("");
  const [code, setCode] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 8;
  const issues = useValidationIssues(orgId, { entity_type: entity || undefined, severity: severity || undefined, code: code || undefined, page, page_size: pageSize });
  const byCode = Object.entries(issues.data?.by_code ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <Card className="flex flex-col">
      <CardHeader title="Validation issues" description="Deterministic checks on identifiers, writers, artists and track lists." />
      <div className="flex flex-wrap gap-2 border-b border-border px-5 py-3">
        <Select
          size="sm"
          className="w-36"
          aria-label="Filter issues by type"
          value={entity || ALL}
          onValueChange={(value) => {
            setEntity(value === ALL ? "" : (value as CatalogEntityType));
            setCode("");
            setPage(1);
          }}
          options={[{ value: ALL, label: "All types" }, ...ENTITIES.map((value) => ({ value, label: ENTITY_LABEL[value].plural }))]}
        />
        <Select
          size="sm"
          className="w-36"
          aria-label="Filter issues by severity"
          value={severity || ALL}
          onValueChange={(value) => {
            setSeverity(value === ALL ? "" : (value as IssueSeverity));
            setPage(1);
          }}
          options={[{ value: ALL, label: "Any severity" }, { value: "error", label: "Errors" }, { value: "warning", label: "Warnings" }, { value: "info", label: "Info" }]}
        />
      </div>
      {byCode.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-b border-border px-5 py-3" role="group" aria-label="Filter by issue">
          {byCode.map(([issueCode, count]) => (
            <button
              key={issueCode}
              type="button"
              aria-pressed={code === issueCode}
              onClick={() => {
                setCode(code === issueCode ? "" : issueCode);
                setPage(1);
              }}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-2xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                code === issueCode ? "border-primary/40 bg-primary-soft text-primary-soft-fg" : "border-border bg-surface text-fg-muted hover:bg-surface-2",
              )}
            >
              {issueCodeLabel(issueCode)} <span className="tabular-nums text-fg">{count}</span>
            </button>
          ))}
        </div>
      ) : null}
      {issues.isLoading ? (
        <CardBody className="space-y-2">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </CardBody>
      ) : issues.error ? (
        <ErrorState error={issues.error} compact onRetry={() => void issues.refetch()} />
      ) : !issues.data || issues.data.items.length === 0 ? (
        <EmptyState compact icon={<ShieldCheck aria-hidden />} title={entity || severity || code ? "No matching issues" : "No validation issues"} description="Your catalog metadata passes every check." />
      ) : (
        <>
          <ul className={cn("flex-1 divide-y divide-border", issues.isFetching && "opacity-70")}>
            {issues.data.items.map((issue) => (
              <li key={`${issue.entity_id}-${issue.code}`} className="flex items-start gap-3 px-5 py-2.5">
                <Badge tone={SEVERITY_TONE[issue.severity] ?? "neutral"} className="mt-0.5 w-16 shrink-0 justify-center">
                  {titleCase(issue.severity)}
                </Badge>
                <div className="min-w-0 flex-1">
                  <Link href={entityHref(issue.entity_type, issue.entity_id)} className="block truncate text-[13px] font-medium text-fg hover:text-primary hover:underline">
                    {issue.title}
                  </Link>
                  <p className="truncate text-xs text-fg-subtle">
                    {ENTITY_LABEL[issue.entity_type].singular} · {issue.message}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          {issues.data.total > pageSize ? (
            <div className="border-t border-border">
              <Pagination page={page} pageSize={pageSize} total={issues.data.total} onPageChange={setPage} disabled={issues.isFetching} />
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

// ----------------------------------------------------------------- duplicates

function DuplicateList({ orgId, entity, canMerge }: { orgId: string; entity: CatalogEntityType; canMerge: boolean }) {
  const duplicates = useDuplicates(orgId, entity, 25);
  const [merging, setMerging] = useState<[MergeCandidate, MergeCandidate] | null>(null);
  if (duplicates.isLoading) {
    return (
      <div className="space-y-2 p-5">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    );
  }
  if (duplicates.error) return <ErrorState error={duplicates.error} compact onRetry={() => void duplicates.refetch()} />;
  if (!duplicates.data || duplicates.data.length === 0) {
    return <EmptyState compact icon={<Copy aria-hidden />} title="No likely duplicates" description={`No ${ENTITY_LABEL[entity].plural.toLowerCase()} share an identifier or a near-identical title.`} />;
  }
  return (
    <ul className="divide-y divide-border">
      {duplicates.data.map((candidate) => (
        <li key={candidate.ids.join("|")} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center">
          <div className="flex w-14 shrink-0 flex-col items-start sm:items-center">
            <span className="text-sm font-semibold tabular-nums text-fg">{Math.round(candidate.score * 100)}%</span>
            <span className="text-2xs text-fg-subtle">match</span>
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
              {candidate.ids.map((id, index) => (
                <span key={id} className="flex min-w-0 items-center gap-2">
                  {index > 0 ? <span className="text-fg-subtle">vs</span> : null}
                  <Link href={entityHref(entity, id)} className="truncate font-medium text-fg hover:text-primary hover:underline">
                    {candidate.titles[index] ?? id}
                  </Link>
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {candidate.reasons.map((reason) => (
                <Badge key={reason} tone="warning">
                  {reason}
                </Badge>
              ))}
            </div>
          </div>
          {canMerge && candidate.ids.length === 2 ? (
            <Button
              size="sm"
              variant="outline"
              leftIcon={<GitMerge aria-hidden />}
              onClick={() =>
                setMerging([
                  { id: candidate.ids[0], title: candidate.titles[0] ?? candidate.ids[0] },
                  { id: candidate.ids[1], title: candidate.titles[1] ?? candidate.ids[1] },
                ])
              }
            >
              Merge…
            </Button>
          ) : null}
        </li>
      ))}
      {merging ? (
        <MergeDialog
          key={merging.map((c) => c.id).join("|")}
          orgId={orgId}
          entity={entity}
          candidates={merging}
          open
          onOpenChange={(open) => !open && setMerging(null)}
        />
      ) : null}
    </ul>
  );
}

function DuplicatesPanel({ orgId, canMerge }: { orgId: string; canMerge: boolean }) {
  const [tab, setTab] = useState<CatalogEntityType>("work");
  return (
    <Card>
      <CardHeader title="Duplicate candidates" description={canMerge ? "Same identifier or near-identical normalized titles. Review each pair, then merge or dismiss." : "Same identifier or near-identical normalized titles. An admin can merge confirmed duplicates."} />
      <Tabs value={tab} onValueChange={(value) => setTab(value as CatalogEntityType)}>
        <TabsList className="px-3">
          {ENTITIES.map((entity) => (
            <TabsTrigger key={entity} value={entity}>
              {entity === "party" ? "Parties" : ENTITY_LABEL[entity].plural}
            </TabsTrigger>
          ))}
        </TabsList>
        {ENTITIES.map((entity) => (
          <TabsContent key={entity} value={entity} className="pt-0">
            {tab === entity ? <DuplicateList orgId={orgId} entity={entity} canMerge={canMerge} /> : null}
          </TabsContent>
        ))}
      </Tabs>
    </Card>
  );
}

// ----------------------------------------------------------------- recent

function RecentPanel({ orgId }: { orgId: string }) {
  const summary = useCatalogSummary(orgId);
  const recent = summary.data?.recently_updated ?? [];
  return (
    <Card>
      <CardHeader title="Recent activity" description="Most recently created or changed items." />
      {summary.isLoading ? (
        <CardBody className="space-y-2">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </CardBody>
      ) : summary.error ? (
        <ErrorState error={summary.error} compact onRetry={() => void summary.refetch()} />
      ) : recent.length === 0 ? (
        <EmptyState compact icon={<History aria-hidden />} title="No catalog activity yet" description="New and edited items will show up here." />
      ) : (
        <ul className="divide-y divide-border">
          {recent.map((item) => {
            const Icon = ENTITY_ICON[item.entity_type] ?? FileText;
            return (
              <li key={`${item.entity_type}-${item.id}`} className="flex items-center gap-3 px-5 py-2.5">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-subtle">
                  <Icon className="size-3.5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <Link href={entityHref(item.entity_type, item.id)} className="block truncate text-[13px] font-medium text-fg hover:text-primary hover:underline">
                    {item.title}
                  </Link>
                  <p className="text-xs text-fg-subtle">
                    {ENTITY_LABEL[item.entity_type].singular} · {formatRelative(item.updated_at)}
                  </p>
                </div>
                <StatusBadge status={item.status} />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
