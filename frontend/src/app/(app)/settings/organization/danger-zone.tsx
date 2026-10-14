"use client";

import { Archive, Crown, DoorOpen } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import { PasswordInput } from "@/components/auth/password-input";
import { useOrg } from "@/components/session/org-provider";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogBody, DialogContent, DialogFooter, DialogHeader, DialogRoot } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { useArchiveOrganization, useLeaveOrganization, useMembers, useTransferOwnership } from "@/lib/api/hooks/organizations";
import type { OrganizationDetail } from "@/lib/api/types";
import { hardNavigate } from "@/lib/navigation";

/** Hard reload into the app so every cache and context is rebuilt. */
function reloadApp() {
  hardNavigate("/dashboard");
}

export function DangerZone({ detail }: { detail: OrganizationDetail }) {
  const { org } = useOrg();
  const isOwner = org.role === "owner";
  const [dialog, setDialog] = useState<"transfer" | "leave" | "archive" | null>(null);
  const leave = useLeaveOrganization(org.id);

  return (
    <Card className="border-danger/30">
      <CardHeader title="Danger zone" description="Irreversible or high-impact actions. Each one is recorded in the audit log." />
      <ul className="divide-y divide-border">
        {isOwner ? (
          <DangerRow
            title="Transfer ownership"
            description="Hand this organization to an admin. You'll become an admin."
            action={
              <Button variant="outline" size="sm" leftIcon={<Crown aria-hidden />} onClick={() => setDialog("transfer")}>
                Transfer
              </Button>
            }
          />
        ) : (
          <DangerRow
            title="Leave organization"
            description="You will lose access to this organization until someone invites you again."
            action={
              <Button variant="outline" size="sm" leftIcon={<DoorOpen aria-hidden />} onClick={() => setDialog("leave")}>
                Leave
              </Button>
            }
          />
        )}
        {isOwner ? (
          <DangerRow
            title="Archive organization"
            description="Deactivates the workspace for every member. Data is retained but becomes inaccessible."
            action={
              <Button variant="danger" size="sm" leftIcon={<Archive aria-hidden />} onClick={() => setDialog("archive")}>
                Archive
              </Button>
            }
          />
        ) : null}
      </ul>

      <ConfirmDialog
        open={dialog === "leave"}
        onOpenChange={(open) => !open && setDialog(null)}
        title={`Leave ${detail.name}?`}
        description="You'll be removed from this organization immediately."
        confirmLabel="Leave organization"
        confirmText={detail.slug}
        onConfirm={async () => {
          await leave.mutateAsync();
          toast.success(`You left ${detail.name}`);
          reloadApp();
        }}
      />
      {isOwner ? <TransferOwnershipDialog open={dialog === "transfer"} onClose={() => setDialog(null)} detail={detail} /> : null}
      {isOwner ? <ArchiveDialog open={dialog === "archive"} onClose={() => setDialog(null)} detail={detail} /> : null}
    </Card>
  );
}

function DangerRow({ title, description, action }: { title: string; description: string; action: ReactNode }) {
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-0.5">
        <p className="text-[13px] font-semibold text-fg">{title}</p>
        <p className="text-xs leading-relaxed text-fg-muted">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </li>
  );
}

function SlugAndPasswordFields({
  slug,
  confirmSlug,
  setConfirmSlug,
  password,
  setPassword,
}: {
  slug: string;
  confirmSlug: string;
  setConfirmSlug: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
}) {
  return (
    <>
      <FormField
        label={
          <>
            Type <span className="rounded bg-surface-2 px-1 py-0.5 font-mono">{slug}</span> to confirm
          </>
        }
        required
      >
        <Input value={confirmSlug} onChange={(event) => setConfirmSlug(event.target.value)} autoComplete="off" spellCheck={false} />
      </FormField>
      <FormField label="Your password" required>
        <PasswordInput value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
      </FormField>
    </>
  );
}

function TransferOwnershipDialog({ open, onClose, detail }: { open: boolean; onClose: () => void; detail: OrganizationDetail }) {
  const members = useMembers(detail.id, false);
  const transfer = useTransferOwnership(detail.id);
  const [target, setTarget] = useState<string | undefined>(undefined);
  const [confirmSlug, setConfirmSlug] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const admins = (members.data ?? []).filter((member) => member.role === "admin" && member.is_active);
  const ready = Boolean(target) && confirmSlug.trim() === detail.slug && password.length > 0;

  const close = () => {
    if (transfer.isPending) return;
    setTarget(undefined);
    setConfirmSlug("");
    setPassword("");
    setError(null);
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !target) return;
    setError(null);
    transfer.mutate(
      { new_owner_membership_id: target, password, confirm_slug: confirmSlug.trim() },
      {
        onSuccess: (membership) => {
          toast.success("Ownership transferred", {
            description: `${membership.user_full_name ?? membership.user_email} is now the owner. You are an admin.`,
          });
          reloadApp();
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  };

  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent size="md">
        <DialogHeader title="Transfer ownership" description="The new owner gets full control, including billing and archiving." />
        <form onSubmit={submit} noValidate>
          <DialogBody className="space-y-4">
            {error ? (
              <Alert tone="danger" assertive>
                {error}
              </Alert>
            ) : null}
            {members.isLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : admins.length === 0 ? (
              <Alert tone="warning" title="No eligible admins">
                Ownership can only go to an active admin. Promote a member to admin on the Team page first.
              </Alert>
            ) : (
              <FormField label="New owner" required hint="Only active admins are eligible.">
                {(props) => (
                  <Select
                    {...props}
                    value={target}
                    onValueChange={setTarget}
                    placeholder="Choose an admin"
                    options={admins.map((member) => ({
                      value: member.id,
                      label: member.user_full_name ?? member.user_email ?? member.id,
                      description: member.user_email ?? undefined,
                    }))}
                  />
                )}
              </FormField>
            )}
            <SlugAndPasswordFields slug={detail.slug} confirmSlug={confirmSlug} setConfirmSlug={setConfirmSlug} password={password} setPassword={setPassword} />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={transfer.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={transfer.isPending} disabled={!ready}>
              Transfer ownership
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}

function ArchiveDialog({ open, onClose, detail }: { open: boolean; onClose: () => void; detail: OrganizationDetail }) {
  const archive = useArchiveOrganization(detail.id);
  const [confirmSlug, setConfirmSlug] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ready = confirmSlug.trim() === detail.slug && password.length > 0;

  const close = () => {
    if (archive.isPending) return;
    setConfirmSlug("");
    setPassword("");
    setError(null);
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setError(null);
    archive.mutate(
      { password, confirm_slug: confirmSlug.trim() },
      {
        onSuccess: () => {
          toast.success(`${detail.name} was archived`);
          reloadApp();
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  };

  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent size="md" role="alertdialog">
        <DialogHeader
          title={`Archive ${detail.name}?`}
          description="All members lose access immediately. Data is retained for compliance but the workspace becomes inactive."
        />
        <form onSubmit={submit} noValidate>
          <DialogBody className="space-y-4">
            {error ? (
              <Alert tone="danger" assertive>
                {error}
              </Alert>
            ) : null}
            <SlugAndPasswordFields slug={detail.slug} confirmSlug={confirmSlug} setConfirmSlug={setConfirmSlug} password={password} setPassword={setPassword} />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={archive.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={archive.isPending} disabled={!ready}>
              Archive organization
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
