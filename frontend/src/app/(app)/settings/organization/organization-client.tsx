"use client";

import { Lock } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { useOrg } from "@/components/session/org-provider";
import { RoleBadge } from "@/components/shared/role-badge";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { KeyValueList } from "@/components/ui/key-value";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { PageSkeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors } from "@/lib/api/errors";
import { useOrganizationDetail, useUpdateOrganization, useUpdateOrganizationSettings } from "@/lib/api/hooks/organizations";
import { useCurrencyCodes, useReferenceList } from "@/lib/api/hooks/reference";
import type { AllocationBasis, OrganizationDetail, OrganizationSettings, OrganizationUpdate } from "@/lib/api/types";
import { formatDate } from "@/lib/utils";

import { DangerZone } from "./danger-zone";

export function OrganizationClient() {
  const { org, can } = useOrg();
  const detail = useOrganizationDetail(org.id);
  const canEdit = can("admin");

  return (
    <>
      <PageHeader
        title="Organization"
        description="Profile, accounting behaviour and lifecycle of this workspace."
        breadcrumbs={[{ label: "Admin" }, { label: "Organization" }]}
        meta={<RoleBadge role={org.role} />}
      />
      {detail.isLoading ? (
        <PageSkeleton rows={8} />
      ) : detail.error || !detail.data ? (
        <Card>
          <ErrorState error={detail.error} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
        </Card>
      ) : (
        <div className="space-y-6">
          {!canEdit ? (
            <Alert tone="info" title="Read-only">
              Only admins and the owner can change organization settings.
            </Alert>
          ) : null}
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <ProfileForm key={`profile-${detail.data.updated_at}`} detail={detail.data} canEdit={canEdit} />
            <Card className="h-fit">
              <CardHeader title="Overview" />
              <CardBody className="py-1">
                <KeyValueList
                  items={[
                    { label: "Slug", value: detail.data.slug, mono: true },
                    { label: "Organization ID", value: <span className="select-all">{detail.data.id}</span>, mono: true },
                    { label: "Members", value: detail.data.member_count.toLocaleString() },
                    { label: "Created", value: formatDate(detail.data.created_at) },
                    { label: "Your role", value: <RoleBadge role={org.role} /> },
                  ]}
                />
              </CardBody>
            </Card>
          </div>
          <BehaviourForm key={`settings-${JSON.stringify(detail.data.settings)}`} orgId={org.id} settings={detail.data.settings} canEdit={canEdit} />
          <DangerZone detail={detail.data} />
        </div>
      )}
    </>
  );
}

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

const emptyToNull = (value: string) => (value.trim() === "" ? null : value.trim());

