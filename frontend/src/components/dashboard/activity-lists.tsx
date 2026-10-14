"use client";

import { ArrowRight, CalendarClock, FileSpreadsheet, History, RefreshCw } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { entityHref, formatCount, formatMoney } from "@/components/dashboard/format";
import { Badge, statusTone } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { ActivityItem, ExpiringContract, RecentStatement } from "@/lib/api/hooks/dashboard";
import { formatDate, formatDateTime, formatRelative, titleCase } from "@/lib/utils";

function ListCard({ title, href, linkLabel, children }: { title: string; href: string; linkLabel: string; children: ReactNode }) {
  return (
    <Card className="flex min-w-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="text-[15px] font-semibold tracking-tight text-fg">{title}</h2>
        <Link href={href} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          {linkLabel} <ArrowRight className="size-3" aria-hidden />
        </Link>
      </div>
      <div className="flex-1">{children}</div>
    </Card>
  );
}

/** "work.created" -> "Work created". */
export function activityLabel(action: string): string {
  return titleCase(action.replace(/\./g, " ")).replace(/\s(\w)/g, (match) => match.toLowerCase());
}

export function RecentActivityList({ items, canEdit }: { items: ActivityItem[]; canEdit: boolean }) {
  return (
    <ListCard title="Recent catalog activity" href="/catalog" linkLabel="Catalog">
      {items.length === 0 ? (
        <EmptyState
          compact
          icon={<History aria-hidden />}
          title="No catalog activity yet"
          description="Changes to works, recordings, releases and parties appear here."
          action={canEdit ? <ButtonLink href="/catalog/works" size="sm" variant="outline">Add works</ButtonLink> : null}
        />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((item) => {
            const href = entityHref(item.entity_type, item.entity_id);
            const label = item.summary || activityLabel(item.action);
            return (
              <li key={item.id} className="px-5 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-fg">
                      {href ? (
                        <Link href={href} className="hover:text-primary hover:underline">
                          {label}
                        </Link>
                      ) : (
                        label
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-fg-subtle">
                      {activityLabel(item.action)} · {item.actor_name ?? "System"}
                    </p>
                  </div>
                  <time dateTime={item.created_at} title={formatDateTime(item.created_at)} className="shrink-0 text-xs text-fg-subtle">
                    {formatRelative(item.created_at)}
                  </time>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </ListCard>
  );
}

export function RecentStatementsList({ items, canEdit }: { items: RecentStatement[]; canEdit: boolean }) {
  return (
    <ListCard title="Recent statement imports" href="/royalties/statements" linkLabel="All statements">
      {items.length === 0 ? (
        <EmptyState
          compact
          icon={<FileSpreadsheet aria-hidden />}
          title="No statements imported"
          description="Import a statement from a DSP, distributor or society to start tracking royalties."
          action={canEdit ? <ButtonLink href="/royalties/statements" size="sm" variant="outline">Import your first statement</ButtonLink> : null}
        />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((statement) => (
            <li key={statement.id} className="px-5 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/royalties/statements/${statement.id}`} className="block truncate text-[13px] font-medium text-fg hover:text-primary hover:underline">
                    {statement.source_name}
                  </Link>
                  <p className="mt-0.5 text-xs text-fg-subtle">
                    {formatDate(statement.period_start)} – {formatDate(statement.period_end)} · {formatCount(statement.matched_rows)}/{formatCount(statement.valid_rows)} matched
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-[13px] font-medium text-fg tabular-nums">{formatMoney(statement.total_amount, statement.currency)}</span>
                  <Badge tone={statusTone(statement.status)} dot>
                    {titleCase(statement.status)}
                  </Badge>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </ListCard>
  );
}

export function ExpiringContractsList({ items, canEdit }: { items: ExpiringContract[]; canEdit: boolean }) {
  return (
    <ListCard title="Upcoming contract expirations" href="/contracts" linkLabel="Contracts">
      {items.length === 0 ? (
        <EmptyState
          compact
          icon={<CalendarClock aria-hidden />}
          title="Nothing expiring in the next 90 days"
          description="Active contracts with an end date inside 90 days appear here."
          action={canEdit ? <ButtonLink href="/contracts" size="sm" variant="outline">View contracts</ButtonLink> : null}
        />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((contract) => (
            <li key={contract.id} className="px-5 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/contracts/${contract.id}`} className="block truncate text-[13px] font-medium text-fg hover:text-primary hover:underline">
                    {contract.title}
                  </Link>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-fg-subtle">
                    {contract.reference ? <span className="font-mono">{contract.reference}</span> : null}
                    <span>{titleCase(contract.contract_type)}</span>
                    <span>· ends {formatDate(contract.end_date)}</span>
                    {contract.auto_renew ? (
                      <span className="inline-flex items-center gap-0.5">
                        · <RefreshCw className="size-3" aria-hidden /> auto-renews
                      </span>
                    ) : null}
                  </p>
                </div>
                <Badge tone={contract.days_remaining <= 30 ? "warning" : "neutral"} className="shrink-0">
                  {contract.days_remaining <= 0 ? "Ends today" : `${contract.days_remaining} day${contract.days_remaining === 1 ? "" : "s"}`}
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </ListCard>
  );
}
