"use client";

import { CalendarClock, Clock, ListChecks, Play, Power, Settings2, Wrench } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors } from "@/lib/api/errors";
import {
  useDisableAllAutomations,
  useRepairAutomation,
  useRunManagedAutomation,
  useUpdateManagedAutomation,
  type ManagedAutomation,
  type ManagedAutomationOverview,
} from "@/lib/api/hooks/automation";
import { formatDateTime, formatRelative, titleCase } from "@/lib/utils";

import { When } from "./automation-activity";
import {
  HOUR_OPTIONS,
  managedStatusLabel,
  managedStatusTone,
  parseThresholds,
  runOutcomeText,
  runStatusTone,
} from "./automation-format";

// ----------------------------------------------------------------- connection

function ConnectionNotice({ orgId, data }: { orgId: string; data: ManagedAutomationOverview }) {
  const repair = useRepairAutomation(orgId);
  if (!data.available) {
    return (
      <Alert tone="warning" title="Automation isn't set up on this server yet">
        Your RightsFlow administrator connects the automation service once for everyone. Nothing is needed from you; the automations below can be
        switched on as soon as it&apos;s ready.
      </Alert>
    );
  }
  const connection = data.connection;
  if (connection?.status === "error") {
    return (
      <Alert tone="danger" title="Automation needs attention">
        <p>RightsFlow couldn&apos;t finish setting up your automations. It retries by itself; you can also check again now.</p>
        {connection.last_error ? <p className="mt-1 font-mono text-xs">{connection.last_error}</p> : null}
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          leftIcon={<Wrench aria-hidden />}
          loading={repair.isPending}
          onClick={() =>
            repair.mutate(undefined, {
              onSuccess: () => toast.success("Checking the automation connection"),
              onError: (error) => toast.error("Couldn't start the check", { description: errorMessage(error) }),
            })
          }
        >
          Check again
        </Button>
      </Alert>
    );
  }
  if (connection?.status === "provisioning") {
    return (
      <Alert tone="info" title="Setting up automation">
        RightsFlow is preparing your automations. This usually takes a few seconds.
      </Alert>
    );
  }
  return null;
}

// ----------------------------------------------------------------- settings

function settingsSummary(automation: ManagedAutomation, reportTypes: ManagedAutomationOverview["report_types"]): string | null {
  const settings = automation.settings;
  switch (automation.key) {
    case "royalty_import":
      return settings.process_on_upload ? "Processes uploads right away" : "Waits for the schedule after uploads";
    case "contract_expiration":
      return `Reminds ${(settings.thresholds as number[]).join(", ")} days before the end date`;
    case "monthly_reporting":
      return reportTypes.find((type) => type.value === settings.report_type)?.label ?? String(settings.report_type);
    default:
      return null;
  }
}

const INTERVALS: Record<string, readonly number[]> = {
  royalty_import: [15, 30, 60, 120],
  ai_metadata_review: [30, 60, 120, 360],
};

function intervalLabel(minutes: number): string {
  if (minutes < 60) return `Every ${minutes} minutes`;
  return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
}

const DAY_OPTIONS = Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `Day ${i + 1}` }));

