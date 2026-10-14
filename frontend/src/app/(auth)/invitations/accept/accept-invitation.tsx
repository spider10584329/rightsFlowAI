"use client";

import { Building2, Check, LinkIcon, LogIn, MailX, UserPlus, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { AuthHeading } from "@/components/auth/auth-heading";
import { RoleBadge } from "@/components/shared/role-badge";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { KeyValueList } from "@/components/ui/key-value";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { useLogout, useSessionQuery } from "@/lib/api/hooks/auth";
import {
  useAcceptInvitationToken,
  useDeclineInvitationToken,
  useInvitationPreview,
  useSetActiveOrganization,
} from "@/lib/api/hooks/organizations";
import { ROLE_DESCRIPTIONS, isRole } from "@/lib/roles";
import { formatDate, titleCase } from "@/lib/utils";
import { hardNavigate } from "@/lib/navigation";

export function AcceptInvitation() {
  const token = useSearchParams().get("token") ?? "";
  const preview = useInvitationPreview(token);
  const session = useSessionQuery({ enabled: token.length >= 20 });
  const accept = useAcceptInvitationToken();
  const decline = useDeclineInvitationToken();
  const setActive = useSetActiveOrganization();
  const logout = useLogout();
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  const [joining, setJoining] = useState(false);

  if (token.length < 20) {
    return (
      <AuthHeading
        icon={<LinkIcon aria-hidden />}
        title="This invitation link is incomplete"
        description="Ask the person who invited you to send the link again, or copy it in full from the email."
      />
    );
  }

  if (preview.isLoading || session.isLoading) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading invitation">
        <Skeleton className="h-11 w-11 rounded-xl" />
        <Skeleton className="h-7 w-3/4" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (preview.error || !preview.data) {
    const notFound = isApiError(preview.error) && (preview.error.isNotFound || preview.error.status === 422);
    return (
      <>
        <AuthHeading
          icon={<MailX aria-hidden />}
          title={notFound ? "Invitation not found" : "We couldn't load this invitation"}
          description={notFound ? "This link is invalid, has expired or was revoked." : errorMessage(preview.error)}
        />
        <ButtonLink href="/login" variant="outline" className="w-full">
          Go to sign in
        </ButtonLink>
      </>
    );
  }

  const invitation = preview.data;
  const user = session.data?.user ?? null;
  const nextPath = `/invitations/accept?token=${encodeURIComponent(token)}`;
  const emailMatches = user ? user.email.toLowerCase() === invitation.email.toLowerCase() : false;
  const orgName = invitation.organization_name ?? "an organization";

  if (declined) {
    return <AuthHeading icon={<X aria-hidden />} title="Invitation declined" description={`You won't be added to ${orgName}.`} />;
  }

  if (invitation.status !== "pending") {
    return (
      <>
        <AuthHeading
          icon={<MailX aria-hidden />}
          title={`This invitation was ${invitation.status}`}
          description={
            invitation.status === "accepted"
              ? `It has already been used to join ${orgName}.`
              : "Ask an admin of the organization to send you a new invitation."
          }
        />
        <ButtonLink href={user ? "/dashboard" : "/login"} variant="outline" className="w-full">
          {user ? "Go to dashboard" : "Sign in"}
        </ButtonLink>
      </>
    );
  }

  const onAccept = async () => {
    setError(null);
    setJoining(true);
    try {
      const membership = await accept.mutateAsync(token);
      await setActive.mutateAsync(membership.organization_id).catch(() => undefined);
      hardNavigate("/dashboard");
    } catch (cause) {
      setError(errorMessage(cause));
      setJoining(false);
    }
  };

  const onDecline = () => {
    setError(null);
    decline.mutate(token, {
      onSuccess: () => setDeclined(true),
      onError: (cause) => setError(errorMessage(cause)),
    });
  };

  const switchAccount = async () => {
    await logout.mutateAsync().catch(() => undefined);
    hardNavigate(`/login?next=${encodeURIComponent(nextPath)}&email=${encodeURIComponent(invitation.email)}`);
  };

  return (
    <>
      <AuthHeading
        icon={<Building2 aria-hidden />}
        title={`Join ${orgName}`}
        description="You've been invited to collaborate in RightsFlow."
      />
      <Card className="mb-6">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <Avatar name={orgName} seed={invitation.organization_id} shape="square" size="lg" />
          <div className="min-w-0">
            <p className="truncate font-semibold">{orgName}</p>
            <p className="text-xs text-fg-muted">{isRole(invitation.role) ? ROLE_DESCRIPTIONS[invitation.role] : titleCase(invitation.role)}</p>
          </div>
        </div>
        <div className="px-5 py-1">
          <KeyValueList
            items={[
              { label: "Invited email", value: invitation.email },
              { label: "Role", value: <RoleBadge role={invitation.role} /> },
              { label: "Expires", value: formatDate(invitation.expires_at) },
            ]}
          />
        </div>
        {invitation.message ? <p className="border-t border-border px-5 py-3 text-[13px] italic text-fg-muted">“{invitation.message}”</p> : null}
      </Card>

      {error ? (
        <Alert tone="danger" assertive className="mb-4">
          {error}
        </Alert>
      ) : null}

      {!user ? (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">Sign in or create an account with <span className="font-medium text-fg">{invitation.email}</span> to accept.</p>
          <ButtonLink
            href={`/login?next=${encodeURIComponent(nextPath)}&email=${encodeURIComponent(invitation.email)}`}
            size="lg"
            className="w-full"
            leftIcon={<LogIn aria-hidden />}
          >
            Sign in to accept
          </ButtonLink>
          <ButtonLink
            href={`/register?next=${encodeURIComponent(nextPath)}&email=${encodeURIComponent(invitation.email)}`}
            size="lg"
            variant="outline"
            className="w-full"
            leftIcon={<UserPlus aria-hidden />}
          >
            Create an account
          </ButtonLink>
        </div>
      ) : !emailMatches ? (
        <div className="space-y-3">
          <Alert tone="warning" title="Different account">
            You&apos;re signed in as <span className="font-medium">{user.email}</span>, but this invitation was sent to{" "}
            <span className="font-medium">{invitation.email}</span>.
          </Alert>
          <Button size="lg" className="w-full" onClick={() => void switchAccount()} loading={logout.isPending}>
            Sign in as {invitation.email}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">
            Signed in as <span className="font-medium text-fg">{user.email}</span>
          </p>
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button size="lg" className="flex-1" leftIcon={<Check aria-hidden />} onClick={() => void onAccept()} loading={joining} disabled={decline.isPending}>
              Accept invitation
            </Button>
            <Button size="lg" variant="outline" className="flex-1" onClick={onDecline} loading={decline.isPending} disabled={joining}>
              Decline
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
