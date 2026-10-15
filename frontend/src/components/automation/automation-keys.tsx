"use client";

import { Ban, KeyRound, Plus, RefreshCw, ServerOff, TerminalSquare } from "lucide-react";
import { useState, type FormEvent } from "react";

import { CopyButton } from "@/components/shared/copy-button";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn, type RowAction } from "@/components/ui/data-table";
import { DialogBody, DialogContent, DialogFooter, DialogHeader, DialogRoot } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors } from "@/lib/api/errors";
import {
  DEFAULT_KEY_LIFETIME_DAYS,
  MAX_KEY_LIFETIME_DAYS,
  ROTATION_GRACE_HOURS,
  useAutomationCredentials,
  useAutomationScopes,
  useCreateAutomationCredential,
  useReleaseAutomationInstance,
  useRevokeAutomationCredential,
  useRotateAutomationCredential,
  type AutomationCredential,
} from "@/lib/api/hooks/automation";
import { formatDate, formatDateTime, formatRelative, titleCase } from "@/lib/utils";

import { canReleaseInstance, credentialStateTone, expiryLevelStyle, graceLabel, SETUP_COMMAND, shortInstanceId } from "./automation-format";

/** A freshly issued key. Lives only in the issuing dialog's state. */
interface IssuedKey {
  name: string;
  token: string;
}

// ----------------------------------------------------------------- token-once view

/**
 * Shows a new key exactly once, with copy and the n8n setup next step.
 * Rendered inside a `DialogContent`; the owning dialog clears the token when it closes.
 */
export function IssuedKeyView({ issued, onDone }: { issued: IssuedKey; onDone: () => void }) {
  return (
    <>
      <DialogHeader
        title="Copy your automation key"
        description={
          <>
            Key for <span className="font-medium text-fg">{issued.name}</span>. Store it in n8n now.
          </>
        }
      />
      <DialogBody className="space-y-4">
        <Alert tone="warning" title="This key can't be shown again">
          Only a hash is stored. If you lose it, rotate the key to get a new one.
        </Alert>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={issued.token}
            readOnly
            aria-label="Automation key"
            className="font-mono text-xs"
            spellCheck={false}
            autoComplete="off"
            onFocus={(event) => event.target.select()}
          />
          <CopyButton value={issued.token} label="Copy key" className="shrink-0" />
        </div>
        <section className="space-y-2" aria-labelledby="automation-next-step">
          <h3 id="automation-next-step" className="flex items-center gap-2 text-[13px] font-semibold text-fg">
            <TerminalSquare className="size-4 text-fg-subtle" aria-hidden /> Next step: connect n8n
          </h3>
          <p className="text-[13px] text-fg-muted">
            From the repository root, run this in PowerShell and replace <code className="font-mono text-fg">&lt;key&gt;</code> with the key above:
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <pre className="scrollbar-thin min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-fg" tabIndex={0} aria-label="Setup command">
              {SETUP_COMMAND}
            </pre>
            <CopyButton value={SETUP_COMMAND} label="Copy command" className="shrink-0" />
          </div>
        </section>
      </DialogBody>
      <DialogFooter>
        <Button onClick={onDone}>I&apos;ve stored the key</Button>
      </DialogFooter>
    </>
  );
}

// ----------------------------------------------------------------- create