export function AutomationSettingsDialog({
  orgId,
  automation,
  reportTypes,
  onClose,
}: {
  orgId: string;
  automation: ManagedAutomation | null;
  reportTypes: ManagedAutomationOverview["report_types"];
  onClose: () => void;
}) {
  return (
    <Dialog
      open={automation !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={automation ? `${automation.label} settings` : "Settings"}
      description="Schedules are in UTC. Changes apply within a few seconds."
    >
      {automation ? <SettingsForm key={automation.key} orgId={orgId} automation={automation} reportTypes={reportTypes} onDone={onClose} /> : null}
    </Dialog>
  );
}

function SettingsForm({
  orgId,
  automation,
  reportTypes,
  onDone,
}: {
  orgId: string;
  automation: ManagedAutomation;
  reportTypes: ManagedAutomationOverview["report_types"];
  onDone: () => void;
}) {
  const update = useUpdateManagedAutomation(orgId);
  const [values, setValues] = useState<Record<string, unknown>>(automation.settings);
  const [thresholds, setThresholds] = useState(Array.isArray(automation.settings.thresholds) ? (automation.settings.thresholds as number[]).join(", ") : "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (field: string, value: unknown) => setValues((current) => ({ ...current, [field]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    let settings = values;
    if (automation.key === "contract_expiration") {
      const parsed = parseThresholds(thresholds);
      if (!parsed) {
        setErrors({ thresholds: "Enter 1 to 5 numbers of days between 1 and 365, separated by commas." });
        return;
      }
      settings = { ...values, thresholds: parsed };
    }
    setErrors({});
    update.mutate(
      { key: automation.key, input: { settings } },
      {
        onSuccess: () => {
          toast.success("Settings saved", { description: `${automation.label} is being updated.` });
          onDone();
        },
        onError: (error) => {
          const fields = fieldErrors(error);
          setErrors(fields);
          if (Object.keys(fields).length === 0) toast.error("Couldn't save settings", { description: errorMessage(error) });
        },
      },
    );
  };

  const hourField = (
    <FormField label="Time of day (UTC)" error={errors.hour_utc}>
      {(props) => (
        <Select {...props} value={String(values.hour_utc)} onValueChange={(value) => set("hour_utc", Number(value))} options={HOUR_OPTIONS} />
      )}
    </FormField>
  );

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {automation.key in INTERVALS ? (
        <FormField label="How often" error={errors.interval_minutes}>
          {(props) => (
            <Select
              {...props}
              value={String(values.interval_minutes)}
              onValueChange={(value) => set("interval_minutes", Number(value))}
              options={INTERVALS[automation.key].map((minutes) => ({ value: String(minutes), label: intervalLabel(minutes) }))}
            />
          )}
        </FormField>
      ) : null}
      {automation.key === "royalty_import" ? (
        <label className="flex items-start justify-between gap-4 rounded-lg border border-border px-4 py-3">
          <span className="space-y-0.5">
            <span className="block text-sm font-medium text-fg">Process uploads right away</span>
            <span className="block text-xs text-fg-muted">Start processing a few seconds after someone uploads a statement instead of waiting for the schedule.</span>
          </span>
          <Switch
            aria-label="Process uploads right away"
            checked={values.process_on_upload === true}
            onCheckedChange={(checked) => set("process_on_upload", checked)}
          />
        </label>
      ) : null}
      {automation.key === "contract_expiration" ? (
        <>
          <FormField label="Remind before the end date (days)" hint="For example 30, 14, 7. One reminder per contract and threshold." error={errors.thresholds}>
            <Input value={thresholds} onChange={(event) => setThresholds(event.target.value)} inputMode="numeric" />
          </FormField>
          {hourField}
        </>
      ) : null}
      {automation.key === "monthly_reporting" ? (
        <>
          <FormField label="Report" error={errors.report_type}>
            {(props) => (
              <Select
                {...props}
                value={String(values.report_type)}
                onValueChange={(value) => set("report_type", value)}
                options={reportTypes.map((type) => ({ value: type.value, label: type.label }))}
              />
            )}
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Day of the month" error={errors.day_of_month}>
              {(props) => (
                <Select {...props} value={String(values.day_of_month)} onValueChange={(value) => set("day_of_month", Number(value))} options={DAY_OPTIONS} />
              )}
            </FormField>
            {hourField}
          </div>
        </>
      ) : null}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={update.isPending}>
          Save settings
        </Button>
      </div>
    </form>
  );
}

// ----------------------------------------------------------------- automation cards

const SETTINGS_KEYS = new Set(["royalty_import", "contract_expiration", "ai_metadata_review", "monthly_reporting"]);

