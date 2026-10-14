"use client";

import { AlertTriangle, CheckCircle2, Equal, Plus, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import Link from "next/link";

import { allocationType, reasonInfo } from "@/components/royalties/labels";
import { addDecimals, compareDecimals, subtractDecimals } from "@/components/royalties/money";
import { Money } from "@/components/royalties/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { Run, VerifyResult } from "@/lib/api/hooks/royalties";
import { cn } from "@/lib/utils";

/** Input = payable + retained + unallocated, checked exactly with decimal arithmetic. */
export function RunTotals({ run }: { run: Run }) {
  const sum = addDecimals(run.total_payable, run.total_retained, run.total_unallocated);
  const reconciles = compareDecimals(sum, run.total_input) === 0;
  const parts = [
    { key: "payable", amount: run.total_payable },
    { key: "retained", amount: run.total_retained },
    { key: "unallocated", amount: run.total_unallocated },
  ];
  return (
    <Card>
      <CardHeader
        title="Totals"
        description={`All valid ${run.currency} lines of the statement, allocated to the last 8 decimal places.`}
        actions={
          reconciles ? (
            <Badge tone="success" size="md">
              <CheckCircle2 className="size-3.5" aria-hidden /> Reconciles exactly
            </Badge>
          ) : (
            <Badge tone="danger" size="md">
              <XCircle className="size-3.5" aria-hidden /> Off by {subtractDecimals(run.total_input, sum)}
            </Badge>
          )
        }
      />
      <CardBody>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
          <TotalTile label="Input" amount={run.total_input} currency={run.currency} hint={`${run.line_count.toLocaleString()} lines`} strong />
          <Operator icon={<Equal aria-hidden />} label="equals" />
          {parts.map((part, index) => (
            <div key={part.key} className="flex flex-1 flex-col gap-3 lg:flex-row lg:items-stretch">
              {index > 0 ? <Operator icon={<Plus aria-hidden />} label="plus" /> : null}
              <TotalTile label={allocationType(part.key).label} amount={part.amount} currency={run.currency} hint={allocationType(part.key).description} tone={part.key} />
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-fg-subtle">
          Exact check: {sum} {run.currency} (payable + retained + unallocated) {reconciles ? "=" : "≠"} {run.total_input} {run.currency} (input).
          {run.warnings?.some((w) => w.type === "other_currencies") ? " Lines in other currencies are allocated separately (see warnings)." : null}
        </p>
      </CardBody>
    </Card>
  );
}

function Operator({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="flex items-center justify-center text-fg-subtle [&_svg]:size-4" aria-label={label} role="img">
      {icon}
    </span>
  );
}

function TotalTile({ label, amount, currency, hint, strong, tone }: { label: string; amount: string; currency: string; hint?: string; strong?: boolean; tone?: string }) {
  return (
    <div
      className={cn(
        "flex-1 rounded-lg border px-4 py-3",
        strong ? "border-border-strong bg-surface-2/60" : "border-border",
        tone === "payable" && "border-success/30",
        tone === "unallocated" && "border-warning/40",
      )}
    >
      <p className="text-xs font-medium text-fg-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold text-fg">
        <Money amount={amount} currency={currency} />
      </p>
      <p className="text-2xs text-fg-subtle">
        <Money amount={amount} currency={currency} precision="exact" currencyDisplay="code" />
      </p>
      {hint ? <p className="mt-1 text-xs text-fg-subtle">{hint}</p> : null}
    </div>
  );
}

export function VerifyPanel({ result, storedHash }: { result: VerifyResult; storedHash: string }) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {result.reproducible ? <ShieldCheck className="size-4 text-success" aria-hidden /> : <ShieldAlert className="size-4 text-warning" aria-hidden />}
            Reproducibility check
          </span>
        }
        description="The run was recomputed from current data and compared with what was stored."
        actions={<Badge tone={result.reproducible ? "success" : "warning"}>{result.reproducible ? "Reproducible" : "Does not reproduce"}</Badge>}
      />
      <CardBody className="space-y-3 text-[13px]">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-fg-subtle">Inputs unchanged</dt>
            <dd className="font-medium">{result.inputs_unchanged ? "Yes — same lines, shares, terms and basis" : "No — inputs changed since calculation"}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-subtle">Allocations match</dt>
            <dd className="font-medium">{result.allocations_match ? "Yes — identical allocations" : "No — allocations differ"}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-fg-subtle">Stored inputs hash</dt>
            <dd className="break-all font-mono text-xs">{result.stored_hash || storedHash}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-fg-subtle">Current inputs hash</dt>
            <dd className={cn("break-all font-mono text-xs", result.current_hash !== result.stored_hash && "text-warning")}>{result.current_hash}</dd>
          </div>
        </dl>
        <p className="text-xs text-fg-subtle">Engine version {result.calculation_version}. {result.reproducible ? "" : "Posting this run would be refused; recalculate first."}</p>
      </CardBody>
    </Card>
  );
}

interface Warning {
  type: string;
  reason?: string;
  count?: number;
  amount?: string;
  message?: string;
  totals?: Record<string, string>;
  contract_id?: string;
}

export function WarningsCard({ run }: { run: Run }) {
  const warnings = (run.warnings ?? []) as unknown as Warning[];
  if (warnings.length === 0) {
    return (
      <Card>
        <CardBody className="flex items-center gap-2 text-[13px] text-success">
          <CheckCircle2 className="size-4" aria-hidden /> Nothing was held: every line was fully allocated.
        </CardBody>
      </Card>
    );
  }
  const unallocated = warnings.filter((w) => w.type === "unallocated");
  const other = warnings.filter((w) => w.type !== "unallocated");
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-warning" aria-hidden /> Warnings
          </span>
        }
        description="Why some income is held, and what needs attention before posting."
      />
      {unallocated.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <caption className="sr-only">Unallocated amounts by reason</caption>
            <thead>
              <tr className="border-b border-border text-2xs uppercase tracking-[0.06em] text-fg-subtle">
                <th scope="col" className="px-5 py-2 font-medium">
                  Held because
                </th>
                <th scope="col" className="px-5 py-2 text-right font-medium">
                  Allocations
                </th>
                <th scope="col" className="px-5 py-2 text-right font-medium">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {unallocated.map((warning) => {
                const info = reasonInfo(warning.reason);
                return (
                  <tr key={warning.reason} className="border-b border-border align-top last:border-0">
                    <td className="px-5 py-3">
                      <p className="font-medium text-fg">{info.label}</p>
                      {info.explanation ? <p className="text-xs leading-relaxed text-fg-muted">{info.explanation}</p> : null}
                      {info.action ? <p className="mt-1 text-xs text-fg-subtle">Next step: {info.action}</p> : null}
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-fg-muted">{(warning.count ?? 0).toLocaleString()}</td>
                    <td className="px-5 py-3 text-right font-medium">
                      <Money amount={warning.amount} currency={run.currency} precision="exact" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {other.length > 0 ? (
        <ul className="space-y-2 border-t border-border px-5 py-4 text-[13px]">
          {other.map((warning, index) => (
            <li key={index} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              <div>
                <p className="text-fg">{warning.message ?? warning.type}</p>
                {warning.totals ? (
                  <p className="text-xs text-fg-muted">
                    {Object.entries(warning.totals).map(([code, amount], i) => (
                      <span key={code}>
                        {i > 0 ? " · " : ""}
                        <Money amount={amount} currency={code} precision="exact" />
                      </span>
                    ))}
                  </p>
                ) : null}
                {warning.contract_id ? (
                  <Link href={`/contracts/${warning.contract_id}`} className="text-xs text-primary hover:underline">
                    Open contract
                  </Link>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
