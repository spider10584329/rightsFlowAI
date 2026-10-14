"use client";

import { Activity, Bot, CalendarClock, Disc3, FileText, Files, LayoutDashboard, Pencil, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { AnalysisPanel } from "@/components/contracts/analysis-panel";
import { contractStatusLabel, contractStatusTone, expiryDisplay, formatMoney, SOURCE_CATEGORIES } from "@/components/contracts/contract-format";
import { DocumentsPanel } from "@/components/contracts/documents-panel";
import { formatPercent, rightsTypeLabel, territoryLabel } from "@/components/rights/rights-format";
import { useOrg } from "@/components/session/org-provider";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { KeyValueList } from "@/components/ui/key-value";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toaster";
import { useContract, useContractActivity, useDeleteContract, type ContractAuditEntry, type ContractDetail } from "@/lib/api/hooks/contracts";
import { formatDate, formatDateTime, titleCase } from "@/lib/utils";

const TABS = ["overview", "parties", "catalog", "documents", "ai", "activity"] as const;
type Tab = (typeof TABS)[number];

export function ContractDetailClient() {
  const { org, can } = useOrg();
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const contract = useContract(org.id, id);
  const remove = useDeleteContract(org.id);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const analysisId = searchParams.get("analysis");
  const tabParam = searchParams.get("tab");
  const tab: Tab = analysisId && !tabParam ? "ai" : TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "overview";

  useEffect(() => {
    if (tab === "ai" && analysisId && contract.data) {
      const timer = setTimeout(() => document.getElementById(`analysis-${analysisId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
      return () => clearTimeout(timer);
    }
  }, [tab, analysisId, contract.data]);

  const setTab = (value: string) => {
    const next = new URLSearchParams(searchParams.toString());
    if (value === "overview") next.delete("tab");
    else next.set("tab", value);
    if (value !== "ai") next.delete("analysis");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  if (contract.isLoading) return <PageSkeleton rows={8} />;
  if (contract.error || !contract.data) {
    return (
      <>
        <PageHeader title="Contract" breadcrumbs={[{ label: "Contracts", href: "/contracts" }, { label: "Contract" }]} />
        <Card>
          <ErrorState error={contract.error} onRetry={() => void contract.refetch()} />
        </Card>
      </>
    );
  }
  const data = contract.data;
  const expiry = expiryDisplay(data.expiry_state, data.days_until_expiry, data.auto_renew);

  return (
    <>
      <PageHeader
        title={data.title}
        meta={
          <>
            <Badge tone={contractStatusTone(data.status)} dot size="md">
              {contractStatusLabel(data.status)}
            </Badge>
            {data.end_date ? (
              <Badge tone={expiry.tone} size="md" className="gap-1">
                <CalendarClock className="size-3" aria-hidden /> {expiry.label}
              </Badge>
            ) : null}
          </>
        }
        description={[data.reference, titleCase(data.contract_type), data.party_names.join(", ")].filter(Boolean).join(" · ")}
        breadcrumbs={[{ label: "Contracts", href: "/contracts" }, { label: data.title }]}
        actions={
          <>
            {can("manager") ? (
              <ButtonLink href={`/contracts/${id}/edit`} variant="outline" leftIcon={<Pencil aria-hidden />}>
                Edit
              </ButtonLink>
            ) : null}
            {can("admin") ? (
              <Button variant="ghost" leftIcon={<Trash2 aria-hidden />} onClick={() => setDeleteOpen(true)}>
                Delete
              </Button>
            ) : null}
          </>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">
            <LayoutDashboard aria-hidden /> Overview
          </TabsTrigger>
          <TabsTrigger value="parties">
            <Users aria-hidden /> Parties & terms
          </TabsTrigger>
          <TabsTrigger value="catalog">
            <Disc3 aria-hidden /> Catalog items ({data.assets.length})
          </TabsTrigger>
          <TabsTrigger value="documents">
            <Files aria-hidden /> Documents ({data.documents.length})
          </TabsTrigger>
          <TabsTrigger value="ai">
            <Bot aria-hidden /> AI analysis
          </TabsTrigger>
          <TabsTrigger value="activity">
            <Activity aria-hidden /> Activity
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Overview contract={data} />
        </TabsContent>
        <TabsContent value="parties">
          <PartiesAndTerms contract={data} />
        </TabsContent>
        <TabsContent value="catalog">
          <CatalogItems contract={data} canEdit={can("manager")} />
        </TabsContent>
        <TabsContent value="documents">
          <DocumentsPanel orgId={org.id} contractId={id} canEdit={can("manager")} isAdmin={can("admin")} />
        </TabsContent>
        <TabsContent value="ai">
          <AnalysisPanel orgId={org.id} contract={data} canEdit={can("manager")} focusId={analysisId} />
        </TabsContent>
        <TabsContent value="activity">
          <ActivityPanel orgId={org.id} contractId={id} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete contract?"
        description={`“${data.title}”, its terms and documents will be deleted. Contracts referenced by shares or royalty data cannot be deleted.`}
        confirmLabel="Delete contract"
        confirmText={data.reference ?? undefined}
        onConfirm={async () => {
          await remove.mutateAsync(id);
          toast.success("Contract deleted");
          router.push("/contracts");
        }}
      />
    </>
  );
}

function Overview({ contract }: { contract: ContractDetail }) {
  const expiry = expiryDisplay(contract.expiry_state, contract.days_until_expiry, contract.auto_renew);
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <Card>
        <CardHeader title="Key terms" />
        <CardBody className="py-1">
          <KeyValueList
            columns={2}
            items={[
              { label: "Type", value: titleCase(contract.contract_type) },
              { label: "Status", value: contractStatusLabel(contract.status) },
              { label: "Reference", value: contract.reference ?? "—", mono: Boolean(contract.reference) },
              { label: "Currency", value: contract.currency },
              { label: "Start date", value: formatDate(contract.start_date) },
              { label: "End date", value: formatDate(contract.end_date) },
              { label: "Renewal date", value: formatDate(contract.renewal_date) },
              { label: "Auto-renew", value: contract.auto_renew ? "Yes" : "No" },
              { label: "Notice period", value: contract.notice_period_days !== null && contract.notice_period_days !== undefined ? `${contract.notice_period_days} days` : "—" },
              { label: "Advance", value: formatMoney(contract.advance_amount, contract.currency) },
              { label: "Recoupable", value: contract.is_recoupable ? "Yes" : "No" },
              { label: "Territories", value: territoryLabel(contract.territories, null) },
              { label: "Rights granted", value: contract.rights_granted.length ? contract.rights_granted.map(rightsTypeLabel).join(", ") : "—" },
              { label: "Last updated", value: formatDateTime(contract.updated_at) },
            ]}
          />
        </CardBody>
        {contract.summary || contract.notes ? (
          <CardBody className="space-y-4 border-t border-border">
            {contract.summary ? (
              <section>
                <h3 className="text-[13px] font-semibold">Summary</h3>
                <p className="mt-1 whitespace-pre-wrap text-[13px] text-fg-muted">{contract.summary}</p>
              </section>
            ) : null}
            {contract.notes ? (
              <section>
                <h3 className="text-[13px] font-semibold">Internal notes</h3>
                <p className="mt-1 whitespace-pre-wrap text-[13px] text-fg-muted">{contract.notes}</p>
              </section>
            ) : null}
          </CardBody>
        ) : null}
      </Card>
      <div className="space-y-5">
        <Card>
          <CardHeader title="Expiry" />
          <CardBody className="space-y-2">
            <Badge tone={expiry.tone} size="md">
              {expiry.label}
            </Badge>
            <p className="text-3xl font-semibold tabular-nums">
              {contract.days_until_expiry !== null && contract.days_until_expiry !== undefined ? contract.days_until_expiry : "—"}
              <span className="ml-1 text-sm font-normal text-fg-muted">days until expiry</span>
            </p>
            <p className="text-xs text-fg-subtle">
              {contract.auto_renew ? "Auto-renews" : "Does not auto-renew"}
              {contract.notice_period_days ? ` · ${contract.notice_period_days}-day notice period` : ""}
              {contract.expiry_notified_at ? ` · expiry warning sent ${formatDate(contract.expiry_notified_at)}` : ""}
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="At a glance" />
          <CardBody className="grid grid-cols-2 gap-4 text-center">
            {[
              ["Parties", contract.parties.length],
              ["Royalty terms", contract.royalty_terms.length],
              ["Catalog items", contract.assets.length],
              ["Documents", contract.documents.length],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-surface-2/60 py-3">
                <p className="text-xl font-semibold tabular-nums">{value}</p>
                <p className="text-xs text-fg-muted">{label}</p>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function PartiesAndTerms({ contract }: { contract: ContractDetail }) {
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Parties" />
        {contract.parties.length === 0 ? (
          <EmptyState compact icon={<Users aria-hidden />} title="No parties" description="Edit the contract to add the signatories." />
        ) : (
          <ul className="divide-y divide-border">
            {contract.parties.map((party) => (
              <li key={party.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-[13px]">
                <Link href={`/catalog/parties/${party.party_id}`} className="font-medium hover:text-primary hover:underline">
                  {party.party_name ?? party.party_id}
                </Link>
                <span className="flex items-center gap-2">
                  <Badge tone="neutral">{titleCase(party.role)}</Badge>
                  <span className="text-xs text-fg-subtle">{party.signed_at ? `Signed ${formatDate(party.signed_at)}` : "Not signed"}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Royalty terms" description="Rates payable under this agreement." />
        {contract.royalty_terms.length === 0 ? (
          <EmptyState compact title="No royalty terms" description="Edit the contract to add rates." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <caption className="sr-only">Royalty terms</caption>
              <thead className="border-b border-border text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
                <tr>
                  <th scope="col" className="px-5 py-2.5 font-medium">Payee</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Rights</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Source</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Territories</th>
                  <th scope="col" className="px-3 py-2.5 text-right font-medium">Rate</th>
                  <th scope="col" className="px-5 py-2.5 font-medium">Basis</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {contract.royalty_terms.map((term) => (
                  <tr key={term.id}>
                    <td className="px-5 py-2.5">
                      {term.payee_name ?? "Any"}
                      {term.description ? <p className="text-xs text-fg-subtle">{term.description}</p> : null}
                    </td>
                    <td className="px-3 py-2.5">{term.rights_type ? rightsTypeLabel(term.rights_type) : "All"}</td>
                    <td className="px-3 py-2.5">{term.source_category ? (SOURCE_CATEGORIES[term.source_category] ?? term.source_category) : "All"}</td>
                    <td className="px-3 py-2.5">{term.territories?.length ? territoryLabel(term.territories, null) : "All"}</td>
                    <td className="px-3 py-2.5 text-right font-medium tabular-nums">{formatPercent(term.rate_percent)}</td>
                    <td className="px-5 py-2.5">{titleCase(term.basis)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function CatalogItems({ contract, canEdit }: { contract: ContractDetail; canEdit: boolean }) {
  return (
    <Card>
      <CardHeader
        title="Catalog items"
        description="Works and recordings covered by this agreement."
        actions={
          canEdit ? (
            <ButtonLink href={`/contracts/${contract.id}/edit`} size="sm" variant="outline">
              Manage items
            </ButtonLink>
          ) : null
        }
      />
      {contract.assets.length === 0 ? (
        <EmptyState compact icon={<FileText aria-hidden />} title="No catalog items linked" description="Link the works and recordings this agreement covers." />
      ) : (
        <ul className="divide-y divide-border">
          {contract.assets.map((asset) => {
            const assetId = asset.work_id ?? asset.recording_id;
            const segment = asset.asset_type === "work" ? "works" : "recordings";
            return (
              <li key={asset.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-[13px]">
                {asset.asset_type === "work" ? <FileText className="size-4 text-fg-subtle" aria-hidden /> : <Disc3 className="size-4 text-fg-subtle" aria-hidden />}
                <Link href={`/catalog/${segment}/${assetId}`} className="min-w-0 flex-1 truncate font-medium hover:text-primary hover:underline">
                  {asset.title ?? "Untitled"}
                </Link>
                {asset.code ? <span className="font-mono text-xs text-fg-subtle">{asset.code}</span> : null}
                <Badge tone="neutral">{titleCase(asset.asset_type)}</Badge>
                <Link href={`/rights?asset_type=${asset.asset_type}&asset_id=${assetId}`} className="text-xs font-medium text-primary hover:underline">
                  Ownership
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function ActivityPanel({ orgId, contractId }: { orgId: string; contractId: string }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const activity = useContractActivity(orgId, contractId, { page, page_size: pageSize });
  const columns: DataTableColumn<ContractAuditEntry>[] = [
    { id: "when", header: "When", cell: (entry) => <span className="whitespace-nowrap text-[13px]">{formatDateTime(entry.created_at)}</span> },
    { id: "who", header: "By", cell: (entry) => entry.actor_name ?? (entry.actor_user_id ? "Team member" : "System") },
    { id: "action", header: "Action", cell: (entry) => <span className="font-medium">{titleCase(entry.action.replace(/^(contract|file)\./, ""))}</span> },
    { id: "summary", header: "Details", cell: (entry) => <span className="text-[13px] text-fg-muted">{entry.summary ?? "—"}</span> },
  ];
  return (
    <Card>
      <div className="overflow-x-auto">
        <DataTable
          columns={columns}
          data={activity.data?.items}
          getRowId={(entry) => entry.id}
          isLoading={activity.isLoading}
          isFetching={activity.isFetching}
          error={activity.error}
          onRetry={() => void activity.refetch()}
          caption="Contract activity"
          emptyState={<EmptyState compact icon={<Activity aria-hidden />} title="No activity yet" />}
          footer={
            activity.data && activity.data.total > 0 ? (
              <Pagination
                page={page}
                pageSize={pageSize}
                total={activity.data.total}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            ) : null
          }
        />
      </div>
    </Card>
  );
}
