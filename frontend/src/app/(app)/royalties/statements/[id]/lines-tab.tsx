"use client";

import { Ban, CheckCircle2, Link2, ListChecks, Undo2 } from "lucide-react";
import { useState } from "react";

import { matchMethodLabel, matchStatus } from "@/components/royalties/labels";
import { MatchDialog, type MatchTarget } from "@/components/royalties/match-dialog";
import { formatDecimal } from "@/components/royalties/money";
import { MatchStatusBadge, Money, formatIsoDate } from "@/components/royalties/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn, type RowAction } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { useBulkMatch, useMatchLine, useStatementLines, type Statement, type StatementLine } from "@/lib/api/hooks/royalties";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";

const FILTERS = ["match", "validity", "q"] as const;

export function LinesTab({ orgId, statement, mode, canManage }: { orgId: string; statement: Statement; mode: "all" | "unmatched"; canManage: boolean }) {
  const table = useTableQueryState<(typeof FILTERS)[number]>({ defaultPageSize: 50, filterKeys: FILTERS });
  const { filters } = table;
  const unmatchedOnly = mode === "unmatched";
  const lines = useStatementLines(orgId, statement.id, {
    page: table.page,
    page_size: table.pageSize,
    sort: table.sort?.key,
    order: table.sort?.order,
    match_status: unmatchedOnly ? "unmatched" : filters.match || undefined,
    valid: unmatchedOnly ? true : filters.validity === "valid" ? true : filters.validity === "invalid" ? false : undefined,
    q: filters.q || undefined,
  });
  const matchLine = useMatchLine(orgId, statement.id);
  const bulk = useBulkMatch(orgId, statement.id);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<MatchTarget | null>(null);
  const editable = canManage && !["posted", "queued", "processing"].includes(statement.status);
  const currencyOf = (line: StatementLine) => line.currency ?? statement.currency;

  const keyLine = (line: StatementLine) => ({ id: line.id, isrc: line.isrc, title: line.title, artist: line.artist });
  const lineLabel = (line: StatementLine) => `Row ${line.row_number}: ${line.title ?? line.isrc ?? "Untitled"}${line.artist ? ` — ${line.artist}` : ""}`;

  const setStatus = (line: StatementLine, action: "ignore" | "unmatch") =>
    matchLine.mutate(
      { lineId: line.id, action },
      {
        onSuccess: () => toast.success(action === "ignore" ? "Line ignored" : "Match removed", { description: "Recalculate to update royalties." }),
        onError: (error) => toast.error("Could not update the line", { description: errorMessage(error) }),
      },
    );

  const bulkStatus = (rows: StatementLine[], action: "ignore" | "unmatch", clear: () => void) =>
    bulk.mutate(
      { action, line_ids: rows.map((r) => r.id) },
      {
        onSuccess: (result) => {
          toast.success(`${result.updated} line${result.updated === 1 ? "" : "s"} ${action === "ignore" ? "ignored" : "unmatched"}`);
          clear();
        },
        onError: (error) => toast.error("Bulk update failed", { description: errorMessage(error) }),
      },
    );

  const columns: DataTableColumn<StatementLine>[] = [
    { id: "row", header: "Row", sortKey: "row_number", cell: (l) => <span className="tabular-nums text-fg-muted">{l.row_number}</span>, className: "w-14" },
    {
      id: "title",
      header: "Title · artist",
      sortKey: "title",
      cell: (l) => (
        <div className="min-w-0 max-w-[16rem]">
          <p className="truncate font-medium text-fg">{l.title ?? <span className="text-fg-subtle">No title</span>}</p>
          <p className="truncate text-xs text-fg-subtle">{l.artist ?? "—"}</p>
        </div>
      ),
    },
    {
      id: "ids",
      header: "Identifiers",
      cell: (l) => (
        <div className="space-y-0.5 font-mono text-xs">
          {l.isrc ? <p>ISRC {l.isrc}</p> : null}
          {l.iswc ? <p>ISWC {l.iswc}</p> : null}
          {l.upc ? <p>UPC {l.upc}</p> : null}
          {!l.isrc && !l.iswc && !l.upc ? <span className="font-sans text-fg-subtle">—</span> : null}
        </div>
      ),
    },
    {
      id: "usage",
      header: "Usage",
      hideOnMobile: true,
      cell: (l) => (
        <div className="text-xs text-fg-muted">
          <p>{[l.territory, l.store].filter(Boolean).join(" · ") || "—"}</p>
          <p className="text-fg-subtle">
            {l.quantity ? `${formatDecimal(l.quantity, { maximumFractionDigits: 2 })} units` : null}
            {l.transaction_date ? ` · ${formatIsoDate(l.transaction_date)}` : null}
          </p>
        </div>
      ),
    },
    {
      id: "amount",
      header: "Amount",
      sortKey: "amount",
      align: "right",
      cell: (l) => <Money amount={l.amount} currency={currencyOf(l)} precision="exact" toneNegative className="font-medium" />,
    },
    {
      id: "match",
      header: "Match",
      cell: (l) =>
        l.is_valid ? (
          <div className="min-w-0 max-w-[14rem] space-y-0.5">
            <MatchStatusBadge status={l.match_status} />
            {l.match_status === "matched" ? (
              <p className="truncate text-xs text-fg-muted" title={l.matched_title ?? undefined}>
                {l.matched_title ?? "Catalog item"} · {matchMethodLabel(l.match_method)}
                {l.match_confidence ? ` · ${formatDecimal(l.match_confidence, { maximumFractionDigits: 2 })}` : ""}
              </p>
            ) : null}
          </div>
        ) : (
          <Badge tone="danger" dot>
            Invalid
          </Badge>
        ),
    },
    {
      id: "issues",
      header: "Issues",
      hideOnMobile: true,
      cell: (l) =>
        l.validation_errors && l.validation_errors.length > 0 ? (
          <ul className={`max-w-[16rem] space-y-0.5 text-xs ${l.is_valid ? "text-warning-soft-fg" : "text-danger"}`}>
            {l.validation_errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : (
          <span className="text-xs text-fg-subtle">—</span>
        ),
    },
  ];

  const actionsFor = (line: StatementLine): RowAction[] => {
    if (!editable || !line.is_valid) return [];
    const actions: RowAction[] = [{ label: line.match_status === "matched" ? "Change match…" : "Match…", icon: <Link2 aria-hidden />, onSelect: () => setTarget({ statementId: statement.id, keyLine: keyLine(line), label: lineLabel(line) }) }];
    if (line.match_status === "unmatched" && (line.isrc || line.title)) {
      actions.push({
        label: line.isrc ? "Match all with this ISRC…" : "Match all with this title…",
        icon: <ListChecks aria-hidden />,
        onSelect: () => setTarget({ statementId: statement.id, keyLine: keyLine(line), label: lineLabel(line), groupOnly: true }),
      });
    }
    if (line.match_status !== "ignored") actions.push({ label: "Ignore line", icon: <Ban aria-hidden />, onSelect: () => setStatus(line, "ignore"), separated: true });
    if (line.match_status !== "unmatched") actions.push({ label: line.match_status === "ignored" ? "Stop ignoring" : "Remove match", icon: <Undo2 aria-hidden />, onSelect: () => setStatus(line, "unmatch") });
    return actions;
  };

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3 md:flex-row md:items-center">
        <SearchInput value={filters.q} onChange={(v) => table.setFilter("q", v)} placeholder="Title, artist, ISRC or ISWC" aria-label="Search lines" />
        {unmatchedOnly ? (
          <p className="text-xs text-fg-muted md:ml-2">
            Valid lines without a catalog match. Their income is held as <span className="font-medium">unallocated</span> until matched.
          </p>
        ) : (
          <>
            <Select
              size="sm"
              className="md:w-44"
              aria-label="Filter by match status"
              value={filters.match || "all"}
              onValueChange={(v) => table.setFilter("match", v === "all" ? null : v)}
              options={[{ value: "all", label: "All match states" }, ...["matched", "unmatched", "ignored"].map((s) => ({ value: s, label: matchStatus(s).label }))]}
            />
            <Select
              size="sm"
              className="md:w-40"
              aria-label="Filter by validity"
              value={filters.validity || "all"}
              onValueChange={(v) => table.setFilter("validity", v === "all" ? null : v)}
              options={[
                { value: "all", label: "Valid & invalid" },
                { value: "valid", label: "Valid only" },
                { value: "invalid", label: "Invalid only" },
              ]}
            />
          </>
        )}
      </div>
      <div className="overflow-x-auto">
        <DataTable
          columns={columns}
          data={lines.data?.items}
          getRowId={(l) => l.id}
          getRowLabel={lineLabel}
          isLoading={lines.isLoading}
          isFetching={lines.isFetching}
          error={lines.error}
          onRetry={() => void lines.refetch()}
          sort={table.sort}
          onSortChange={table.setSort}
          rowActions={editable ? actionsFor : undefined}
          selectable={editable}
          selectedIds={selected}
          onSelectionChange={setSelected}
          rowClassName={(l) => (!l.is_valid ? "bg-danger-soft/20" : undefined)}
          bulkActions={(rows, clear) => {
            const valid = rows.filter((r) => r.is_valid);
            return (
              <>
                <Button size="xs" variant="outline" leftIcon={<Link2 aria-hidden />} disabled={valid.length === 0} onClick={() => setTarget({ statementId: statement.id, lineIds: valid.map((r) => r.id), label: `${valid.length} selected line${valid.length === 1 ? "" : "s"}` })}>
                  Match…
                </Button>
                <Button size="xs" variant="outline" leftIcon={<Ban aria-hidden />} disabled={valid.length === 0} loading={bulk.isPending} onClick={() => bulkStatus(valid, "ignore", clear)}>
                  Ignore
                </Button>
                <Button size="xs" variant="ghost" leftIcon={<Undo2 aria-hidden />} disabled={valid.length === 0} onClick={() => bulkStatus(valid, "unmatch", clear)}>
                  Reset to unmatched
                </Button>
              </>
            );
          }}
          caption={unmatchedOnly ? "Unmatched statement lines" : "Statement lines"}
          emptyState={
            unmatchedOnly && !filters.q ? (
              <EmptyState compact icon={<CheckCircle2 aria-hidden />} title="Every valid line is matched" description="Nothing is waiting for a catalog match on this statement." />
            ) : (
              <EmptyState compact icon={<ListChecks aria-hidden />} title="No lines match" description="Try a different search or filter." />
            )
          }
        />
      </div>
      {lines.data && lines.data.total > 0 ? (
        <div className="border-t border-border">
          <Pagination page={table.page} pageSize={table.pageSize} total={lines.data.total} onPageChange={table.setPage} onPageSizeChange={table.setPageSize} pageSizeOptions={[25, 50, 100, 200]} />
        </div>
      ) : null}
      <MatchDialog
        orgId={orgId}
        target={target}
        onClose={() => {
          setTarget(null);
          setSelected(new Set());
        }}
      />
    </Card>
  );
}
