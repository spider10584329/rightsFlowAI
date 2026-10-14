"use client";

import { Landmark } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { usePaymentProvider } from "@/lib/api/hooks/payouts";
import { titleCase } from "@/lib/utils";

/** Explains that RightsFlow records payments but never moves money. */
export function ProviderNotice({ orgId, className }: { orgId: string; className?: string }) {
  const provider = usePaymentProvider(orgId);
  const data = provider.data;
  return (
    <Alert tone="info" className={className} title={data ? `Payment provider: ${data.provider === "internal" ? "Internal ledger" : titleCase(data.provider)}` : "Payments are recorded, not sent"}>
      <span className="flex items-start gap-1.5">
        <Landmark className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          {data?.message ?? "Payments are executed outside RightsFlow and then recorded here."}{" "}
          {data && !data.moves_money ? "RightsFlow never transfers money. Ledger balances are accounting figures, not confirmed bank payments." : null}
        </span>
      </span>
    </Alert>
  );
}
