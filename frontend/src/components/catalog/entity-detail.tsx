"use client";

import { Activity, Archive, ArchiveRestore, ChevronDown, ChevronUp, History, LayoutList, Pencil, Scale, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useState, type ReactNode } from "react";

import { RequestReviewButton } from "@/components/automation/request-review-button";
import { CompletenessMeter, StatusBadge } from "@/components/catalog/catalog-badges";
import { DeleteEntityDialog, useArchiveToggle, type EntityRef } from "@/components/catalog/entity-dialogs";
import { activityLabel, ENTITY_LABEL, entityHref, issueCodeLabel, SEVERITY_TONE } from "@/components/catalog/labels";
import { useOrg } from "@/components/session/org-provider";
import { DetailLoadError } from "@/components/shared/detail-load-error";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { KeyValueList, type KeyValueItem } from "@/components/ui/key-value";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEntityActivity, useValidationIssues, type CatalogActivity, type CatalogEntityType, type Completeness } from "@/lib/api/hooks/catalog";
import { formatDateTime, titleCase } from "@/lib/utils";

const TABS = ["overview", "ownership", "activity"] as const;
type DetailTab = (typeof TABS)[number];

/** Tab state kept in `?tab=` so links can target Activity or Ownership. */
export function useDetailTab(): [DetailTab, (tab: string) => void] {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = searchParams.get("tab");
  const tab = (TABS as readonly string[]).includes(raw ?? "") ? (raw as DetailTab) : "overview";
  const setTab = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "overview") params.delete("tab");
    else params.set("tab", value);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  return [tab, setTab];
}

export function DetailSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading">
      <div className="space-y-2">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-8 w-80 max-w-full" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Skeleton className="h-96 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  );
}

/** Not-found (with its own `h1` and a back link) or load-failure state for a catalog detail page. */
export function DetailError({ error, entity, onRetry }: { error: unknown; entity: CatalogEntityType; onRetry: () => void }) {
  const label = ENTITY_LABEL[entity];
  return (
    <DetailLoadError
      error={error}
      noun={label.singular}
      breadcrumbs={[{ label: "Catalog", href: "/catalog" }, { label: label.plural, href: entityHref(entity) }]}
      backHref={entityHref(entity)}
      backLabel={`Back to ${label.plural.toLowerCase()}`}
      onRetry={onRetry}
    />
  );
}

/** One identifier in the page header: label, value and an optional "missing" state. */
export function HeaderIdentifier({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">{label}</span>
      {value ? (
        <span className="select-all font-mono text-[13px] text-fg">{value}</span>
      ) : (
        <span className="text-xs italic text-warning-soft-fg">Missing</span>
      )}
    </div>
  );
}

export interface DetailShellProps {
  entity: CatalogEntityType;
  item: EntityRef & { status: string; updated_at: string; created_at: string };
  title: ReactNode;
  subtitle?: ReactNode;
  badges?: ReactNode;
  identifiers?: ReactNode;
  completeness?: Completeness;
  overview: ReactNode;
  ownership: ReactNode;
  side?: ReactNode;
}

