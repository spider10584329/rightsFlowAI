"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api/client";
import type { ReferenceItem } from "@/lib/api/types";

/** Common ISO 4217 codes used when the reference endpoint is unreachable. */
export const FALLBACK_CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "SEK", "NOK", "DKK", "CHF", "BRL", "MXN"];

/** Static reference data rarely changes; cache it for the whole session. */
export function useReferenceList(kind: "currencies" | "territories") {
  return useQuery({
    queryKey: ["reference", kind],
    queryFn: ({ signal }) => api.get<ReferenceItem[]>(`/reference/${kind}`, { signal }),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
}

export function useCurrencyCodes(): string[] {
  const { data } = useReferenceList("currencies");
  return data && data.length > 0 ? data.map((item) => item.code) : FALLBACK_CURRENCIES;
}
