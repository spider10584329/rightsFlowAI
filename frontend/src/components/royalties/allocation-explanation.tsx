import { Info } from "lucide-react";
import Link from "next/link";

import { reasonInfo } from "@/components/royalties/labels";
import { formatMoney, formatPercent } from "@/components/royalties/money";
import { shortId } from "@/components/royalties/shared";
import type { Allocation } from "@/lib/api/hooks/royalties";
import { titleCase } from "@/lib/utils";

type Explanation = Record<string, unknown>;

export interface ExplanationItem {
  label: string;
  value: string;
  hint?: string;
}

const BASIS_LABELS: Record<string, string> = {
  controlled_pro_rata: "Controlled pro-rata",
  gross_share: "Gross share",
};

const KNOWN_KEYS = new Set([
  "message",
  "party",
  "share_percent",
  "basis",
  "portion",
  "controlled_total_percent",
  "gross_basis_amount",
  "rate_percent",
  "contract_term_id",
  "rate_source",
  "payable",
  "details",
]);

function str(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

export function basisLabel(basis: string | null | undefined): string {
  if (!basis) return "—";
  return BASIS_LABELS[basis] ?? titleCase(basis);
}

/**
 * Turns the engine's explanation JSON into labelled, human-readable facts.
 * Money values are formatted from their exact strings.
 */
export function explanationItems(allocation: Pick<Allocation, "explanation" | "currency" | "share_percent" | "rate_percent" | "base_amount" | "party_name" | "contract_term_id">): ExplanationItem[] {
  const explanation: Explanation = allocation.explanation ?? {};
  const currency = allocation.currency;
  const items: ExplanationItem[] = [];
  const party = str(explanation.party) ?? allocation.party_name ?? null;
  if (party) items.push({ label: "Party", value: party });

  const share = str(explanation.share_percent) ?? allocation.share_percent ?? null;
  if (share) {
    const controlled = str(explanation.controlled_total_percent);
    items.push({
      label: "Ownership share",
      value: formatPercent(share),
      hint: controlled ? `of ${formatPercent(controlled)} controlled by your organization` : undefined,
    });
  }
  const basis = str(explanation.basis);
  if (basis) {
    items.push({
      label: "Split basis",
      value: basisLabel(basis),
      hint:
        basis === "controlled_pro_rata"
          ? "Statement income is divided among the shares you control, in proportion to their percentages."
          : basis === "gross_share"
            ? "Statement income is 100% of the asset; each share receives amount × share %."
            : undefined,
    });
  }
  const portion = str(explanation.portion) ?? (share ? allocation.base_amount : null);
  if (portion) items.push({ label: "Portion of line", value: formatMoney(portion, currency, { precision: "exact" }) });

  const gross = str(explanation.gross_basis_amount);
  if (gross) items.push({ label: "Gross basis amount", value: formatMoney(gross, currency, { precision: "exact" }), hint: "The contract rate applies to the gross amount pro-rata." });

  const rate = str(explanation.rate_percent) ?? allocation.rate_percent ?? null;
  const rateSource = str(explanation.rate_source);
  if (rate) {
    items.push({
      label: "Royalty rate",
      value: formatPercent(rate),
      hint:
        rateSource === "contract_term"
          ? "Set by a contract royalty term"
          : rateSource === "no_contract_term_full_share"
            ? "No contract term applies, so the full portion is payable"
            : undefined,
    });
  }
  const termId = str(explanation.contract_term_id) ?? allocation.contract_term_id ?? null;
  if (termId) items.push({ label: "Contract term", value: shortId(termId) });

  const payable = str(explanation.payable);
  if (payable) items.push({ label: "Payable from portion", value: formatMoney(payable, currency, { precision: "exact" }) });

  for (const [key, value] of Object.entries(explanation)) {
    if (KNOWN_KEYS.has(key)) continue;
    const text = str(value);
    if (text) items.push({ label: titleCase(key), value: text });
  }
  const details = explanation.details;
  if (details && typeof details === "object") {
    for (const [key, value] of Object.entries(details as Explanation)) {
      const text = str(value);
      if (text) items.push({ label: titleCase(key), value: text });
    }
  }
  return items;
}

/** One-sentence plain-language summary of why this allocation exists. */
export function explainAllocation(allocation: Pick<Allocation, "allocation_type" | "explanation" | "currency" | "amount" | "reason" | "party_name" | "share_percent" | "rate_percent">): string {
  const explanation: Explanation = allocation.explanation ?? {};
  const currency = allocation.currency;
  const party = str(explanation.party) ?? allocation.party_name ?? "This party";
  const share = str(explanation.share_percent) ?? allocation.share_percent;
  const portion = str(explanation.portion);
  const rate = str(explanation.rate_percent) ?? allocation.rate_percent;
  const amount = formatMoney(allocation.amount, currency, { precision: "exact" });
  const message = str(explanation.message);

  if (allocation.allocation_type === "unallocated") {
    return message ?? `${amount} is held: ${reasonInfo(allocation.reason).explanation || "it needs review."}`;
  }
  const sharePart = share ? `${party} holds ${formatPercent(share)}` : party;
  const portionPart = portion ? `, so their portion of the line is ${formatMoney(portion, currency, { precision: "exact" })}` : "";
  if (allocation.allocation_type === "payable") {
    const ratePart =
      str(explanation.rate_source) === "contract_term" && rate
        ? ` A contract term sets a ${formatPercent(rate)} royalty rate, so ${amount} is payable.`
        : ` No contract term applies, so the full ${amount} is payable.`;
    return `${sharePart}${portionPart}.${ratePart}`;
  }
  // retained
  if (allocation.reason === "internal_party") return `${sharePart}${portionPart}. It is an internal party, so ${amount} is retained.`;
  if (allocation.reason === "contract_retention" && rate) {
    return `${sharePart}${portionPart}. The contract pays ${formatPercent(rate)}; the remaining ${amount} is retained by your organization.`;
  }
  return message ?? `${amount} is retained by your organization.`;
}

export function AllocationExplanation({ allocation, statementId }: { allocation: Allocation; statementId?: string }) {
  const items = explanationItems(allocation);
  const reason = allocation.reason ? reasonInfo(allocation.reason) : null;
  return (
    <div className="space-y-3 text-[13px]">
      <p className="flex items-start gap-2 leading-relaxed text-fg">
        <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden />
        <span>{explainAllocation(allocation)}</span>
      </p>
      {items.length > 0 ? (
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <div key={item.label} className="min-w-0">
              <dt className="text-xs text-fg-subtle">{item.label}</dt>
              <dd className="break-words font-medium tabular-nums text-fg">{item.value}</dd>
              {item.hint ? <dd className="text-xs text-fg-muted">{item.hint}</dd> : null}
            </div>
          ))}
        </dl>
      ) : null}
      {reason && reason.action ? (
        <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning-soft-fg">
          <span className="font-semibold">What to do: </span>
          {reason.action}
        </p>
      ) : null}
      <p className="text-xs text-fg-subtle">
        Line <span className="font-mono">{shortId(allocation.line_id)}</span>
        {allocation.territory ? <> · Territory {allocation.territory}</> : null}
        {allocation.rights_type ? <> · {titleCase(allocation.rights_type)} rights</> : null}
        {statementId ? (
          <>
            {" "}
            ·{" "}
            <Link className="text-primary hover:underline" href={`/royalties/statements/${statementId}?tab=lines`}>
              View statement lines
            </Link>
          </>
        ) : null}
      </p>
    </div>
  );
}
