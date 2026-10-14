"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown, Inbox, MoreHorizontal } from "lucide-react";
import { Fragment, useMemo, type ReactNode } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type SortOrder = "asc" | "desc";

export interface SortState {
  key: string;
  order: SortOrder;
}

export interface DataTableColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Backend sort key. When set the header becomes a sort toggle. */
  sortKey?: string;
  align?: "left" | "right" | "center";
  className?: string;
  headerClassName?: string;
  /** Hide below the `md` breakpoint. */
  hideOnMobile?: boolean;
}

export interface RowAction {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Draw a separator before this item. */
  separated?: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[] | undefined;
  getRowId: (row: T) => string;
  /** Text naming a row for screen readers (row action menu and selection labels). */
  getRowLabel?: (row: T) => string;
  isLoading?: boolean;
  /** Background refetch with existing data. */
  isFetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  rowActions?: (row: T) => RowAction[];
  selectable?: boolean;
  selectedIds?: ReadonlySet<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  /** Rendered in a toolbar when at least one row is selected. */
  bulkActions?: (selected: T[], clear: () => void) => ReactNode;
  emptyState?: ReactNode;
  skeletonRows?: number;
  caption?: string;
  onRowClick?: (row: T) => void;
  /** Extra content under a row (e.g. expandable details). */
  renderExpanded?: (row: T) => ReactNode;
  rowClassName?: (row: T) => string | undefined;
  footer?: ReactNode;
  className?: string;
}

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

function nextSort(current: SortState | null | undefined, key: string): SortState | null {
  if (!current || current.key !== key) return { key, order: "asc" };
  if (current.order === "asc") return { key, order: "desc" };
  return null;
}

/**
 * Generic, accessible data table: sortable headers (controlled; wire to URL
 * query params with `useTableQueryState`), row actions, bulk selection,
 * skeleton rows, empty and error states.
 */
