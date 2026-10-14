"use client";

import { CheckCircle2, Link2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { MatchDialog, type MatchTarget } from "@/components/royalties/match-dialog";
import { Money } from "@/components/royalties/shared";
import { useOrg } from "@/components/session/org-provider";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { useUnmatched, type UnmatchedGroup } from "@/lib/api/hooks/royalties";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";

export function UnmatchedClient() {
  const { org, can } = useOrg();
  const table = useTableQueryState({ defaultPageSize: 25 });
  const groups = useUnmatched(org.id, { page: table.page, page_size: table.pageSize });
  const [target, setTarget] = useState<MatchTarget | null>(null);
  const canManage = can("manager");

  const label = (g: UnmatchedGroup) => `${g.title ?? g.isrc ?? g.iswc ?? "Untitled"}${g.artist ? ` — ${g.artist}` : ""} · ${g.statement_source}`;

  const columns: DataTableColumn<UnmatchedGroup>[] = [
    {
      id: "title",
      header: "Title · artist",
      cell: (g) => (
        <div className="min-w-0 max-w-[18rem]">
          <p className="truncate font-medium text-fg">{g.title ?? <span className="text-fg-subtle">No title</span>}</p>
          <p className="truncate text-xs text-fg-subtle">{g.artist ?? "—"}</p>
        </div>
      ),
    },
    {
      id: "ids",
      header: "Identifiers",
      cell: (g) => (
        <div className="font-mono text-xs">
          {g.isrc ? <p>ISRC {g.isrc}</p> : null}
          {g.iswc ? <p>ISWC {g.iswc}</p> : null}
          {!g.isrc && !g.iswc ? <span className="font-sans text-fg-subtle">—</span> : null}
        </div>
      ),
    },
    {
      id: "statement",
      header: "Statement",
      cell: (g) => (
        <Link href={`/royalties/statements/${g.statement_id}?tab=unmatched`} className="text-[13px] text-primary hover:underline">
          {g.statement_source}
        </Link>
      ),
    },
    { id: "lines", header: "Lines", align: "right", cell: (g) => <span className="tabular-nums">{g.line_count.toLocaleString()}</span> },
    { id: "amount", header: "Amount", align: "right", cell: (g) => <Money amount={g.amount} currency={g.currency} precision="exact" className="font-medium" /> },
    {
      id: "action",
      header: <span className="sr-only">Match</span>,
      align: "right",
      cell: (g) =>
        canManage ? (
          <Button
            size="xs"
            variant="outline"
            leftIcon={<Link2 aria-hidden />}
            onClick={() =>
              setTarget({
                statementId: g.statement_id,
                keyLine: { id: g.sample_line_id, isrc: g.isrc, title: g.title, artist: g.artist },
                groupOnly: true,
                label: `${g.line_count} unmatched line${g.line_count === 1 ? "" : "s"}: ${label(g)}`,
              })
            }
          >
            Match
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Unmatched transactions"
        description="Valid lines on unposted statements that aren't matched to a recording or work, grouped by identifier and title, largest amounts first. Unmatched income is held as unallocated."
        breadcrumbs={[{ label: "Royalties" }, { label: "Statements", href: "/royalties/statements" }, { label: "Unmatched" }]}
      />
      <Card>
        <div className="overflow-x-auto">
          <DataTable
            columns={columns}
            data={groups.data?.items}
            getRowId={(g) => `${g.statement_id}-${g.sample_line_id}`}
            getRowLabel={label}
            isLoading={groups.isLoading}
            isFetching={groups.isFetching}
            error={groups.error}
            onRetry={() => void groups.refetch()}
            caption="Unmatched transactions"
            emptyState={
              <EmptyState
                icon={<CheckCircle2 aria-hidden />}
                title="Nothing unmatched"
                description="Every valid line on your unposted statements is matched or ignored."
                action={
                  <ButtonLink href="/royalties/statements" size="sm" variant="outline">
                    View statements
                  </ButtonLink>
                }
              />
            }
          />
        </div>
        {groups.data && groups.data.total > 0 ? (
          <div className="border-t border-border">
            <Pagination page={table.page} pageSize={table.pageSize} total={groups.data.total} onPageChange={table.setPage} onPageSizeChange={table.setPageSize} />
          </div>
        ) : null}
      </Card>
      <MatchDialog orgId={org.id} target={target} onClose={() => setTarget(null)} />
    </>
  );
}
