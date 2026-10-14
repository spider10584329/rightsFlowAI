"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

import type { SortState } from "@/components/ui/data-table";

export interface TableQueryOptions<F extends string> {
  defaultPageSize?: number;
  defaultSort?: SortState | null;
  /** Filter keys mirrored in the URL (e.g. `status`, `q`). */
  filterKeys?: readonly F[];
  maxPageSize?: number;
}

function positiveInt(value: string | null, fallback: number, max = 100_000): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, max) : fallback;
}

/**
 * Table state (page, page size, sort, filters) stored in the URL query
 * string so views are shareable and survive reloads. Uses
 * `useSearchParams`, so the calling component must be inside `<Suspense>`.
 *
 * Changing sort, page size or filters resets to page 1.
 */
export function useTableQueryState<F extends string = never>(options: TableQueryOptions<F> = {}) {
  const { defaultPageSize = 25, defaultSort = null, filterKeys = [] as readonly F[], maxPageSize = 200 } = options;
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const page = positiveInt(searchParams.get("page"), 1);
  const pageSize = positiveInt(searchParams.get("page_size"), defaultPageSize, maxPageSize);

  const sortKey = searchParams.get("sort");
  const orderParam = searchParams.get("order");
  const sort: SortState | null = useMemo(() => {
    if (sortKey === "") return null;
    if (sortKey) return { key: sortKey, order: orderParam === "desc" ? "desc" : "asc" };
    return defaultSort;
  }, [sortKey, orderParam, defaultSort]);

  // A stable string key so `filters` keeps its identity while the URL is unchanged.
  const filterSignature = JSON.stringify(filterKeys.map((key) => [key, searchParams.get(key) ?? ""]));
  const filters = useMemo(() => {
    const pairs = JSON.parse(filterSignature) as [F, string][];
    return Object.fromEntries(pairs) as Record<F, string>;
  }, [filterSignature]);

  const update = useCallback(
    (changes: Record<string, string | number | null | undefined>, resetPage: boolean) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === undefined) params.delete(key);
        else params.set(key, String(value));
      }
      if (resetPage) params.delete("page");
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  return {
    page,
    pageSize,
    sort,
    filters,
    setPage: (next: number) => update({ page: next <= 1 ? null : next }, false),
    setPageSize: (next: number) => update({ page_size: next === defaultPageSize ? null : next }, true),
    setSort: (next: SortState | null) =>
      update(next ? { sort: next.key, order: next.order } : { sort: defaultSort ? "" : null, order: null }, true),
    setFilter: (key: F, value: string | null) => update({ [key]: value || null }, true),
    reset: () => router.replace(pathname, { scroll: false }),
  };
}