function ProfileForm({ detail, canEdit }: { detail: OrganizationDetail; canEdit: boolean }) {
  const update = useUpdateOrganization(detail.id);
  const currencies = useCurrencyCodes();
  const territories = useReferenceList("territories");
  const zones = useMemo(() => timeZones(), []);
  const [form, setForm] = useState({
    name: detail.name,
    legal_name: detail.legal_name ?? "",
    description: detail.description ?? "",
    website: detail.website ?? "",
    country_code: detail.country_code ?? "",
    default_currency: detail.default_currency,
    timezone: detail.timezone,
    brand_color: detail.brand_color ?? "",
    logo_url: detail.logo_url ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const countries = (territories.data ?? []).filter((item) => /^[A-Z]{2}$/.test(item.code));
  const set = (key: keyof typeof form) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (form.name.trim().length < 2) nextErrors.name = "Name must be at least 2 characters.";
    if (form.website && !/^https?:\/\/\S+$/.test(form.website.trim())) nextErrors.website = "Use a full URL starting with http:// or https://";
    if (form.logo_url && !/^https:\/\/\S+$/.test(form.logo_url.trim())) nextErrors.logo_url = "Logo URL must start with https://";
    if (form.brand_color && !/^#[0-9a-fA-F]{6}$/.test(form.brand_color.trim())) nextErrors.brand_color = "Use a hex colour like #4F46E5";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const payload: OrganizationUpdate = {
      name: form.name.trim(),
      legal_name: emptyToNull(form.legal_name),
      description: emptyToNull(form.description),
      website: emptyToNull(form.website),
      country_code: emptyToNull(form.country_code),
      default_currency: form.default_currency,
      timezone: form.timezone,
      brand_color: emptyToNull(form.brand_color),
      logo_url: emptyToNull(form.logo_url),
    };
    update.mutate(payload, {
      onSuccess: () => toast.success("Organization profile saved"),
      onError: (error) => {
        setErrors(fieldErrors(error));
        toast.error("Could not save profile", { description: errorMessage(error) });
      },
    });
  };

  return (
    <Card>
      <CardHeader title="Profile" description="Shown on statements, exports and invitations." />
      <form onSubmit={submit} noValidate>
        <fieldset disabled={!canEdit || update.isPending} className="contents">
          <CardBody className="grid gap-5 md:grid-cols-2">
            <FormField label="Display name" required error={errors.name}>
              <Input value={form.name} onChange={(event) => set("name")(event.target.value)} maxLength={255} />
            </FormField>
            <FormField label="Legal name" error={errors.legal_name} hint="Used on royalty statements.">
              <Input value={form.legal_name} onChange={(event) => set("legal_name")(event.target.value)} maxLength={255} />
            </FormField>
            <FormField label="Description" error={errors.description} className="md:col-span-2">
              <Textarea value={form.description} onChange={(event) => set("description")(event.target.value)} maxLength={5000} rows={3} />
            </FormField>
            <FormField label="Website" error={errors.website}>
              <Input type="url" value={form.website} onChange={(event) => set("website")(event.target.value)} placeholder="https://" />
            </FormField>
            <FormField label="Country" error={errors.country_code}>
              <NativeSelect value={form.country_code} onChange={(event) => set("country_code")(event.target.value)}>
                <option value="">Not set</option>
                {form.country_code && !countries.some((item) => item.code === form.country_code) ? (
                  <option value={form.country_code}>{form.country_code}</option>
                ) : null}
                {countries.map((item) => (
                  <option key={item.code} value={item.code}>
                    {item.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Default currency" error={errors.default_currency} hint="Applies to new statements and payouts.">
              {(props) => (
                <Select
                  {...props}
                  value={form.default_currency}
                  onValueChange={set("default_currency")}
                  disabled={!canEdit}
                  options={Array.from(new Set([form.default_currency, ...currencies])).map((code) => ({ value: code, label: code }))}
                />
              )}
            </FormField>
            <FormField label="Time zone" error={errors.timezone}>
              <NativeSelect value={form.timezone} onChange={(event) => set("timezone")(event.target.value)}>
                {!zones.includes(form.timezone) ? <option value={form.timezone}>{form.timezone}</option> : null}
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replace(/_/g, " ")}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField label="Brand colour" error={errors.brand_color} hint="Hex value, e.g. #4F46E5">
              {(props) => (
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label="Pick brand colour"
                    value={/^#[0-9a-fA-F]{6}$/.test(form.brand_color) ? form.brand_color : "#4f46e5"}
                    onChange={(event) => set("brand_color")(event.target.value)}
                    className="h-9 w-11 shrink-0 cursor-pointer rounded-md border border-border-strong bg-surface p-1 disabled:cursor-not-allowed"
                  />
                  <Input {...props} value={form.brand_color} onChange={(event) => set("brand_color")(event.target.value)} placeholder="#4F46E5" maxLength={7} />
                </div>
              )}
            </FormField>
            <FormField label="Logo URL" error={errors.logo_url} hint="Public https:// image URL.">
              <Input type="url" value={form.logo_url} onChange={(event) => set("logo_url")(event.target.value)} placeholder="https://" maxLength={500} />
            </FormField>
          </CardBody>
        </fieldset>
        {canEdit ? (
          <CardFooter>
            <Button type="submit" loading={update.isPending}>
              Save profile
            </Button>
          </CardFooter>
        ) : null}
      </form>
    </Card>
  );
}

const ALLOCATION_OPTIONS: { value: AllocationBasis; label: string; description: string }[] = [
  {
    value: "controlled_pro_rata",
    label: "Controlled pro-rata",
    description: "Allocate income across controlled shares only, scaled to 100%.",
  },
  {
    value: "gross_share",
    label: "Gross share",
    description: "Allocate each party's share of the gross, leaving uncontrolled shares unallocated.",
  },
];

function BehaviourForm({ orgId, settings, canEdit }: { orgId: string; settings: OrganizationSettings; canEdit: boolean }) {
  const update = useUpdateOrganizationSettings(orgId);
  const [form, setForm] = useState<OrganizationSettings>(settings);
  const [days, setDays] = useState(String(settings.contract_expiry_warning_days));
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = Number(days);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
      setError("Enter a whole number of days between 1 and 365.");
      return;
    }
    setError(null);
    update.mutate(
      { ...form, contract_expiry_warning_days: parsed },
      {
        onSuccess: () => toast.success("Settings saved"),
        onError: (cause) => toast.error("Could not save settings", { description: errorMessage(cause) }),
      },
    );
  };

  const toggles: { key: keyof Pick<OrganizationSettings, "require_distinct_payout_approver" | "auto_match_title_artist" | "ai_contract_analysis_enabled">; label: string; description: string }[] = [
    {
      key: "require_distinct_payout_approver",
      label: "Four-eyes payout approval",
      description: "The person who prepares a payout batch cannot approve it.",
    },
    {
      key: "auto_match_title_artist",
      label: "Automatic title & artist matching",
      description: "Match statement lines to the catalog by title and artist when no ISRC/ISWC is present.",
    },
    {
      key: "ai_contract_analysis_enabled",
      label: "AI contract analysis",
      description: "Allow managers to extract terms from uploaded contracts. Suggestions always need human approval.",
    },
  ];

  return (
    <Card>
      <CardHeader title="Accounting behaviour" description="Rules applied across royalty processing, contracts and payouts." />
      <form onSubmit={submit} noValidate>
        <fieldset disabled={!canEdit || update.isPending} className="contents">
          <CardBody className="space-y-6">
            <div className="grid gap-5 md:grid-cols-2">
              <FormField label="Allocation basis" hint={ALLOCATION_OPTIONS.find((option) => option.value === form.allocation_basis)?.description}>
                {(props) => (
                  <Select
                    {...props}
                    value={form.allocation_basis}
                    disabled={!canEdit}
                    onValueChange={(value) => setForm((current) => ({ ...current, allocation_basis: value }))}
                    options={ALLOCATION_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                  />
                )}
              </FormField>
              <FormField label="Contract expiry warning" hint="Days before a contract ends that admins are notified." error={error ?? undefined}>
                {(props) => (
                  <div className="flex items-center gap-2">
                    <Input {...props} type="number" min={1} max={365} step={1} value={days} onChange={(event) => setDays(event.target.value)} className="w-28" />
                    <span className="text-[13px] text-fg-muted">days</span>
                  </div>
                )}
              </FormField>
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {toggles.map((toggle) => (
                <li key={toggle.key} className="flex items-start justify-between gap-4 px-4 py-3.5">
                  <div className="space-y-0.5">
                    <label htmlFor={`setting-${toggle.key}`} className="text-[13px] font-medium text-fg">
                      {toggle.label}
                    </label>
                    <p id={`setting-${toggle.key}-hint`} className="text-xs leading-relaxed text-fg-muted">
                      {toggle.description}
                    </p>
                  </div>
                  <Switch
                    id={`setting-${toggle.key}`}
                    aria-describedby={`setting-${toggle.key}-hint`}
                    checked={form[toggle.key]}
                    onCheckedChange={(checked) => setForm((current) => ({ ...current, [toggle.key]: checked }))}
                    disabled={!canEdit}
                  />
                </li>
              ))}
            </ul>
          </CardBody>
        </fieldset>
        {canEdit ? (
          <CardFooter>
            <p className="mr-auto flex items-center gap-1.5 text-xs text-fg-subtle">
              <Lock className="size-3.5" aria-hidden /> Changes are recorded in the audit log.
            </p>
            <Button type="submit" loading={update.isPending}>
              Save settings
            </Button>
          </CardFooter>
        ) : null}
      </form>
    </Card>
  );
}
