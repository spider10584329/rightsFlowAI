"use client";

import { Ban, Info, Pencil, Plus, ShieldCheck, SlidersHorizontal, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { DEFAULT_RULE, formatPercent, parsePercent, rightsTypeLabel, rightsTypesFor, trimPercent } from "@/components/rights/rights-format";
import { useOrg } from "@/components/session/org-provider";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn, type RowAction } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors } from "@/lib/api/errors";
import { useReferenceList } from "@/lib/api/hooks/reference";
import { useCreateSplitRule, useDeleteSplitRule, useSplitRules, useUpdateSplitRule, type AssetType, type RightsType, type SplitRule } from "@/lib/api/hooks/rights";
import { titleCase } from "@/lib/utils";

type DialogState = { kind: "create" } | { kind: "edit"; rule: SplitRule } | { kind: "delete"; rule: SplitRule } | null;

function territoryText(territory: string | null) {
  if (!territory) return "All territories (fallback)";
  if (territory === "WORLD") return "WORLD";
  return territory;
}

export function SplitRulesClient() {
  const { org, can } = useOrg();
  const isAdmin = can("admin");
  const rules = useSplitRules(org.id);
  const remove = useDeleteSplitRule(org.id);
  const [dialog, setDialog] = useState<DialogState>(null);

  const columns: DataTableColumn<SplitRule>[] = [
    {
      id: "scope",
      header: "Scope",
      cell: (rule) => (
        <div>
          <p className="font-medium">
            {titleCase(rule.asset_type)} · {rightsTypeLabel(rule.rights_type)}
          </p>
          <p className="text-xs text-fg-subtle">{territoryText(rule.territory)}</p>
        </div>
      ),
    },
    {
      id: "expected",
      header: "Expected total",
      align: "right",
      cell: (rule) => (
        <span className="tabular-nums">
          {formatPercent(rule.expected_total)} <span className="text-xs text-fg-subtle">±{formatPercent(rule.tolerance)}</span>
        </span>
      ),
    },
    {
      id: "under",
      header: "Under-allocation",
      hideOnMobile: true,
      cell: (rule) => (rule.allow_under_allocation ? <Badge tone="info">Allowed</Badge> : <Badge tone="warning">Flagged</Badge>),
    },
    {
      id: "enforcement",
      header: "Enforcement",
      cell: (rule) =>
        rule.enforcement === "block" ? (
          <Badge tone="danger" className="gap-1">
            <Ban className="size-3" aria-hidden /> Block
          </Badge>
        ) : (
          <Badge tone="warning" className="gap-1">
            <TriangleAlert className="size-3" aria-hidden /> Warn
          </Badge>
        ),
    },
    { id: "description", header: "Description", hideOnMobile: true, cell: (rule) => <span className="text-[13px] text-fg-muted">{rule.description ?? "—"}</span> },
  ];

  const actions = (rule: SplitRule): RowAction[] => [
    { label: "Edit", icon: <Pencil aria-hidden />, onSelect: () => setDialog({ kind: "edit", rule }) },
    { label: "Delete", icon: <Trash2 aria-hidden />, destructive: true, separated: true, onSelect: () => setDialog({ kind: "delete", rule }) },
  ];

  return (
    <>
      <PageHeader
        title="Split validation rules"
        description="How ownership totals are checked. Rules are configurable per asset type, rights type and territory."
        breadcrumbs={[{ label: "Rights", href: "/rights" }, { label: "Split rules" }]}
        actions={
          isAdmin ? (
            <Button leftIcon={<Plus aria-hidden />} onClick={() => setDialog({ kind: "create" })}>
              New rule
            </Button>
          ) : null
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          {!isAdmin ? (
            <div className="border-b border-border px-5 py-3">
              <p className="flex items-center gap-2 text-[13px] text-fg-muted">
                <Info className="size-4" aria-hidden /> Read-only: only admins can change split rules.
              </p>
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <DataTable
              columns={columns}
              data={rules.data}
              getRowId={(rule) => rule.id}
              getRowLabel={(rule) => `${rule.asset_type} ${rule.rights_type} ${rule.territory ?? "all"}`}
              isLoading={rules.isLoading}
              error={rules.error}
              onRetry={() => void rules.refetch()}
              rowActions={isAdmin ? actions : undefined}
              caption="Split rules"
              emptyState={
                <EmptyState
                  compact
                  icon={<SlidersHorizontal aria-hidden />}
                  title="Using the default rule everywhere"
                  description={`Every rights type is expected to total ${DEFAULT_RULE.expectedTotal}% (±${DEFAULT_RULE.tolerance}%), under-allocation is flagged and problems only warn.`}
                  action={
                    isAdmin ? (
                      <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "create" })}>
                        Add a rule
                      </Button>
                    ) : null
                  }
                />
              }
            />
          </div>
        </Card>
        <Card>
          <CardHeader title="How rules apply" />
          <CardBody className="space-y-3 text-[13px] leading-relaxed text-fg-muted">
            <p className="flex gap-2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              For each country, the most specific rule wins: a rule for that country, then WORLD, then “all territories”, then the default (100% ± 0.01%, warn).
            </p>
            <p>
              <span className="font-medium text-fg">Warn</span> records a conflict for review but lets the change through.{" "}
              <span className="font-medium text-fg">Block</span> rejects any split change that leaves totals outside the expected range.
            </p>
            <p>Allowing under-allocation is useful when you only administer part of a work and the rest is unclaimed.</p>
          </CardBody>
        </Card>
      </div>

      {dialog?.kind === "create" ? <RuleDialog orgId={org.id} rule={null} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "edit" ? <RuleDialog key={dialog.rule.id} orgId={org.id} rule={dialog.rule} onClose={() => setDialog(null)} /> : null}
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Delete split rule?"
        description={
          dialog?.kind === "delete"
            ? `Totals for ${dialog.rule.asset_type} ${rightsTypeLabel(dialog.rule.rights_type).toLowerCase()} in ${territoryText(dialog.rule.territory)} fall back to the next most specific rule.`
            : undefined
        }
        confirmLabel="Delete rule"
        onConfirm={async () => {
          if (dialog?.kind !== "delete") return;
          await remove.mutateAsync(dialog.rule.id);
          toast.success("Split rule deleted");
        }}
      />
    </>
  );
}

