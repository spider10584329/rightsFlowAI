"use client";

import { Info, MailCheck } from "lucide-react";
import { useState, type FormEvent } from "react";

import { CopyButton } from "@/components/shared/copy-button";
import { RoleBadge } from "@/components/shared/role-badge";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogContent, DialogFooter, DialogHeader, DialogRoot } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors } from "@/lib/api/errors";
import { useCreateInvitation } from "@/lib/api/hooks/organizations";
import type { AssignableRole, InvitationCreated } from "@/lib/api/types";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/roles";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InviteDialog({
  open,
  onOpenChange,
  orgId,
  canAssignAdmin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  canAssignAdmin: boolean;
}) {
  const create = useCreateInvitation(orgId);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("viewer");
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<InvitationCreated | null>(null);

  const roles: AssignableRole[] = canAssignAdmin ? ["admin", "manager", "viewer"] : ["manager", "viewer"];

  const reset = () => {
    setEmail("");
    setRole("viewer");
    setMessage("");
    setErrors({});
    setFormError(null);
    setCreated(null);
  };

  const handleOpenChange = (next: boolean) => {
    if (create.isPending) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = email.trim();
    if (!EMAIL_PATTERN.test(trimmed)) {
      setErrors({ email: "Enter a valid email address." });
      return;
    }
    setErrors({});
    setFormError(null);
    create.mutate(
      { email: trimmed, role, message: message.trim() || null },
      {
        onSuccess: (invitation) => {
          // "queued" = handed to the background mailer (SMTP); "sent" = delivered synchronously.
          if (invitation.email_delivery === "sent" || invitation.email_delivery === "queued") {
            toast.success("Invitation sent", { description: `${invitation.email} will receive an email shortly.` });
            reset();
            onOpenChange(false);
          } else {
            setCreated(invitation);
          }
        },
        onError: (error) => {
          const fields = fieldErrors(error);
          setErrors(fields);
          if (Object.keys(fields).length === 0) setFormError(errorMessage(error));
        },
      },
    );
  };

  return (
    <DialogRoot open={open} onOpenChange={handleOpenChange}>
      <DialogContent size="md">
        {created ? (
          <>
            <DialogHeader
              title="Invitation created"
              description={
                <>
                  Share this one-time link with <span className="font-medium text-fg">{created.email}</span>. It won&apos;t be shown again.
                </>
              }
            />
            <DialogBody className="space-y-4">
              <div className="flex items-center gap-2 text-[13px] text-fg-muted">
                Role: <RoleBadge role={created.role} />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input value={created.invite_url} readOnly aria-label="Invitation link" className="font-mono text-xs" onFocus={(event) => event.target.select()} />
                <CopyButton value={created.invite_url} label="Copy link" className="shrink-0" />
              </div>
              {created.email_delivery === "logged" ? (
                <Alert tone="warning" title="Email was not sent">
                  This server uses the development email provider, which writes messages to the outbox folder instead of delivering
                  them. Send the link above to the invitee yourself.
                </Alert>
              ) : (
                <Alert tone="danger" title="Email delivery failed">
                  The invitation exists, but the email could not be delivered ({created.email_delivery}). Share the link manually.
                </Alert>
              )}
            </DialogBody>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  reset();
                }}
              >
                Invite another
              </Button>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader title="Invite a teammate" description="They'll get a link to join this organization with the role you choose." />
            <form onSubmit={submit} noValidate>
              <DialogBody className="space-y-4">
                {formError ? (
                  <Alert tone="danger" assertive>
                    {formError}
                  </Alert>
                ) : null}
                <FormField label="Email address" required error={errors.email}>
                  <Input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="name@company.com"
                    autoComplete="off"
                    autoFocus
                  />
                </FormField>
                <FormField label="Role" required hint={ROLE_DESCRIPTIONS[role]} error={errors.role}>
                  {(props) => (
                    <Select
                      {...props}
                      value={role}
                      onValueChange={setRole}
                      options={roles.map((value) => ({ value, label: ROLE_LABELS[value] }))}
                    />
                  )}
                </FormField>
                <FormField label="Personal message" hint="Optional, up to 500 characters." error={errors.message}>
                  <Textarea value={message} onChange={(event) => setMessage(event.target.value)} maxLength={500} rows={3} />
                </FormField>
                <p className="flex items-start gap-2 text-xs text-fg-subtle">
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  Invitations count toward your plan&apos;s team member limit once accepted.
                </p>
              </DialogBody>
              <DialogFooter>
                <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={create.isPending}>
                  Cancel
                </Button>
                <Button type="submit" leftIcon={<MailCheck aria-hidden />} loading={create.isPending}>
                  Send invitation
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </DialogRoot>
  );
}
