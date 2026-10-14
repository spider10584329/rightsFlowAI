"use client";

import { Download, HandCoins, Lock, Pencil, PlusCircle, RotateCcw, ScrollText } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";

import { LedgerEntryDialog, ReverseEntryDialog } from "@/components/payouts/ledger-dialogs";
import { PayeeFormDialog } from "@/components/payouts/payee-form-dialog";
import { entryType, paymentMethodLabel, paymentReferenceSummary } from "@/components/payouts/workflow";
import { decimalSign } from "@/components/royalties/money";
import { Money, formatIsoDate, shortId } from "@/components/royalties/shared";
import { useOrg } from "@/components/session/org-provider";
import { DetailLoadError } from "@/components/shared/detail-load-error";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn, type RowAction } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { KeyValueList } from "@/components/ui/key-value";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { downloadPayeeStatement, usePayee, usePayeeLedger, useUpdatePayee, type LedgerEntry, type Payee } from "@/lib/api/hooks/payouts";
import { useTableQueryState } from "@/lib/hooks/use-table-query-state";
import { formatDateTime } from "@/lib/utils";

const FILTERS = ["currency", "start", "end"] as const;

export function PayeeDetailClient() {
  const { id } = useParams<{ id: string }>();
  const { org, can } = useOrg();
  const payee = usePayee(org.id, id);
  const [editing, setEditing] = useState(false);
  const [entryKind, setEntryKind] = useState<"adjustment" | "advance" | null>(null);

  if (payee.isLoading) return <PageSkeleton />;
  if (payee.error || !payee.data) {
    return (
      <DetailLoadError
        error={payee.error}
        noun="Payee"
        breadcrumbs={[{ label: "Payouts", href: "/payouts" }, { label: "Payees", href: "/payouts/payees" }]}
        backHref="/payouts/payees"
        backLabel="Back to payees"
        onRetry={() => void payee.refetch()}
      />
    );
  }
  const p = payee.data;
  const isAdmin = can("admin");

  return (
    <>
      <PageHeader
        title={p.display_name}
        meta={
          <div className="flex gap-1.5">
            {p.is_active ? <Badge tone="success" dot>Active</Badge> : <Badge tone="neutral" dot>Inactive</Badge>}
            {p.hold_payments ? <Badge tone="warning">Payments on hold</Badge> : null}
          </div>
        }
        description={p.party_name ? `Party: ${p.party_name}${p.email ? ` · ${p.email}` : ""}` : (p.email ?? undefined)}
        breadcrumbs={[{ label: "Payouts", href: "/payouts" }, { label: "Payees", href: "/payouts/payees" }, { label: p.display_name }]}
        actions={
          <>
            {can("manager") ? (
              <Button variant="outline" leftIcon={<Pencil aria-hidden />} onClick={() => setEditing(true)}>
                Edit
              </Button>
            ) : null}
            {isAdmin ? (
              <>
                <Button variant="outline" leftIcon={<PlusCircle aria-hidden />} onClick={() => setEntryKind("adjustment")}>
                  Adjustment
                </Button>
                <Button leftIcon={<HandCoins aria-hidden />} onClick={() => setEntryKind("advance")}>
                  Advance
                </Button>
              </>
            ) : null}
          </>
        }
      />
      <Alert tone="info" className="mb-6">
        <span className="flex items-center gap-1.5">
          <Lock className="size-3.5" aria-hidden /> Ledger balances are accounting figures, not confirmed bank payments.
        </span>
      </Alert>

      <div className="space-y-6">
        <BalancesSection payee={p} />
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <LedgerCard orgId={org.id} payee={p} isAdmin={isAdmin} />
          <ProfileCard orgId={org.id} payee={p} canManage={can("manager")} />
        </div>
      </div>

      <PayeeFormDialog orgId={org.id} open={editing} onOpenChange={setEditing} payee={p} defaultCurrency={org.defaultCurrency} />
      <LedgerEntryDialog orgId={org.id} payeeId={p.id} payeeName={p.display_name} kind={entryKind} defaultCurrency={p.balances[0]?.currency ?? p.currency} onClose={() => setEntryKind(null)} />
    </>
  );
}