function RuleDialog({ orgId, rule, onClose }: { orgId: string; rule: SplitRule | null; onClose: () => void }) {
  const create = useCreateSplitRule(orgId);
  const update = useUpdateSplitRule(orgId);
  const territories = useReferenceList("territories");
  const pending = create.isPending || update.isPending;
  const [assetType, setAssetType] = useState<AssetType>((rule?.asset_type as AssetType) ?? "work");
  const [rightsType, setRightsType] = useState<RightsType>((rule?.rights_type as RightsType) ?? "performance");
  const [territory, setTerritory] = useState(rule?.territory ?? "");
  const [expected, setExpected] = useState(rule ? trimPercent(rule.expected_total) : "100");
  const [tolerance, setTolerance] = useState(rule ? trimPercent(rule.tolerance) : "0.01");
  const [allowUnder, setAllowUnder] = useState(rule?.allow_under_allocation ?? false);
  const [enforcement, setEnforcement] = useState<"warn" | "block">((rule?.enforcement as "warn" | "block") ?? "warn");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const rightsOptions = rightsTypesFor(assetType);

  const submit = () => {
    const next: Record<string, string> = {};
    const expectedValue = parsePercent(expected);
    if (expectedValue === null || expectedValue <= BigInt(0) || expectedValue > BigInt(100_000_000)) next.expected_total = "Above 0 and at most 100.";
    const toleranceValue = parsePercent(tolerance);
    if (toleranceValue === null || toleranceValue > BigInt(100_000_000)) next.tolerance = "Between 0 and 100.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setFormError(null);
    const common = {
      expected_total: expected.trim(),
      tolerance: tolerance.trim(),
      allow_under_allocation: allowUnder,
      enforcement,
      description: description.trim() || null,
    };
    const handlers = {
      onSuccess: () => {
        toast.success(rule ? "Split rule updated" : "Split rule created");
        onClose();
      },
      onError: (error: unknown) => {
        const fields = fieldErrors(error);
        setErrors(fields);
        if (Object.keys(fields).length === 0) setFormError(errorMessage(error));
      },
    };
    if (rule) update.mutate({ id: rule.id, body: common }, handlers);
    else create.mutate({ ...common, asset_type: assetType, rights_type: rightsType, territory: territory || null }, handlers);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !pending && onClose()}
      title={rule ? "Edit split rule" : "New split rule"}
      description={rule ? "The scope of a rule cannot change; delete it and create a new one instead." : "Pick the scope this rule applies to, then the expected total."}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} loading={pending}>
            {rule ? "Save rule" : "Create rule"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {formError ? (
          <Alert tone="danger" className="sm:col-span-2">
            {formError}
          </Alert>
        ) : null}
        <FormField label="Asset type" error={errors.asset_type}>
          {(props) => (
            <Select
              {...props}
              disabled={Boolean(rule)}
              value={assetType}
              onValueChange={(value) => {
                setAssetType(value);
                if (!rightsTypesFor(value).includes(rightsType)) setRightsType(rightsTypesFor(value)[0]);
              }}
              options={[
                { value: "work", label: "Work" },
                { value: "recording", label: "Recording" },
              ]}
            />
          )}
        </FormField>
        <FormField label="Rights type" error={errors.rights_type}>
          {(props) => (
            <Select {...props} disabled={Boolean(rule)} value={rightsType} onValueChange={setRightsType} options={rightsOptions.map((value) => ({ value, label: rightsTypeLabel(value) }))} />
          )}
        </FormField>
        <FormField label="Territory" error={errors.territory} className="sm:col-span-2" hint="“All territories” is the fallback when no country or WORLD rule matches.">
          <NativeSelect value={territory} onChange={(event) => setTerritory(event.target.value)} disabled={Boolean(rule)}>
            <option value="">All territories (fallback)</option>
            {(territories.data ?? [{ code: "WORLD", name: "Worldwide" }]).map((item) => (
              <option key={item.code} value={item.code}>
                {item.code === "WORLD" ? "WORLD" : `${item.name} (${item.code})`}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField label="Expected total %" required error={errors.expected_total}>
          <Input inputMode="decimal" value={expected} onChange={(event) => setExpected(event.target.value)} />
        </FormField>
        <FormField label="Tolerance ±%" required error={errors.tolerance}>
          <Input inputMode="decimal" value={tolerance} onChange={(event) => setTolerance(event.target.value)} />
        </FormField>
        <FormField label="Enforcement" error={errors.enforcement} className="sm:col-span-2">
          {(props) => (
            <Select
              {...props}
              value={enforcement}
              onValueChange={setEnforcement}
              options={[
                { value: "warn", label: "Warn", description: "Record a conflict but allow the change" },
                { value: "block", label: "Block", description: "Reject split changes that violate the rule" },
              ]}
            />
          )}
        </FormField>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Switch id="rule-allow-under" checked={allowUnder} onCheckedChange={setAllowUnder} />
          <Label htmlFor="rule-allow-under" className="font-normal">
            Allow under-allocation (totals below the expected value are not flagged)
          </Label>
        </div>
        <FormField label="Description" className="sm:col-span-2" error={errors.description}>
          <Textarea rows={2} maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} />
        </FormField>
      </div>
    </Dialog>
  );
}
