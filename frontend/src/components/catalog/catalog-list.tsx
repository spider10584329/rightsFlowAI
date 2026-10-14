"use client";

import { Archive, ArchiveRestore, Download, Eye, Pencil, Plus, SearchX, Trash2, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { BulkResultDialog, DeleteEntityDialog, useArchiveToggle, type EntityRef } from "@/components/catalog/entity-dialogs";
import { ENTITY_LABEL, entityHref } from "@/components/catalog/labels";
import { useOrg } from "@/components/session/org-provider";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn, type RowAction, type SortState } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import {
  downloadCatalogExport,
  useCatalogBulk,
  useCatalogList,
  type BulkAction,
  type CatalogBulkResult,
  type CatalogEntityType,
  type CatalogItem,
  type CatalogListParams,
} from "@/lib/api/hooks/catalog";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { pluralize } from "@/lib/utils";

export interface ListFilter {
  key: string;
  label: string;
  /** Label of the "no filter" option. */
  allLabel: string;
  options: { value: string; label: string }[];
}

export interface CatalogListConfig<E extends CatalogEntityType> {
  entity: E;
  description: string;
  searchPlaceholder: string;
  columns: DataTableColumn<CatalogItem<E>>[];
  filters: ListFilter[];
  defaultSort: SortState;
  /** Title used in menus, dialogs and bulk results. */
  titleOf: (item: CatalogItem<E>) => string;
  icon: ReactNode;
  /** Import is available for works, recordings and parties. */
  importable?: boolean;
}

const STATUS_FILTER: ListFilter = {
  key: "status",
  label: "Status",
  allLabel: "Active & draft",
  options: [
    { value: "active", label: "Active" },
    { value: "draft", label: "Draft" },
    { value: "archived", label: "Archived" },
    { value: "all", label: "All, including archived" },
  ],
};

const ALL = "__all";