export function CreateKeyDialog({ open, onOpenChange, orgId }: { open: boolean; onOpenChange: (open: boolean) => void; orgId: string }) {
  const scopes = useAutomationScopes(orgId, { enabled: open });
  const create = useCreateAutomationCredential(orgId);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [days, setDays] = useState(String(DEFAULT_KEY_LIFETIME_DAYS));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedKey | null>(null);

  const allScopes = (scopes.data ?? []).map((item) => item.scope);
  // Default: every scope until the admin changes the selection.
  const selected = picked ?? new Set(allScopes);

  const reset = () => {
    setName("");
    setPicked(null);
    setDays(String(DEFAULT_KEY_LIFETIME_DAYS));
    setErrors({});
    setFormError(null);
    setIssued(null);
    create.reset();
  };

  const handleOpenChange = (next: boolean) => {
    if (create.isPending) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const toggle = (scope: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(scope);
    else next.delete(scope);
    setPicked(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    const lifetime = Number(days);
    const nextErrors: Record<string, string> = {};
    if (trimmed.length < 2 || trimmed.length > 100) nextErrors.name = "Use 2 to 100 characters.";
    if (selected.size === 0) nextErrors.scopes = "Choose at least one scope.";
    if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > MAX_KEY_LIFETIME_DAYS) nextErrors.expires_in_days = `Enter a whole number from 1 to ${MAX_KEY_LIFETIME_DAYS}.`;
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) return;
    try {
      const result = await create.mutateAsync({ name: trimmed, scopes: allScopes.filter((scope) => selected.has(scope)), expires_in_days: lifetime });
      setIssued({ name: result.credential.name, token: result.token });
      toast.success("Automation key created");
    } catch (error) {
      const fields = fieldErrors(error);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setFormError(errorMessage(error));
    }
  };

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      {/* While the key is visible, an outside click must not discard it by accident. */}
      <DialogContent size="lg" onInteractOutside={issued ? (event) => event.preventDefault() : undefined}>
        {issued ? (
          <IssuedKeyView issued={issued} onDone={() => handleOpenChange(false)} />
        ) : (
          <>
            <DialogHeader title="Create automation key" description="n8n uses this key to call RightsFlow for this organization. Grant only the scopes your workflows need." />
            <form onSubmit={(event) => void submit(event)} noValidate>
              <DialogBody className="space-y-4">
                {formError ? (
                  <Alert tone="danger" assertive>
                    {formError}
                  </Alert>
                ) : null}
                <FormField label="Name" required error={errors.name} hint="For example “n8n production”.">
                  <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} autoComplete="off" autoFocus />
                </FormField>
                <fieldset className="space-y-2" aria-describedby={errors.scopes ? "automation-scopes-error" : undefined}>
                  <div className="flex items-center justify-between gap-3">
                    <legend className="text-[13px] font-medium text-fg">
                      Scopes<span className="ml-0.5 text-danger" aria-hidden="true">*</span>
                    </legend>
                    {allScopes.length > 0 ? (
                      <div className="flex gap-1">
                        <Button variant="ghost" size="xs" onClick={() => setPicked(new Set(allScopes))}>
                          Select all
                        </Button>
                        <Button variant="ghost" size="xs" onClick={() => setPicked(new Set())}>
                          Clear
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  {scopes.isLoading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 4 }, (_, index) => (
                        <Skeleton key={index} className="h-8 w-full" />
                      ))}
                    </div>
                  ) : scopes.error ? (
                    <ErrorState error={scopes.error} title="Couldn't load scopes" compact onRetry={() => void scopes.refetch()} retrying={scopes.isFetching} />
                  ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {(scopes.data ?? []).map((item) => {
                        const id = `scope-${item.scope.replace(/[^a-z0-9]+/gi, "-")}`;
                        return (
                          <li key={item.scope} className="flex items-start gap-3 px-3 py-2">
                            <Checkbox id={id} className="mt-0.5" checked={selected.has(item.scope)} onCheckedChange={(value) => toggle(item.scope, value === true)} />
                            <label htmlFor={id} className="min-w-0 cursor-pointer">
                              <span className="block font-mono text-xs text-fg">{item.scope}</span>
                              <span className="block text-xs text-fg-subtle">{item.description}</span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {errors.scopes ? (
                    <p id="automation-scopes-error" role="alert" className="text-xs font-medium text-danger">
                      {errors.scopes}
                    </p>
                  ) : null}
                </fieldset>
                <FormField label="Expires after (days)" required error={errors.expires_in_days} hint={`1 to ${MAX_KEY_LIFETIME_DAYS} days. Rotate the key before it expires.`}>
                  <Input type="number" inputMode="numeric" min={1} max={MAX_KEY_LIFETIME_DAYS} step={1} value={days} onChange={(event) => setDays(event.target.value)} className="sm:w-32" />
                </FormField>
              </DialogBody>
              <DialogFooter>
                <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={create.isPending}>
                  Cancel
                </Button>
                <Button type="submit" leftIcon={<KeyRound aria-hidden />} loading={create.isPending} disabled={!scopes.data}>
                  Create key
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </DialogRoot>
  );
}

// ----------------------------------------------------------------- rotate

export function RotateKeyDialog({ orgId, credential, onClose }: { orgId: string; credential: AutomationCredential | null; onClose: () => void }) {
  const rotate = useRotateAutomationCredential(orgId);
  const [grace, setGrace] = useState("24");
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [forId, setForId] = useState<string | null>(null);

  // Fresh form (and no leftover key) whenever a different credential is opened.
  if ((credential?.id ?? null) !== forId) {
    setForId(credential?.id ?? null);
    setGrace("24");
    setError(null);
    setIssued(null);
  }

  const close = () => {
    if (rotate.isPending) return;
    setIssued(null);
    setError(null);
    rotate.reset();
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!credential) return;
    setError(null);
    try {
      const result = await rotate.mutateAsync({ credentialId: credential.id, graceHours: Number(grace) });
      setIssued({ name: result.credential.name, token: result.token });
      toast.success("Automation key rotated");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <DialogRoot open={credential !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent size={issued ? "lg" : "md"} onInteractOutside={issued ? (event) => event.preventDefault() : undefined}>
        {issued ? (
          <IssuedKeyView issued={issued} onDone={close} />
        ) : (
          <>
            <DialogHeader
              title="Rotate automation key"
              description={credential ? `Issue a replacement for “${credential.name}”. The new key has the same scopes and lifetime.` : undefined}
            />
            <form onSubmit={(event) => void submit(event)}>
              <DialogBody className="space-y-4">
                {error ? (
                  <Alert tone="danger" assertive>
                    {error}
                  </Alert>
                ) : null}
                <FormField label="Old key stops working" hint="Keep the old key valid long enough to update n8n with the new one.">
                  {(props) => (
                    <Select
                      {...props}
                      value={grace}
                      onValueChange={setGrace}
                      options={ROTATION_GRACE_HOURS.map((hours) => ({ value: String(hours), label: graceLabel(hours) }))}
                    />
                  )}
                </FormField>
              </DialogBody>
              <DialogFooter>
                <Button variant="outline" onClick={close} disabled={rotate.isPending}>
                  Cancel
                </Button>
                <Button type="submit" leftIcon={<RefreshCw aria-hidden />} loading={rotate.isPending}>
                  Rotate key
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </DialogRoot>
  );
}

// ----------------------------------------------------------------- expiry & instance

/** Expiry level from the backend: neutral when fine, warning/critical/expired increasingly loud. */
export function ExpiryBadge({ level }: { level: AutomationCredential["expiry_level"] }) {
  const style = expiryLevelStyle(level);
  return (
    <Badge tone={style.tone} dot={style.attention} className={style.className}>
      {style.label}
    </Badge>
  );
}

function InstanceCell({ credential }: { credential: AutomationCredential }) {
  const instance = shortInstanceId(credential.bound_instance);
  if (!instance) return <span className="text-fg-subtle">Not bound</span>;
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs text-fg" title={credential.instance_bound_at ? `Bound ${formatDateTime(credential.instance_bound_at)}` : undefined}>
          {instance}
        </span>
        {credential.instance_stale ? (
          <Badge tone="warning" title="This n8n instance has not used the key recently">
            Stale
          </Badge>
        ) : null}
      </div>
      <p className="whitespace-nowrap text-2xs text-fg-subtle">
        {credential.instance_last_seen_at ? (
          <>
            Last seen{" "}
            <time dateTime={credential.instance_last_seen_at} title={formatDateTime(credential.instance_last_seen_at)}>
              {formatRelative(credential.instance_last_seen_at)}
            </time>
          </>
        ) : (
          "Not seen yet"
        )}
      </p>
    </div>
  );
}

/** Confirmation for releasing a key's n8n instance binding (admin recovery). */
export function ReleaseInstanceDialog({ orgId, credential, onClose }: { orgId: string; credential: AutomationCredential | null; onClose: () => void }) {
  const release = useReleaseAutomationInstance(orgId);
  return (
    <ConfirmDialog
      open={credential !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Release n8n instance?"
      description={
        credential ? (
          <>
            “{credential.name}” is bound to n8n instance <span className="font-mono">{shortInstanceId(credential.bound_instance)}</span>.
          </>
        ) : undefined
      }
      confirmLabel="Release instance"
      onConfirm={async () => {
        if (!credential) return;
        await release.mutateAsync(credential.id);
        toast.success("Instance released", { description: "The next n8n instance that uses this key will bind to it." });
      }}
    >
      <Alert tone="warning" title="Only do this if the old n8n instance is gone">
        For example after its data folder was reset or moved. The next n8n instance that uses the key will bind to it. If the old instance may still be
        running, rotate the key instead.
      </Alert>
    </ConfirmDialog>
  );
}

// ----------------------------------------------------------------- list

function ScopesCell({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) return <span className="text-fg-subtle">—</span>;
  const shown = scopes.slice(0, 2);
  return (
    <div className="flex max-w-xs flex-wrap gap-1" title={scopes.join(", ")}>
      {shown.map((scope) => (
        <Badge key={scope} className="font-mono">
          {scope}
        </Badge>
      ))}
      {scopes.length > shown.length ? (
        <Badge tone="primary">
          +{scopes.length - shown.length}
          <span className="sr-only"> more: {scopes.slice(2).join(", ")}</span>
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * Hand-made automation keys. With `legacy` (managed mode, where RightsFlow
 * issues and rotates its own keys) only keys someone created by hand are listed,
 * and they can only be revoked: nothing new is created here.
 */
export function KeysPanel({ orgId, legacy = false }: { orgId: string; legacy?: boolean }) {
  const credentials = useAutomationCredentials(orgId);
  const rows = legacy ? credentials.data?.filter((credential) => !credential.managed) : credentials.data;
  const revoke = useRevokeAutomationCredential(orgId);
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<AutomationCredential | null>(null);
  const [revoking, setRevoking] = useState<AutomationCredential | null>(null);
  const [releasing, setReleasing] = useState<AutomationCredential | null>(null);
  const [reason, setReason] = useState("");

  const columns: DataTableColumn<AutomationCredential>[] = [
    {
      id: "name",
      header: "Name",
      cell: (credential) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{credential.name}</p>
          <p className="truncate font-mono text-2xs text-fg-subtle">{credential.key_hint}</p>
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      cell: (credential) => (
        <div className="space-y-1">
          <Badge tone={credentialStateTone(credential.state)} dot>
            {titleCase(credential.state)}
          </Badge>
          {credential.rotated_from_id ? <p className="text-2xs text-fg-subtle">Rotated key</p> : null}
        </div>
      ),
    },
    { id: "scopes", header: "Scopes", hideOnMobile: true, cell: (credential) => <ScopesCell scopes={credential.scopes} /> },
    {
      id: "expires",
      header: "Expires",
      cell: (credential) =>
        credential.state === "revoked" ? (
          <span className="whitespace-nowrap text-fg-muted" title={credential.revoked_reason ?? undefined}>
            Revoked {formatDate(credential.revoked_at)}
          </span>
        ) : (
          <div className="space-y-1">
            <span className="block whitespace-nowrap text-fg-muted" title={formatDateTime(credential.expires_at)}>
              {credential.expires_at ? formatDate(credential.expires_at) : "Never"}
            </span>
            <ExpiryBadge level={credential.expiry_level} />
          </div>
        ),
    },
    { id: "instance", header: "n8n instance", cell: (credential) => <InstanceCell credential={credential} /> },
    {
      id: "last_used",
      header: "Last used",
      hideOnMobile: true,
      cell: (credential) =>
        credential.last_used_at ? (
          <time dateTime={credential.last_used_at} title={formatDateTime(credential.last_used_at)} className="whitespace-nowrap text-fg-muted">
            {formatRelative(credential.last_used_at)}
          </time>
        ) : (
          <span className="text-fg-subtle">Never</span>
        ),
    },
    { id: "created", header: "Created", hideOnMobile: true, cell: (credential) => <span className="whitespace-nowrap text-fg-muted">{formatDate(credential.created_at)}</span> },
  ];

  const rowActions = (credential: AutomationCredential): RowAction[] => {
    const actions: RowAction[] = [];
    if (!legacy && credential.state === "active") actions.push({ label: "Rotate key", icon: <RefreshCw aria-hidden />, onSelect: () => setRotating(credential) });
    if (!legacy && canReleaseInstance(credential)) actions.push({ label: "Release instance", icon: <ServerOff aria-hidden />, onSelect: () => setReleasing(credential) });
    if (credential.state !== "revoked") {
      actions.push({ label: "Revoke key", icon: <Ban aria-hidden />, destructive: true, separated: actions.length > 0, onSelect: () => setRevoking(credential) });
    }
    return actions;
  };

  return (
    <Card>
      {legacy ? (
        <CardHeader
          title="Keys created by hand"
          description="Keys from an earlier, hand-made n8n setup. RightsFlow now connects automation itself and doesn't use them; revoke the ones nothing needs anymore."
        />
      ) : (
        <CardHeader
          title="Automation keys"
          description="API keys n8n uses to call RightsFlow. Keys are scoped to this organization and shown only once."
          actions={
            <Button size="sm" leftIcon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
              Create key
            </Button>
          }
        />
      )}
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(credential) => credential.id}
        getRowLabel={(credential) => credential.name}
        isLoading={credentials.isLoading}
        isFetching={credentials.isFetching}
        error={credentials.error}
        onRetry={() => void credentials.refetch()}
        rowActions={rowActions}
        caption="Automation keys"
        emptyState={
          legacy ? (
            <EmptyState compact icon={<KeyRound aria-hidden />} title="No keys created by hand" description="Nothing to clean up." />
          ) : (
            <EmptyState
              compact
              icon={<KeyRound aria-hidden />}
              title="No automation keys yet"
              description="Create a key, then run the n8n setup script with it."
              action={
                <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
                  Create key
                </Button>
              }
            />
          )
        }
      />
      <CreateKeyDialog open={creating} onOpenChange={setCreating} orgId={orgId} />
      <RotateKeyDialog orgId={orgId} credential={rotating} onClose={() => setRotating(null)} />
      <ReleaseInstanceDialog orgId={orgId} credential={releasing} onClose={() => setReleasing(null)} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevoking(null);
            setReason("");
          }
        }}
        title="Revoke automation key?"
        description={revoking ? `Workflows using “${revoking.name}” will stop working immediately. This can't be undone.` : undefined}
        confirmLabel="Revoke key"
        onConfirm={async () => {
          if (!revoking) return;
          await revoke.mutateAsync({ credentialId: revoking.id, reason });
          toast.success("Automation key revoked");
        }}
      >
        <FormField label="Reason" hint="Optional. Recorded in the audit log.">
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} rows={2} />
        </FormField>
      </ConfirmDialog>
    </Card>
  );
}
