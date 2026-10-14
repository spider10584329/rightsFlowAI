import { Money } from "@/components/royalties/shared";
import { decimalSign } from "@/components/royalties/money";
import type { BalanceRow } from "@/lib/api/hooks/payouts";

/** Compact per-currency balance list for tables. */
export function BalanceSummary({ balances }: { balances: BalanceRow[] | undefined }) {
  if (!balances || balances.length === 0) return <span className="text-xs text-fg-subtle">No ledger activity</span>;
  return (
    <ul className="space-y-1">
      {balances.map((row) => (
        <li key={row.currency} className="text-xs">
          <p className="flex items-baseline justify-end gap-2">
            <span className="text-fg-subtle">{row.currency}</span>
            <Money amount={row.balance} currency={row.currency} precision="exact" toneNegative className="text-[13px] font-semibold" />
          </p>
          <p className="text-right text-fg-subtle">
            Available <Money amount={row.available} currency={row.currency} precision="exact" />
            {decimalSign(row.pending_payouts) !== 0 ? (
              <>
                {" "}
                · pending <Money amount={row.pending_payouts} currency={row.currency} />
              </>
            ) : null}
            {decimalSign(row.unrecouped_advances) !== 0 ? (
              <>
                {" "}
                · unrecouped <Money amount={row.unrecouped_advances} currency={row.currency} />
              </>
            ) : null}
          </p>
        </li>
      ))}
    </ul>
  );
}