export function DataTable<T>({
  columns,
  data,
  getRowId,
  getRowLabel,
  isLoading,
  isFetching,
  error,
  onRetry,
  sort,
  onSortChange,
  rowActions,
  selectable,
  selectedIds,
  onSelectionChange,
  bulkActions,
  emptyState,
  skeletonRows = 5,
  caption,
  onRowClick,
  renderExpanded,
  rowClassName,
  footer,
  className,
}: DataTableProps<T>) {
  const rows = useMemo(() => data ?? [], [data]);
  const selected = selectedIds ?? new Set<string>();
  const pageIds = rows.map(getRowId);
  const selectedOnPage = pageIds.filter((id) => selected.has(id));
  const allSelected = pageIds.length > 0 && selectedOnPage.length === pageIds.length;
  const someSelected = selectedOnPage.length > 0 && !allSelected;
  const selectedRows = rows.filter((row) => selected.has(getRowId(row)));
  const columnCount = columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);

  const setSelection = (ids: Set<string>) => onSelectionChange?.(ids);
  const toggleAll = () => {
    const next = new Set(selected);
    if (allSelected) pageIds.forEach((id) => next.delete(id));
    else pageIds.forEach((id) => next.add(id));
    setSelection(next);
  };
  const toggleRow = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelection(next);
  };
  const clearSelection = () => setSelection(new Set());

  const showSkeleton = isLoading && rows.length === 0 && !error;
  const showError = Boolean(error) && rows.length === 0;
  const showEmpty = !isLoading && !error && rows.length === 0;

  return (
    <div className={cn("relative", className)}>
      {selectable && bulkActions && selectedRows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-primary-soft/60 px-5 py-2 text-[13px]" role="region" aria-label="Bulk actions">
          <span className="font-medium text-primary-soft-fg">{selectedRows.length} selected</span>
          <div className="flex flex-wrap items-center gap-2">{bulkActions(selectedRows, clearSelection)}</div>
          <button type="button" className="ml-auto text-[13px] text-fg-muted hover:text-fg" onClick={clearSelection}>
            Clear selection
          </button>
        </div>
      ) : null}
      <Table aria-busy={isLoading || isFetching || undefined} className={cn(isFetching && !isLoading && "opacity-70 transition-opacity")}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {selectable ? (
              <TableHead className="w-10 pr-0">
                <Checkbox
                  aria-label="Select all rows on this page"
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={toggleAll}
                  disabled={rows.length === 0}
                />
              </TableHead>
            ) : null}
            {columns.map((column) => {
              const active = column.sortKey && sort?.key === column.sortKey ? sort.order : null;
              return (
                <TableHead
                  key={column.id}
                  scope="col"
                  aria-sort={column.sortKey ? (active === "asc" ? "ascending" : active === "desc" ? "descending" : "none") : undefined}
                  className={cn(ALIGN[column.align ?? "left"], column.hideOnMobile && "hidden md:table-cell", column.headerClassName)}
                >
                  {column.sortKey && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => onSortChange(nextSort(sort, column.sortKey as string))}
                      className={cn(
                        "-mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-1 uppercase tracking-[0.06em] transition-colors hover:bg-surface-3 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring",
                        active && "text-fg",
                      )}
                    >
                      {column.header}
                      {active === "asc" ? (
                        <ArrowUp className="size-3" aria-hidden />
                      ) : active === "desc" ? (
                        <ArrowDown className="size-3" aria-hidden />
                      ) : (
                        <ChevronsUpDown className="size-3 opacity-50" aria-hidden />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              );
            })}
            {rowActions ? (
              <TableHead className="w-12 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {showSkeleton
            ? Array.from({ length: skeletonRows }, (_, index) => (
                <TableRow key={`skeleton-${index}`} className="hover:bg-transparent" data-testid="skeleton-row">
                  {Array.from({ length: columnCount }, (_, cell) => (
                    <TableCell key={cell}>
                      <Skeleton className={cn("h-4", cell === 0 ? "w-3/4" : "w-1/2")} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : null}
          {showError ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columnCount} className="p-0">
                <ErrorState error={error} onRetry={onRetry} compact />
              </TableCell>
            </TableRow>
          ) : null}
          {showEmpty ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columnCount} className="p-0">
                {emptyState ?? <EmptyState icon={<Inbox aria-hidden />} title="No results" description="Nothing to show here yet." compact />}
              </TableCell>
            </TableRow>
          ) : null}
          {rows.map((row) => {
            const id = getRowId(row);
            const isSelected = selected.has(id);
            const label = getRowLabel?.(row) ?? id;
            const actions = rowActions?.(row) ?? [];
            const expanded = renderExpanded?.(row);
            return (
              <Fragment key={id}>
                <TableRow
                  data-state={isSelected ? "selected" : undefined}
                  className={cn(onRowClick && "cursor-pointer", rowClassName?.(row))}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {selectable ? (
                    <TableCell className="w-10 pr-0" onClick={(event) => event.stopPropagation()}>
                      <Checkbox aria-label={`Select ${label}`} checked={isSelected} onCheckedChange={() => toggleRow(id)} />
                    </TableCell>
                  ) : null}
                  {columns.map((column) => (
                    <TableCell
                      key={column.id}
                      className={cn(ALIGN[column.align ?? "left"], column.hideOnMobile && "hidden md:table-cell", column.className)}
                    >
                      {column.cell(row)}
                    </TableCell>
                  ))}
                  {rowActions ? (
                    <TableCell className="w-12 text-right" onClick={(event) => event.stopPropagation()}>
                      {actions.length > 0 ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <IconButton label={`Actions for ${label}`} icon={<MoreHorizontal aria-hidden />} size="sm" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent>
                            {actions.map((action) => (
                              <Fragment key={action.label}>
                                {action.separated ? <DropdownMenuSeparator /> : null}
                                <DropdownMenuItem
                                  icon={action.icon}
                                  destructive={action.destructive}
                                  disabled={action.disabled}
                                  onSelect={action.onSelect}
                                >
                                  {action.label}
                                </DropdownMenuItem>
                              </Fragment>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </TableCell>
                  ) : null}
                </TableRow>
                {expanded ? (
                  <TableRow className="bg-surface-2/40 hover:bg-surface-2/40">
                    <TableCell colSpan={columnCount} className="py-3">
                      {expanded}
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
      {footer ? <div className="border-t border-border">{footer}</div> : null}
    </div>
  );
}