export function DetailShell({ entity, item, title, subtitle, badges, identifiers, completeness, overview, ownership, side }: DetailShellProps) {
  const { org, can } = useOrg();
  const router = useRouter();
  const [tab, setTab] = useDetailTab();
  const [deleting, setDeleting] = useState(false);
  const archive = useArchiveToggle(org.id, entity);
  const label = ENTITY_LABEL[entity];
  const archived = item.status === "archived";

  return (
    <>
      <PageHeader
        title={title}
        meta={
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={item.status} />
            {badges}
          </div>
        }
        description={subtitle}
        breadcrumbs={[{ label: "Catalog", href: "/catalog" }, { label: label.plural, href: entityHref(entity) }, { label: item.title }]}
        actions={
          can("manager") ? (
            <>
              <ButtonLink href={entityHref(entity, item.id, "edit")} variant="outline" leftIcon={<Pencil aria-hidden />}>
                Edit
              </ButtonLink>
              <Button
                variant="outline"
                leftIcon={archived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
                loading={archive.pending}
                onClick={() => void archive.run(item, archived ? "restore" : "archive").catch(() => undefined)}
              >
                {archived ? "Restore" : "Archive"}
              </Button>
              {(entity === "work" || entity === "recording") && !archived ? <RequestReviewButton orgId={org.id} subjectType={entity} subjectId={item.id} /> : null}
              {can("admin") ? (
                <Button variant="ghost" className="text-danger hover:bg-danger-soft hover:text-danger" leftIcon={<Trash2 aria-hidden />} onClick={() => setDeleting(true)}>
                  Delete
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      {archived ? (
        <p className="-mt-2 mb-5 rounded-lg border border-border bg-surface-2 px-4 py-2.5 text-[13px] text-fg-muted">
          This {entity === "party" ? "party" : label.singular.toLowerCase()} is archived. It is hidden from default lists, matching and validation, but its history is kept.
        </p>
      ) : null}
      {identifiers ? <div className="-mt-2 mb-6 flex flex-wrap gap-x-6 gap-y-2 rounded-xl border border-border bg-surface px-5 py-3 shadow-xs">{identifiers}</div> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="overview">
                <LayoutList aria-hidden /> Overview
              </TabsTrigger>
              <TabsTrigger value="ownership">
                <Scale aria-hidden /> Ownership
              </TabsTrigger>
              <TabsTrigger value="activity">
                <History aria-hidden /> Activity
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="space-y-6">
              {overview}
            </TabsContent>
            <TabsContent value="ownership">{ownership}</TabsContent>
            <TabsContent value="activity">
              <ActivityPanel entity={entity} id={item.id} />
            </TabsContent>
          </Tabs>
        </div>
        <aside className="space-y-6" aria-label="Summary">
          {completeness ? (
            <Card>
              <CardHeader title="Completeness" description="Weighted score of the metadata societies and DSPs need." />
              <CardBody>
                <CompletenessMeter score={completeness.score} missing={completeness.missing} />
              </CardBody>
            </Card>
          ) : null}
          <EntityIssuesCard entity={entity} id={item.id} archived={archived} />
          {side}
          <Card>
            <CardHeader title="Record" />
            <CardBody className="py-1">
              <KeyValueList
                items={[
                  { label: "Created", value: formatDateTime(item.created_at) },
                  { label: "Last updated", value: formatDateTime(item.updated_at) },
                  { label: "ID", value: item.id, mono: true },
                ]}
              />
            </CardBody>
          </Card>
        </aside>
      </div>
      <DeleteEntityDialog
        orgId={org.id}
        entity={entity}
        item={deleting ? item : null}
        onClose={() => setDeleting(false)}
        onDeleted={() => router.push(entityHref(entity))}
        canArchive={can("manager")}
      />
    </>
  );
}

/** Validation issues for one entity (filtered client-side from the org-wide list). */
function EntityIssuesCard({ entity, id, archived }: { entity: CatalogEntityType; id: string; archived: boolean }) {
  const { org } = useOrg();
  const issues = useValidationIssues(org.id, { entity_type: entity, page_size: 500 }, { enabled: !archived });
  if (archived) return null;
  const mine = (issues.data?.items ?? []).filter((issue) => issue.entity_id === id);
  return (
    <Card>
      <CardHeader title="Validation" description="Deterministic metadata checks." />
      <CardBody className="py-3">
        {issues.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : issues.error ? (
          <ErrorState error={issues.error} compact onRetry={() => void issues.refetch()} />
        ) : mine.length === 0 ? (
          <p className="text-[13px] text-success-soft-fg">No validation issues.</p>
        ) : (
          <ul className="space-y-2">
            {mine.map((issue) => (
              <li key={issue.code} className="flex items-start gap-2 text-[13px]">
                <Badge tone={SEVERITY_TONE[issue.severity] ?? "neutral"} className="mt-0.5 shrink-0">
                  {titleCase(issue.severity)}
                </Badge>
                <span>
                  <span className="font-medium text-fg">{issueCodeLabel(issue.code)}</span>
                  <span className="block text-xs text-fg-muted">{issue.message}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.map((item) => renderValue(item)).join(", ");
  return JSON.stringify(value);
}

function isChange(value: unknown): value is { from: unknown; to: unknown } {
  return Boolean(value) && typeof value === "object" && value !== null && "from" in value && "to" in value;
}

function ChangeList({ changes }: { changes: Record<string, unknown> }) {
  return (
    <dl className="mt-2 space-y-1.5 rounded-lg border border-border bg-surface-2/50 p-3 text-xs">
      {Object.entries(changes).map(([field, change]) => (
        <div key={field} className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="font-medium text-fg-muted">{titleCase(field)}</dt>
          <dd className="min-w-0 break-words">
            {isChange(change) ? (
              <>
                <span className="rounded bg-danger-soft px-1 py-0.5 font-mono text-danger-soft-fg line-through decoration-danger/40">{renderValue(change.from)}</span>
                <span className="px-1.5 text-fg-subtle" aria-label="changed to">
                  →
                </span>
                <span className="rounded bg-success-soft px-1 py-0.5 font-mono text-success-soft-fg">{renderValue(change.to)}</span>
              </>
            ) : (
              <span className="font-mono text-fg-muted">{renderValue(change)}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ActivityEntry({ entry }: { entry: CatalogActivity }) {
  const [open, setOpen] = useState(false);
  const changeCount = entry.changes ? Object.keys(entry.changes).length : 0;
  return (
    <li className="relative pl-7">
      <span className="absolute left-0 top-1 flex size-5 items-center justify-center rounded-full border border-border bg-surface text-fg-subtle">
        <Activity className="size-3" aria-hidden />
      </span>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-[13px] text-fg">
          <span className="font-medium">{activityLabel(entry.action)}</span>
          {entry.summary ? <span className="text-fg-muted"> — {entry.summary}</span> : null}
        </p>
        <time className="text-xs text-fg-subtle" dateTime={entry.created_at}>
          {formatDateTime(entry.created_at)}
        </time>
      </div>
      <p className="text-xs text-fg-subtle">by {entry.actor_name ?? (entry.actor_user_id ? "a former member" : "system")}</p>
      {changeCount > 0 ? (
        <>
          <button type="button" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <ChevronUp className="size-3" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />}
            {changeCount} field change{changeCount === 1 ? "" : "s"}
          </button>
          {open && entry.changes ? <ChangeList changes={entry.changes} /> : null}
        </>
      ) : null}
    </li>
  );
}

export function ActivityPanel({ entity, id }: { entity: CatalogEntityType; id: string }) {
  const { org } = useOrg();
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const activity = useEntityActivity(org.id, entity, id, { page, page_size: pageSize });
  return (
    <Card>
      <CardHeader title="Change history" description="Every create, edit, archive and restore, from the audit log." />
      {activity.isLoading ? (
        <CardBody className="space-y-3">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </CardBody>
      ) : activity.error ? (
        <ErrorState error={activity.error} compact onRetry={() => void activity.refetch()} />
      ) : !activity.data || activity.data.items.length === 0 ? (
        <EmptyState compact icon={<History aria-hidden />} title="No activity yet" description="Changes will appear here." />
      ) : (
        <>
          <CardBody>
            <ol className="space-y-5 border-l border-border pl-0 [&>li]:-ml-2.5">
              {activity.data.items.map((entry) => (
                <ActivityEntry key={entry.id} entry={entry} />
              ))}
            </ol>
          </CardBody>
          {activity.data.total > pageSize ? (
            <div className="border-t border-border">
              <Pagination page={page} pageSize={pageSize} total={activity.data.total} onPageChange={setPage} disabled={activity.isFetching} />
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

/** Ownership tab for works and recordings: the Rights module owns the shares UI. */
export function OwnershipLink({ assetType, assetId, title }: { assetType: "work" | "recording"; assetId: string; title: string }) {
  const href = `/rights?asset_type=${assetType}&asset_id=${encodeURIComponent(assetId)}`;
  return (
    <Card>
      <EmptyState
        icon={<Scale aria-hidden />}
        title={`Ownership of “${title}”`}
        description={
          assetType === "work"
            ? "Publishing and writer shares by territory and rights type are managed in Rights & ownership."
            : "Master ownership and neighbouring-rights shares are managed in Rights & ownership."
        }
        action={
          <ButtonLink href={href} leftIcon={<Scale aria-hidden />}>
            View ownership & splits
          </ButtonLink>
        }
      />
    </Card>
  );
}

/** Simple related-items list used in overview tabs. */
export function RelatedList<T>({
  title,
  description,
  items,
  empty,
  getKey,
  render,
  action,
}: {
  title: string;
  description?: string;
  items: T[];
  empty: ReactNode;
  getKey: (item: T) => string;
  render: (item: T) => ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader title={title} description={description} actions={action} />
      {items.length === 0 ? (
        <div className="px-5 py-6 text-center text-[13px] text-fg-muted">{empty}</div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => (
            <Fragment key={getKey(item)}>
              <li className="px-5 py-3">{render(item)}</li>
            </Fragment>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function RelatedLink({ href, title, meta, aside }: { href: string; title: string; meta?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <Link href={href} className="block truncate text-sm font-medium text-fg hover:text-primary hover:underline">
          {title}
        </Link>
        {meta ? <p className="truncate text-xs text-fg-subtle">{meta}</p> : null}
      </div>
      {aside ? <div className="flex shrink-0 items-center gap-2">{aside}</div> : null}
    </div>
  );
}

export function MetadataCard({ title = "Metadata", items, children }: { title?: string; items: KeyValueItem[]; children?: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody className="py-1">
        <KeyValueList items={items} columns={2} />
        {children}
      </CardBody>
    </Card>
  );
}

export function externalIdItems(externalIds: Record<string, unknown> | null): KeyValueItem[] {
  if (!externalIds) return [];
  return Object.entries(externalIds).map(([key, value]) => ({ label: key, value: renderValue(value), mono: true }));
}

