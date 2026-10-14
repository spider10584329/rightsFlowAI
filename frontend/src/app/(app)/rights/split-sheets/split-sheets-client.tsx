"use client";

import { FileStack, Pencil, Plus, Split, Trash2, Wand2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { formatPercent, roleLabel } from "@/components/rights/rights-format";
import { useOrg } from "@/components/session/org-provider";
import { Badge, statusTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn, type RowAction } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toaster";
import { useDeleteSplitSheet, useSplitSheets, type SplitSheet } from "@/lib/api/hooks/rights";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { formatDate, titleCase } from "@/lib/utils";

import { ApplySheetDialog, SHEET_STATUSES, SplitSheetFormDialog } from "./split-sheet-dialogs";

type DialogState = { kind: "create" } | { kind: "edit"; sheet: SplitSheet } | { kind: "apply"; sheet: SplitSheet } | { kind: "delete"; sheet: SplitSheet } | null;

function sheetTone(status: string) {
  if (status === "signed") return "info" as const;
  if (status === "disputed") return "danger" as const;
  return statusTone(status);
}

export function SplitSheetsClient() {
  const { org, can } = useOrg();
  const canEdit = can("manager");
  const table = useTableQueryState({ filterKeys: ["status", "work_id"] as const, defaultSort: { key: "created_at", order: "desc" } });
  const sheets = useSplitSheets(org.id, {
    page: table.page,
    page_size: table.pageSize,
    sort: table.sort?.key,
    order: table.sort?.order,
    status: table.filters.status || undefined,
    work_id: table.filters.work_id || undefined,
  });
  const remove = useDeleteSplitSheet(org.id);
  const [dialog, setDialog] = useState<DialogState>(null);

  const columns: DataTableColumn<SplitSheet>[] = [
    {
      id: "title",
      header: "Split sheet",
      sortKey: "title",
      cell: (sheet) => (
        <div className="min-w-0">
          <p className="font-medium">{sheet.title}</p>
          <Link href={`/catalog/works/${sheet.work_id}`} className="text-xs text-fg-subtle hover:text-primary hover:underline" onClick={(event) => event.stopPropagation()}>
            {sheet.work_title ?? "Work"}
          </Link>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (sheet) => (
        <Badge tone={sheetTone(sheet.status)} dot>
          {titleCase(sheet.status)}
        </Badge>
      ),
    },
    {
      id: "entries",
      header: "Entries",
      hideOnMobile: true,
      cell: (sheet) => (
        <ul className="space-y-0.5 text-xs text-fg-muted">
          {sheet.entries.slice(0, 3).map((entry) => (
            <li key={`${entry.party_id}-${entry.role}`}>
              {entry.party_name ?? "Party"} · {roleLabel(entry.role)} · <span className="tabular-nums">{formatPercent(entry.share_percent)}</span>
            </li>
          ))}
          {sheet.entries.length > 3 ? <li>+{sheet.entries.length - 3} more</li> : null}
        </ul>
      ),
    },
    {
      id: "total",
      header: "Total",
      align: "right",
      cell: (sheet) => {
        const full = Number(sheet.entries_total) === 100;
        return (
          <span className="inline-flex flex-col items-end">
            <span className="font-medium tabular-nums">{formatPercent(sheet.entries_total)}</span>
            {!full ? <span className="text-2xs text-warning-soft-fg">Under 100%</span> : null}
          </span>
        );
      },
    },
    { id: "agreed", header: "Agreed", sortKey: "agreed_date", hideOnMobile: true, cell: (sheet) => formatDate(sheet.agreed_date) },
  ];

  const actions = (sheet: SplitSheet): RowAction[] =>
    canEdit
      ? [
          { label: "Apply to shares", icon: <Wand2 aria-hidden />, onSelect: () => setDialog({ kind: "apply", sheet }), disabled: sheet.status === "disputed" },
          { label: "Edit", icon: <Pencil aria-hidden />, onSelect: () => setDialog({ kind: "edit", sheet }) },
          { label: "Delete", icon: <Trash2 aria-hidden />, destructive: true, separated: true, onSelect: () => setDialog({ kind: "delete", sheet }) },
        ]
      : [];

  return (
    <>
      <PageHeader
        title="Split sheets"
        description="Agreed writer and publisher percentages per work. Apply a sheet to turn its entries into ownership shares for chosen rights types and territories."
        breadcrumbs={[{ label: "Rights", href: "/rights" }, { label: "Split sheets" }]}
        actions={
          canEdit ? (
            <Button leftIcon={<Plus aria-hidden />} onClick={() => setDialog({ kind: "create" })}>
              New split sheet
            </Button>
          ) : null
        }
      />
      <Card>
        <div className="flex flex-col gap-2 border-b border-border px-5 py-3 sm:flex-row sm:items-center">
          <Select
            size="sm"
            className="sm:w-44"
            aria-label="Filter by status"
            value={table.filters.status || "all"}
            onValueChange={(value) => table.setFilter("status", value === "all" ? null : value)}
            options={[{ value: "all", label: "All statuses" }, ...SHEET_STATUSES.map((value) => ({ value, label: titleCase(value) }))]}
          />
          {table.filters.work_id ? (
            <Button size="sm" variant="ghost" onClick={() => table.setFilter("work_id", null)}>
              Clear work filter
            </Button>
          ) : null}
          <p className="text-xs text-fg-subtle sm:ml-auto">Disputed sheets cannot be applied.</p>
        </div>
        <div className="overflow-x-auto">
          <DataTable
            columns={columns}
            data={sheets.data?.items}
            getRowId={(sheet) => sheet.id}
            getRowLabel={(sheet) => sheet.title}
            isLoading={sheets.isLoading}
            isFetching={sheets.isFetching}
            error={sheets.error}
            onRetry={() => void sheets.refetch()}
            sort={table.sort}
            onSortChange={table.setSort}
            rowActions={canEdit ? actions : undefined}
            onRowClick={canEdit ? (sheet) => setDialog({ kind: "edit", sheet }) : undefined}
            caption="Split sheets"
            emptyState={
              <EmptyState
                compact
                icon={<FileStack aria-hidden />}
                title="No split sheets yet"
                description="Record the percentages agreed in a writing session, then apply them to create shares."
                action={
                  canEdit ? (
                    <Button size="sm" variant="outline" leftIcon={<Split aria-hidden />} onClick={() => setDialog({ kind: "create" })}>
                      New split sheet
                    </Button>
                  ) : null
                }
              />
            }
            footer={
              sheets.data && sheets.data.total > 0 ? (
                <Pagination page={table.page} pageSize={table.pageSize} total={sheets.data.total} onPageChange={table.setPage} onPageSizeChange={table.setPageSize} />
              ) : null
            }
          />
        </div>
      </Card>

      {dialog?.kind === "create" ? <SplitSheetFormDialog orgId={org.id} sheet={null} open onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "edit" ? <SplitSheetFormDialog key={dialog.sheet.id} orgId={org.id} sheet={dialog.sheet} open onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "apply" ? <ApplySheetDialog orgId={org.id} sheet={dialog.sheet} onClose={() => setDialog(null)} /> : null}
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Delete split sheet?"
        description={dialog?.kind === "delete" ? `“${dialog.sheet.title}” will be deleted. Shares already created from it are kept.` : undefined}
        confirmLabel="Delete"
        onConfirm={async () => {
          if (dialog?.kind !== "delete") return;
          await remove.mutateAsync(dialog.sheet.id);
          toast.success("Split sheet deleted");
        }}
      />
    </>
  );
}
