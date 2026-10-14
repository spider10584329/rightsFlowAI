"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * A single query-string parameter (e.g. the active tab) kept in the URL.
 * Uses `useSearchParams`, so call it below a `<Suspense>` boundary.
 */
export function useUrlParam<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (value: T) => void] {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = searchParams.get(key);
  const value = raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;

  const setValue = useCallback(
    (next: T) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === fallback) params.delete(key);
      else params.set(key, next);
      // Tab-scoped paging and filters do not carry over between tabs.
      params.delete("page");
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [fallback, key, pathname, router, searchParams],
  );

  return [value, setValue];
}