function BalancesSection({ payee }: { payee: Payee }) {
  if (payee.balances.length === 0) {
    return (
      <Card>
        <EmptyState compact icon={<ScrollText aria-hidden />} title="No ledger activity yet" description="Balances appear once a calculation run is posted or an adjustment or advance is recorded." />
      </Card>
    );
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {payee.balances.map((row) => (
        <Card key={row.currency}>
          <CardHeader title={`${row.currency} balance`} description="Sum of all ledger entries in this currency (no FX conversion)." />
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <Figure label="Balance" amount={row.balance} currency={row.currency} strong />
            <Figure label="Available to pay" amount={row.available} currency={row.currency} hint="Balance minus open batches" />
            <Figure label="Pending in batches" amount={row.pending_payouts} currency={row.currency} />
            <Figure label="Unrecouped advances" amount={row.unrecouped_advances} currency={row.currency} hint="Recovered from future earnings" />
            <Figure label="Lifetime earnings" amount={row.lifetime_earnings} currency={row.currency} />
            <Figure label="Lifetime payouts" amount={row.lifetime_payouts} currency={row.currency} />
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

function Figure({ label, amount, currency, hint, strong }: { label: string; amount: string; currency: string; hint?: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-xs text-fg-muted">{label}</p>
      <p className={strong ? "text-xl font-semibold" : "text-[15px] font-medium"}>
        <Money amount={amount} currency={currency} precision="exact" toneNegative />
      </p>
      {hint ? <p className="text-2xs text-fg-subtle">{hint}</p> : null}
    </div>
  );
}

function ProfileCard({ orgId, payee, canManage }: { orgId: string; payee: Payee; canManage: boolean }) {
  const update = useUpdatePayee(orgId, payee.id);
  return (
    <Card className="h-fit">
      <CardHeader title="Payment profile" description="Non-sensitive references only — full account numbers are never stored." />
      <CardBody className="space-y-4 py-2">
        <KeyValueList
          items={[
            { label: "Method", value: paymentMethodLabel(payee.payment_method) },
            { label: "Reference", value: paymentReferenceSummary(payee.payment_reference) ?? "—" },
            { label: "Country", value: (payee.payment_reference?.country as string | undefined) ?? "—" },
            { label: "Payout currency", value: payee.currency },
            { label: "Minimum payout", value: <Money amount={payee.minimum_payout} currency={payee.currency} /> },
            { label: "Tax form", value: payee.tax_form_status ?? "—" },
            { label: "Created", value: formatDateTime(payee.created_at) },
          ]}
        />
        {canManage ? (
          <div className="flex items-start gap-3 border-t border-border pt-4">
            <Switch
              id="hold"
              checked={payee.hold_payments}
              disabled={update.isPending}
              onCheckedChange={(checked) =>
                update.mutate(
                  { hold_payments: checked },
                  {
                    onSuccess: () => toast.success(checked ? "Payments on hold" : "Hold released"),
                    onError: (error) => toast.error("Could not update the hold", { description: errorMessage(error) }),
                  },
                )
              }
            />
            <div>
              <Label htmlFor="hold">Hold payments</Label>
              <p className="text-xs text-fg-subtle">Earnings keep accruing; the payee is skipped when drafting batches.</p>
            </div>
          </div>
        ) : null}
        {payee.notes ? <p className="border-t border-border pt-3 text-[13px] text-fg-muted">{payee.notes}</p> : null}
      </CardBody>
    </Card>
  );
}

function LedgerCard({ orgId, payee, isAdmin }: { orgId: string; payee: Payee; isAdmin: boolean }) {
  const table = useTableQueryState<(typeof FILTERS)[number]>({ filterKeys: FILTERS });
  const { filters } = table;
  const ledgerFilters = { currency: filters.currency || undefined, start: filters.start || undefined, end: filters.end || undefined };
  const ledger = usePayeeLedger(orgId, payee.id, ledgerFilters);
  const [reversing, setReversing] = useState<LedgerEntry | null>(null);
  const [downloading, setDownloading] = useState(false);
  const currencies = [...new Set([payee.currency, ...payee.balances.map((b) => b.currency)])];
  const invalidRange = Boolean(filters.start && filters.end && filters.end < filters.start);
  // Newest first for reading; the running balance comes from the backend (oldest-first accumulation).
  const rows = ledger.data ? [...ledger.data].reverse() : undefined;

  const columns: DataTableColumn<LedgerEntry>[] = [
    { id: "date", header: "Date", cell: (e) => <span className="whitespace-nowrap text-[13px]">{formatIsoDate(e.effective_date)}</span> },
    {
      id: "type",
      header: "Type",
      cell: (e) => (
        <div className="flex flex-wrap gap-1">
          <Badge tone={entryType(e.entry_type).tone} title={entryType(e.entry_type).description}>
            {entryType(e.entry_type).label}
          </Badge>
          {e.reversed ? <Badge tone="neutral">Reversed</Badge> : null}
        </div>
      ),
    },
    {
      id: "description",
      header: "Description",
      cell: (e) => (
        <div className="min-w-0 max-w-[22rem]">
          <p className="text-[13px] text-fg">{e.description}</p>
          <p className="text-xs text-fg-subtle">
            {e.run_id ? (
              <Link href={`/royalties/runs/${e.run_id}`} className="text-primary hover:underline">
                Run {shortId(e.run_id)}
              </Link>
            ) : null}
            {e.reversal_of_id ? <> Reverses {shortId(e.reversal_of_id)}</> : null}
          </p>
        </div>
      ),
    },
    {
      id: "amount",
      header: "Amount",
      align: "right",
      cell: (e) => <Money amount={e.amount} currency={e.currency} precision="exact" signDisplay="exceptZero" className={decimalSign(e.amount) < 0 ? "text-danger" : "text-success"} />,
    },
    { id: "running", header: "Running balance", align: "right", cell: (e) => <Money amount={e.running_balance} currency={e.currency} precision="exact" className="font-medium" /> },
  ];

  const actionsFor = (e: LedgerEntry): RowAction[] =>
    isAdmin && (e.entry_type === "adjustment" || e.entry_type === "advance") && !e.reversed
      ? [{ label: "Reverse entry", icon: <RotateCcw aria-hidden />, destructive: true, onSelect: () => setReversing(e) }]
      : [];

  return (
    <Card>
      <CardHeader
        title="Statement of account"
        description="Every ledger entry with its running balance per currency."
        actions={
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Download aria-hidden />}
            loading={downloading}
            disabled={invalidRange}
            onClick={() => {
              setDownloading(true);
              downloadPayeeStatement(orgId, payee.id, ledgerFilters)
                .catch((error) => toast.error("Download failed", { description: errorMessage(error) }))
                .finally(() => setDownloading(false));
            }}
          >
            CSV
          </Button>
        }
      />
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3 md:flex-row md:items-center">
        <Select
          size="sm"
          className="md:w-36"
          aria-label="Filter by currency"
          value={filters.currency || "all"}
          onValueChange={(v) => table.setFilter("currency", v === "all" ? null : v)}
          options={[{ value: "all", label: "All currencies" }, ...currencies.map((c) => ({ value: c, label: c }))]}
        />
        <div className="flex items-center gap-2">
          <Input type="date" className="h-8 w-[9.5rem] text-[13px]" aria-label="From date" value={filters.start} onChange={(e) => table.setFilter("start", e.target.value)} />
          <span className="text-xs text-fg-subtle" aria-hidden>
            –
          </span>
          <Input type="date" className="h-8 w-[9.5rem] text-[13px]" aria-label="To date" value={filters.end} onChange={(e) => table.setFilter("end", e.target.value)} aria-invalid={invalidRange || undefined} />
        </div>
        {invalidRange ? <p className="text-xs font-medium text-danger">End date is before start date.</p> : null}
      </div>
      <div className="overflow-x-auto">
        <DataTable
          columns={columns}
          data={rows}
          getRowId={(e) => e.id}
          getRowLabel={(e) => `${entryType(e.entry_type).label} ${e.effective_date}`}
          isLoading={ledger.isLoading}
          isFetching={ledger.isFetching}
          error={ledger.error}
          onRetry={() => void ledger.refetch()}
          rowActions={isAdmin ? actionsFor : undefined}
          caption="Ledger entries"
          emptyState={<EmptyState compact icon={<ScrollText aria-hidden />} title="No entries" description="No ledger entries in this range." />}
        />
      </div>
      <ReverseEntryDialog orgId={orgId} entry={reversing} onClose={() => setReversing(null)} />
    </Card>
  );
}