export function CatalogList<E extends CatalogEntityType>({ config }: { config: CatalogListConfig<E> }) {
  const { entity } = config;
  const { org, can } = useOrg();
  const router = useRouter();
  const canEdit = can("manager");
  const canDelete = can("admin");
  const label = ENTITY_LABEL[entity];
  const noun = entity === "party" ? "party" : label.singular.toLowerCase();
  const filters = useMemo(() => [STATUS_FILTER, ...config.filters], [config.filters]);
  const filterKeys = useMemo(() => ["q", ...filters.map((filter) => filter.key)], [filters]);
  const table = useTableQueryState<string>({ defaultSort: config.defaultSort, filterKeys });

  const params: CatalogListParams = useMemo(() => {
    const query: CatalogListParams = {
      page: table.page,
      page_size: table.pageSize,
      sort: table.sort?.key,
      order: table.sort?.order,
    };
    for (const [key, value] of Object.entries(table.filters)) {
      if (!value) continue;
      if (key === "status" && value === "all") query.include_archived = true;
      else query[key] = value;
    }
    return query;
  }, [table.page, table.pageSize, table.sort, table.filters]);

  const list = useCatalogList(org.id, entity, params);
  const bulk = useCatalogBulk(org.id);
  const archiveToggle = useArchiveToggle(org.id, entity);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [signature, setSignature] = useState("");
  const [deleting, setDeleting] = useState<EntityRef | null>(null);
  const [bulkDelete, setBulkDelete] = useState<CatalogItem<E>[] | null>(null);
  const [bulkResult, setBulkResult] = useState<{ result: CatalogBulkResult; titles: Record<string, string> } | null>(null);
  const [exporting, setExporting] = useState(false);

  // Selection only applies to the rows in view: reset it when the query changes.
  const currentSignature = JSON.stringify(params);
  if (currentSignature !== signature) {
    setSignature(currentSignature);
    if (selected.size > 0) setSelected(new Set());
  }

  const activeFilterCount = Object.values(table.filters).filter(Boolean).length;
  const statusFilter = table.filters.status ?? "";
  const items = list.data?.items;

  const runBulk = async (action: BulkAction, rows: CatalogItem<E>[], clear: () => void) => {
    const titles = Object.fromEntries(rows.map((row) => [row.id, config.titleOf(row)]));
    try {
      const result = await bulk.mutateAsync({ entity_type: entity, action, ids: rows.map((row) => row.id) });
      clear();
      const verb = action === "archive" ? "Archived" : action === "restore" ? "Restored" : "Deleted";
      if (result.affected > 0) toast.success(`${verb} ${pluralize(result.affected, noun, entity === "party" ? "parties" : undefined)}`);
      if (result.skipped.length > 0) setBulkResult({ result, titles });
      else if (result.affected === 0) toast.info("Nothing changed");
    } catch (error) {
      toast.error(`Bulk ${action} failed`, { description: errorMessage(error) });
      throw error;
    }
  };

  const rowActions = (row: CatalogItem<E>): RowAction[] => {
    const ref: EntityRef = { id: row.id, title: config.titleOf(row), status: row.status };
    const actions: RowAction[] = [{ label: "View details", icon: <Eye aria-hidden />, onSelect: () => router.push(entityHref(entity, row.id)) }];
    if (canEdit) {
      actions.push({ label: "Edit", icon: <Pencil aria-hidden />, onSelect: () => router.push(entityHref(entity, row.id, "edit")) });
      actions.push(
        row.status === "archived"
          ? { label: "Restore", icon: <ArchiveRestore aria-hidden />, onSelect: () => void archiveToggle.run(ref, "restore").catch(() => undefined) }
          : { label: "Archive", icon: <Archive aria-hidden />, onSelect: () => void archiveToggle.run(ref, "archive").catch(() => undefined) },
      );
    }
    if (canDelete) actions.push({ label: "Delete", icon: <Trash2 aria-hidden />, destructive: true, separated: true, onSelect: () => setDeleting(ref) });
    return actions;
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCatalogExport(org.id, entity, statusFilter === "archived" || statusFilter === "all");
      toast.success(`${label.plural} exported`);
    } catch (error) {
      toast.error("Export failed", { description: errorMessage(error) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <PageHeader
        title={label.plural}
        description={config.description}
        breadcrumbs={[{ label: "Catalog", href: "/catalog" }, { label: label.plural }]}
        actions={
          <>
            <Button variant="outline" leftIcon={<Download aria-hidden />} onClick={() => void exportCsv()} loading={exporting}>
              Export CSV
            </Button>
            {canEdit && config.importable ? (
              <ButtonLink href={`/catalog/import?entity_type=${entity}`} variant="outline" leftIcon={<Upload aria-hidden />}>
                Import
              </ButtonLink>
            ) : null}
            {canEdit ? (
              <ButtonLink href={`${entityHref(entity)}/new`} leftIcon={<Plus aria-hidden />}>
                New {noun}
              </ButtonLink>
            ) : null}
          </>
        }
      />
      <Card>
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 lg:flex-row lg:flex-wrap lg:items-center">
          <SearchInput
            value={table.filters.q ?? ""}
            onChange={(value) => table.setFilter("q", value.trim() || null)}
            placeholder={config.searchPlaceholder}
            aria-label={`Search ${label.plural.toLowerCase()}`}
            className="lg:w-80"
          />
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            {filters.map((filter) => (
              <Select
                key={filter.key}
                size="sm"
                className="sm:w-48"
                aria-label={filter.label}
                value={table.filters[filter.key] || ALL}
                onValueChange={(value) => table.setFilter(filter.key, value === ALL ? null : value)}
                options={[{ value: ALL, label: filter.allLabel }, ...filter.options]}
              />
            ))}
          </div>
          {activeFilterCount > 0 ? (
            <Button variant="ghost" size="sm" className="lg:ml-auto" onClick={table.reset}>
              Clear filters
            </Button>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <DataTable
            columns={config.columns}
            data={items}
            getRowId={(row) => row.id}
            getRowLabel={config.titleOf}
            isLoading={list.isLoading}
            isFetching={list.isFetching}
            error={list.error}
            onRetry={() => void list.refetch()}
            sort={table.sort}
            onSortChange={table.setSort}
            rowActions={rowActions}
            onRowClick={(row) => router.push(entityHref(entity, row.id))}
            selectable={canEdit}
            selectedIds={selected}
            onSelectionChange={setSelected}
            caption={label.plural}
            bulkActions={(rows, clear) => (
              <>
                {rows.some((row) => row.status !== "archived") ? (
                  <Button size="xs" variant="outline" leftIcon={<Archive aria-hidden />} disabled={bulk.isPending} onClick={() => void runBulk("archive", rows, clear).catch(() => undefined)}>
                    Archive
                  </Button>
                ) : null}
                {rows.some((row) => row.status === "archived") ? (
                  <Button size="xs" variant="outline" leftIcon={<ArchiveRestore aria-hidden />} disabled={bulk.isPending} onClick={() => void runBulk("restore", rows, clear).catch(() => undefined)}>
                    Restore
                  </Button>
                ) : null}
                {canDelete ? (
                  <Button size="xs" variant="danger" leftIcon={<Trash2 aria-hidden />} disabled={bulk.isPending} onClick={() => setBulkDelete(rows)}>
                    Delete
                  </Button>
                ) : null}
              </>
            )}
            emptyState={
              activeFilterCount > 0 ? (
                <EmptyState
                  compact
                  icon={<SearchX aria-hidden />}
                  title={`No ${label.plural.toLowerCase()} match`}
                  description="Try a different search or clear the filters."
                  action={
                    <Button size="sm" variant="outline" onClick={table.reset}>
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={config.icon}
                  title={`No ${label.plural.toLowerCase()} yet`}
                  description={canEdit ? `Create your first ${noun} or import a spreadsheet.` : "Nothing has been added to the catalog yet."}
                  action={
                    canEdit ? (
                      <>
                        <ButtonLink size="sm" href={`${entityHref(entity)}/new`} leftIcon={<Plus aria-hidden />}>
                          New {noun}
                        </ButtonLink>
                        {config.importable ? (
                          <ButtonLink size="sm" variant="outline" href={`/catalog/import?entity_type=${entity}`} leftIcon={<Upload aria-hidden />}>
                            Import CSV/XLSX
                          </ButtonLink>
                        ) : null}
                      </>
                    ) : null
                  }
                />
              )
            }
            footer={
              list.data && list.data.total > 0 ? (
                <Pagination
                  page={table.page}
                  pageSize={table.pageSize}
                  total={list.data.total}
                  onPageChange={table.setPage}
                  onPageSizeChange={table.setPageSize}
                  disabled={list.isFetching}
                />
              ) : null
            }
          />
        </div>
      </Card>

      <DeleteEntityDialog orgId={org.id} entity={entity} item={deleting} onClose={() => setDeleting(null)} canArchive={canEdit} />
      <ConfirmDialog
        open={bulkDelete !== null}
        onOpenChange={(open) => !open && setBulkDelete(null)}
        title={`Delete ${bulkDelete ? pluralize(bulkDelete.length, noun, entity === "party" ? "parties" : undefined) : ""}?`}
        description="Items still referenced by other records (rights, contracts, statements, releases) are skipped; you'll see why. This can't be undone."
        confirmLabel="Delete permanently"
        confirmText={bulkDelete && bulkDelete.length > 1 ? "DELETE" : undefined}
        onConfirm={async () => {
          if (!bulkDelete) return;
          await runBulk("delete", bulkDelete, () => setSelected(new Set()));
        }}
      />
      <BulkResultDialog result={bulkResult?.result ?? null} titles={bulkResult?.titles ?? {}} onClose={() => setBulkResult(null)} />
    </>
  );
}
