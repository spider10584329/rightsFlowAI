"use client";

import { ArrowRight, Building2, Check, MailOpen, X } from "lucide-react";
import { useState, type FormEvent } from "react";

import { useSession } from "@/components/session/session-provider";
import { RoleBadge } from "@/components/shared/role-badge";
import { VerifyEmailBanner } from "@/components/shared/verify-email-banner";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors } from "@/lib/api/errors";
import {
  useAcceptInvitationById,
  useCreateOrganization,
  useDeclineInvitationById,
  useMyInvitations,
  useOrganizations,
  useSetActiveOrganization,
} from "@/lib/api/hooks/organizations";
import { useCurrencyCodes } from "@/lib/api/hooks/reference";
import type { Invitation } from "@/lib/api/types";
import { formatDate, slugify } from "@/lib/utils";
import { hardNavigate } from "@/lib/navigation";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function enterApp() {
  hardNavigate("/dashboard");
}

export function OnboardingClient() {
  const { user } = useSession();
  const organizations = useOrganizations();
  // Listing invitations by address requires a verified email (audit A-01);
  // unverified users can still join through the emailed invitation link.
  const invitations = useMyInvitations({ enabled: user.email_verified });
  const firstName = user.full_name.split(/\s+/)[0] ?? user.full_name;
  const hasOrgs = (organizations.data?.length ?? 0) > 0;

  return (
    <div className="space-y-8">
      <div className="space-y-2 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Workspace setup</p>
        <h1 className="text-3xl font-semibold tracking-tight text-fg">Welcome, {firstName}</h1>
        <p className="mx-auto max-w-xl text-sm leading-relaxed text-fg-muted">
          RightsFlow organizes catalogs, rights and royalties by organization. Create one for your company, or join a team that invited you.
        </p>
      </div>

      {hasOrgs ? (
        <Alert
          tone="info"
          action={
            <ButtonLink href="/dashboard" size="sm" variant="outline" rightIcon={<ArrowRight aria-hidden />}>
              Go to dashboard
            </ButtonLink>
          }
        >
          You already belong to {organizations.data?.length} organization{organizations.data?.length === 1 ? "" : "s"}. You can still create another one.
        </Alert>
      ) : null}

      {!user.email_verified ? (
        <VerifyEmailBanner email={user.email}>
          Verify <span className="font-medium">{user.email}</span> to see invitations sent to it here. Invitation links in your email work without verifying first.
        </VerifyEmailBanner>
      ) : invitations.isLoading ? (
        <Skeleton className="h-28 w-full rounded-xl" />
      ) : invitations.data && invitations.data.length > 0 ? (
        <PendingInvitations invitations={invitations.data} />
      ) : null}

      <CreateOrganizationCard />
    </div>
  );
}

function PendingInvitations({ invitations }: { invitations: Invitation[] }) {
  const accept = useAcceptInvitationById();
  const decline = useDeclineInvitationById();
  const setActive = useSetActiveOrganization();
  const [busyId, setBusyId] = useState<string | null>(null);

  const onAccept = async (invitation: Invitation) => {
    setBusyId(invitation.id);
    try {
      const membership = await accept.mutateAsync(invitation.id);
      await setActive.mutateAsync(membership.organization_id).catch(() => undefined);
      toast.success(`You joined ${invitation.organization_name ?? "the organization"}`);
      enterApp();
    } catch (error) {
      toast.error("Could not accept invitation", { description: errorMessage(error) });
      setBusyId(null);
    }
  };

  const onDecline = async (invitation: Invitation) => {
    setBusyId(invitation.id);
    try {
      await decline.mutateAsync(invitation.id);
      toast.success("Invitation declined");
    } catch (error) {
      toast.error("Could not decline invitation", { description: errorMessage(error) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader title="Pending invitations" description="Teams that invited you to collaborate." />
      <ul className="divide-y divide-border">
        {invitations.map((invitation) => (
          <li key={invitation.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-fg">
                <MailOpen className="size-4" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  {invitation.organization_name ?? "An organization"} <RoleBadge role={invitation.role} />
                </p>
                <p className="text-xs text-fg-subtle">Expires {formatDate(invitation.expires_at)}</p>
                {invitation.message ? <p className="mt-1 text-[13px] text-fg-muted">“{invitation.message}”</p> : null}
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                leftIcon={<X aria-hidden />}
                disabled={busyId !== null}
                loading={busyId === invitation.id && decline.isPending}
                onClick={() => void onDecline(invitation)}
              >
                Decline
              </Button>
              <Button
                size="sm"
                leftIcon={<Check aria-hidden />}
                disabled={busyId !== null}
                loading={busyId === invitation.id && !decline.isPending}
                onClick={() => void onAccept(invitation)}
              >
                Accept
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CreateOrganizationCard() {
  const create = useCreateOrganization();
  const setActive = useSetActiveOrganization();
  const currencies = useCurrencyCodes();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [currency, setCurrency] = useState("USD");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const effectiveSlug = slugEdited ? slug : slugify(name);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (name.trim().length < 2) nextErrors.name = "Enter at least 2 characters.";
    if (effectiveSlug.length < 3 || !SLUG_PATTERN.test(effectiveSlug)) {
      nextErrors.slug = "Use 3–100 lowercase letters, numbers and single hyphens.";
    }
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      const org = await create.mutateAsync({ name: name.trim(), slug: effectiveSlug, default_currency: currency });
      await setActive.mutateAsync(org.id).catch(() => undefined);
      toast.success(`${org.name} is ready`);
      enterApp();
    } catch (error) {
      const fields = fieldErrors(error);
      setErrors(fields);
      if (Object.keys(fields).length === 0) setFormError(errorMessage(error));
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Building2 className="size-4 text-primary" aria-hidden /> Create an organization
          </span>
        }
        description="You'll be the owner. You can invite teammates right after."
      />
      <form onSubmit={submit} noValidate>
        <CardBody className="space-y-5">
          {formError ? (
            <Alert tone="danger" assertive>
              {formError}
            </Alert>
          ) : null}
          <FormField label="Organization name" required error={errors.name} hint="Your publishing company, label or administration business.">
            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={255} placeholder="e.g. Northbound Music Publishing" autoFocus />
          </FormField>
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_10rem]">
            <FormField label="URL slug" required error={errors.slug} hint="Unique identifier used in links and exports.">
              <Input
                value={effectiveSlug}
                onChange={(event) => {
                  setSlugEdited(true);
                  setSlug(event.target.value.toLowerCase());
                }}
                maxLength={100}
                spellCheck={false}
                className="font-mono"
              />
            </FormField>
            <FormField label="Currency" required error={errors.default_currency}>
              {(props) => (
                <Select {...props} value={currency} onValueChange={setCurrency} options={currencies.map((code) => ({ value: code, label: code }))} />
              )}
            </FormField>
          </div>
        </CardBody>
        <CardFooter>
          <Button type="submit" loading={submitting} rightIcon={<ArrowRight aria-hidden />}>
            Create organization
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