export function AutomationCard({
  orgId,
  automation,
  available,
  reportTypes,
  onEditSettings,
}: {
  orgId: string;
  automation: ManagedAutomation;
  available: boolean;
  reportTypes: ManagedAutomationOverview["report_types"];
  onEditSettings: (automation: ManagedAutomation) => void;
}) {
  const update = useUpdateManagedAutomation(orgId);
  const run = useRunManagedAutomation(orgId);
  const summary = settingsSummary(automation, reportTypes);
  const lastRun = automation.last_run;

  const toggle = (enabled: boolean) =>
    update.mutate(
      { key: automation.key, input: { enabled } },
      {
        onSuccess: () => toast.success(enabled ? `${automation.label} switched on` : `${automation.label} switched off`),
        onError: (error) => toast.error("Couldn't change the automation", { description: errorMessage(error) }),
      },
    );

  const runNow = () =>
    run.mutate(automation.key, {
      onSuccess: () => toast.success(`${automation.label} started`, { description: "The run appears under Runs when it finishes." }),
      onError: (error) => toast.error("Couldn't start the automation", { description: errorMessage(error) }),
    });

  return (
    <Card className="flex flex-col">
      <CardBody className="flex-1 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold tracking-tight text-fg">{automation.label}</h3>
              <Badge tone={managedStatusTone(automation)} dot>
                {managedStatusLabel(automation)}
              </Badge>
            </div>
            <p className="text-[13px] leading-relaxed text-fg-muted">{automation.description}</p>
          </div>
          <Switch
            aria-label={`${automation.label}: ${automation.enabled ? "on" : "off"}`}
            checked={automation.enabled}
            disabled={update.isPending || (!available && !automation.enabled)}
            onCheckedChange={toggle}
          />
        </div>
        <dl className="grid gap-2 text-[13px] sm:grid-cols-2">
          <div className="flex items-center gap-2 text-fg-muted">
            <Clock className="size-4 shrink-0" aria-hidden />
            <dt className="sr-only">Schedule</dt>
            <dd>{automation.schedule.description}</dd>
          </div>
          <div className="flex items-center gap-2 text-fg-muted">
            <CalendarClock className="size-4 shrink-0" aria-hidden />
            <dt>Next run</dt>
            <dd className="text-fg">
              {automation.next_run_at ? (
                <time dateTime={automation.next_run_at} title={formatDateTime(automation.next_run_at)}>
                  {formatRelative(automation.next_run_at)}
                </time>
              ) : (
                "—"
              )}
            </dd>
          </div>
          {summary ? (
            <div className="flex items-center gap-2 text-fg-muted sm:col-span-2">
              <Settings2 className="size-4 shrink-0" aria-hidden />
              <dt className="sr-only">Settings</dt>
              <dd>{summary}</dd>
            </div>
          ) : null}
          <div className="flex items-center gap-2 text-fg-muted sm:col-span-2">
            <ListChecks className="size-4 shrink-0" aria-hidden />
            <dt>Last run</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-2 text-fg">
              {lastRun ? (
                <>
                  <Badge tone={runStatusTone(lastRun.status)}>{titleCase(lastRun.status)}</Badge>
                  <When value={lastRun.finished_at ?? lastRun.started_at} />
                  {runOutcomeText(lastRun) ? <span className="text-fg-muted">· {runOutcomeText(lastRun)}</span> : null}
                </>
              ) : (
                "Not run yet"
              )}
            </dd>
          </div>
        </dl>
        {automation.status === "error" && automation.last_error ? (
          <p className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{automation.last_error}</p>
        ) : null}
      </CardBody>
      <CardFooter className="justify-between">
        {SETTINGS_KEYS.has(automation.key) ? (
          <Button size="sm" variant="ghost" leftIcon={<Settings2 aria-hidden />} onClick={() => onEditSettings(automation)}>
            Settings
          </Button>
        ) : (
          <span />
        )}
        <Button size="sm" variant="outline" leftIcon={<Play aria-hidden />} disabled={!automation.can_run_now} loading={run.isPending} onClick={runNow}>
          Run now
        </Button>
      </CardFooter>
    </Card>
  );
}

export function ManagedAutomationsPanel({
  orgId,
  data,
  isLoading,
  error,
  onRetry,
}: {
  orgId: string;
  data: ManagedAutomationOverview | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const [editing, setEditing] = useState<ManagedAutomation | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const disableAll = useDisableAllAutomations(orgId);

  if (error && !data) {
    return (
      <Card>
        <ErrorState error={error} title="Couldn't load automations" compact onRetry={onRetry} />
      </Card>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="grid gap-4 lg:grid-cols-2" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-56 rounded-xl" />
        ))}
      </div>
    );
  }
  const anyOn = data.automations.some((automation) => automation.enabled);

  return (
    <div className="space-y-4">
      <ConnectionNotice orgId={orgId} data={data} />
      <div className="grid gap-4 lg:grid-cols-2">
        {data.automations.map((automation) => (
          <AutomationCard
            key={automation.key}
            orgId={orgId}
            automation={automation}
            available={data.available}
            reportTypes={data.report_types}
            onEditSettings={setEditing}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-fg-subtle">
        <p>
          RightsFlow runs these automations for you and keeps their connection healthy. Everything they find waits for a person in the review queue.
          {data.connection?.last_reconciled_at ? ` Last checked ${formatRelative(data.connection.last_reconciled_at)}.` : null}
        </p>
        {anyOn ? (
          <Button size="sm" variant="ghost" leftIcon={<Power aria-hidden />} onClick={() => setConfirmOff(true)}>
            Switch everything off
          </Button>
        ) : null}
      </div>
      <AutomationSettingsDialog orgId={orgId} automation={editing} reportTypes={data.report_types} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title="Switch every automation off?"
        description="Scheduled runs stop and uploads are no longer processed automatically. Your data, run history and review queue stay as they are, and you can switch automations on again at any time."
        confirmLabel="Switch everything off"
        onConfirm={async () => {
          await disableAll.mutateAsync();
          toast.success("Automations switched off");
        }}
      />
    </div>
  );
}
