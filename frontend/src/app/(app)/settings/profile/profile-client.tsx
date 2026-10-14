"use client";

import { KeyRound, Laptop, LogOut, ShieldCheck, Smartphone } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { PasswordChecklist, PasswordInput } from "@/components/auth/password-input";
import { useSession } from "@/components/session/session-provider";
import { VerifyEmailBanner } from "@/components/shared/verify-email-banner";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors, isApiError } from "@/lib/api/errors";
import {
  useAuthSessions,
  useChangePassword,
  useLogoutEverywhere,
  useNotificationPreferences,
  useRevokeSession,
  useUpdateNotificationPreferences,
  useUpdateProfile,
  type NotificationPreferencesUpdate,
} from "@/lib/api/hooks/auth";
import type { AuthSession, User } from "@/lib/api/types";
import { passwordMeetsRules } from "@/lib/password";
import { formatDate, formatDateTime } from "@/lib/utils";
import { hardNavigate } from "@/lib/navigation";

export function ProfileClient() {
  const { user } = useSession();
  return (
    <>
      <PageHeader
        title="Profile & security"
        description="Your personal details, password and signed-in devices."
        breadcrumbs={[{ label: "Settings" }, { label: "Profile" }]}
      />
      <div className="space-y-6">
        {!user.email_verified ? <VerifyEmailBanner email={user.email} /> : null}
        {/* Keyed by user id so the form resets if another account signs in. */}
        <ProfileForm key={user.id} user={user} />
        <ChangePasswordCard email={user.email} />
        <NotificationPreferencesCard />
        <SessionsCard />
      </div>
    </>
  );
}

function NotificationPreferencesCard() {
  const prefs = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();

  function save(next: NotificationPreferencesUpdate) {
    update.mutate(next, {
      onSuccess: () => toast.success("Email preferences saved"),
      onError: (error) => toast.error("Could not save preferences", { description: errorMessage(error) }),
    });
  }

  const data = prefs.data;
  const current = (enabled: boolean, overrides: Record<string, boolean> = {}): NotificationPreferencesUpdate => ({
    email_enabled: enabled,
    email_types: { ...Object.fromEntries((data?.types ?? []).map((t) => [t.type, t.email])), ...overrides },
  });

  return (
    <Card>
      <CardHeader
        title="Email notifications"
        description="In-app notifications are always kept. Choose which ones are also sent to your inbox."
      />
      <CardBody className="space-y-4">
        {prefs.isPending ? (
          <Skeleton className="h-40" />
        ) : prefs.isError ? (
          <ErrorState error={prefs.error} onRetry={() => void prefs.refetch()} />
        ) : data ? (
          <>
            {data.email_delivery === "console" ? (
              <Alert tone="info" title="Development email mode">
                Emails are written to the server&apos;s dev outbox and are not actually delivered.
              </Alert>
            ) : null}
            <label className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <span>
                <span className="block text-sm font-medium text-fg">Email me about notifications</span>
                <span className="block text-xs text-fg-muted">Master switch for all notification emails.</span>
              </span>
              <Switch
                checked={data.email_enabled}
                disabled={update.isPending}
                onCheckedChange={(checked) => save(current(checked))}
                aria-label="Email me about notifications"
              />
            </label>
            <ul className="divide-y divide-border rounded-md border border-border" aria-label="Notification types">
              {data.types.map((type) => (
                <li key={type.type} className="flex items-center justify-between gap-4 px-3 py-2.5">
                  <span className="text-sm text-fg">
                    {type.label}
                    {type.default ? <span className="ml-2 text-xs text-fg-subtle">(on by default)</span> : null}
                  </span>
                  <Switch
                    checked={type.email && data.email_enabled}
                    disabled={!data.email_enabled || update.isPending}
                    onCheckedChange={(checked) => save(current(data.email_enabled, { [type.type]: checked }))}
                    aria-label={`Email: ${type.label}`}
                  />
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}

function timeZones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

function ProfileForm({ user }: { user: User }) {
  const update = useUpdateProfile();
  const [fullName, setFullName] = useState(user.full_name);
  const [jobTitle, setJobTitle] = useState(user.job_title ?? "");
  const [timezone, setTimezone] = useState(user.timezone ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const zones = useMemo(() => {
    const list = timeZones();
    return timezone && !list.includes(timezone) ? [timezone, ...list] : list;
  }, [timezone]);

  const dirty = fullName !== user.full_name || jobTitle !== (user.job_title ?? "") || timezone !== (user.timezone ?? "");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (fullName.trim().length < 2) nextErrors.full_name = "Enter your full name (at least 2 characters).";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    update.mutate(
      { full_name: fullName.trim(), job_title: jobTitle.trim() || null, timezone: timezone || null },
      {
        onSuccess: () => toast.success("Profile updated"),
        onError: (error) => {
          setErrors(fieldErrors(error));
          toast.error("Could not update profile", { description: errorMessage(error) });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader title="Profile" description="How you appear to teammates in RightsFlow." />
      <form onSubmit={submit} noValidate>
        <CardBody className="grid gap-5 md:grid-cols-2">
          <FormField label="Full name" required error={errors.full_name}>
            <Input value={fullName} onChange={(event) => setFullName(event.target.value)} autoComplete="name" maxLength={255} />
          </FormField>
          <FormField label="Email" hint="Contact support to change your sign-in email.">
            <Input value={user.email} readOnly disabled />
          </FormField>
          <FormField label="Job title" error={errors.job_title}>
            <Input
              value={jobTitle}
              onChange={(event) => setJobTitle(event.target.value)}
              autoComplete="organization-title"
              maxLength={120}
              placeholder="e.g. Head of Royalties"
            />
          </FormField>
          <FormField label="Time zone" error={errors.timezone} hint="Used to display dates and schedule reports.">
            <NativeSelect value={timezone} onChange={(event) => setTimezone(event.target.value)}>
              <option value="">Use browser default</option>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replace(/_/g, " ")}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        </CardBody>
        <CardFooter>
          <p className="mr-auto text-xs text-fg-subtle">Member since {formatDate(user.created_at)}</p>
          <Button type="submit" loading={update.isPending} disabled={!dirty}>
            Save changes
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function ChangePasswordCard({ email }: { email: string }) {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (!current) nextErrors.current_password = "Enter your current password.";
    if (!passwordMeetsRules(next)) nextErrors.new_password = "The new password doesn't meet the requirements.";
    else if (next.toLowerCase() === email.toLowerCase()) nextErrors.new_password = "Password must not equal your email address.";
    else if (next === current) nextErrors.new_password = "Choose a password different from the current one.";
    if (confirm !== next) nextErrors.confirm = "Passwords don't match.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    change.mutate(
      { current_password: current, new_password: next },
      {
        onSuccess: (data) => {
          setCurrent("");
          setNext("");
          setConfirm("");
          toast.success("Password changed", { description: data.message });
        },
        onError: (error) => {
          const fields = fieldErrors(error);
          const isInvalidCurrent = isApiError(error) && error.code === "invalid_password";
          setErrors(isInvalidCurrent ? { current_password: errorMessage(error) } : fields);
          if (!isInvalidCurrent && Object.keys(fields).length === 0) toast.error("Could not change password", { description: errorMessage(error) });
        },
      },
    );
  };

  return (
    <Card>
      <CardHeader
        title="Password"
        description="Changing your password signs out every other device. This browser stays signed in."
      />
      <form onSubmit={submit} noValidate>
        <CardBody className="grid gap-5 md:grid-cols-2">
          <FormField label="Current password" required error={errors.current_password} className="md:col-span-2 md:max-w-[calc(50%-0.625rem)]">
            <PasswordInput value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" />
          </FormField>
          <FormField label="New password" required error={errors.new_password}>
            <PasswordInput value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" maxLength={128} />
          </FormField>
          <FormField label="Confirm new password" required error={errors.confirm}>
            <PasswordInput value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" maxLength={128} />
          </FormField>
          <div className="md:col-span-2">
            <PasswordChecklist password={next} />
          </div>
        </CardBody>
        <CardFooter>
          <Button type="submit" leftIcon={<KeyRound aria-hidden />} loading={change.isPending}>
            Update password
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function describeAgent(userAgent: string | null): { label: string; mobile: boolean } {
  if (!userAgent) return { label: "Unknown device", mobile: false };
  const ua = userAgent;
  const mobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : /curl|python|node|axios|okhttp/i.test(ua)
              ? "API client"
              : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad|iOS/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  return { label: os ? `${browser} on ${os}` : browser, mobile };
}

function SessionsCard() {
  const { signOut } = useSession();
  const sessions = useAuthSessions();
  const revoke = useRevokeSession();
  const logoutAll = useLogoutEverywhere();
  const [pendingRevoke, setPendingRevoke] = useState<AuthSession | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const columns: DataTableColumn<AuthSession>[] = [
    {
      id: "device",
      header: "Device",
      cell: (session) => {
        const agent = describeAgent(session.user_agent);
        const Icon = agent.mobile ? Smartphone : Laptop;
        return (
          <div className="flex items-center gap-3">
            <span className="flex size-8 items-center justify-center rounded-lg bg-surface-2 text-fg-subtle">
              <Icon className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-medium">
                {agent.label}
                {session.is_current ? (
                  <Badge tone="success" dot>
                    This device
                  </Badge>
                ) : null}
              </p>
              <p className="truncate text-xs text-fg-subtle" title={session.user_agent ?? undefined}>
                {session.created_ip ?? "Unknown IP"}
              </p>
            </div>
          </div>
        );
      },
    },
    { id: "created", header: "Signed in", cell: (session) => formatDateTime(session.created_at), hideOnMobile: true },
    { id: "last", header: "Last active", cell: (session) => formatDateTime(session.last_used_at ?? session.created_at) },
    { id: "expires", header: "Expires", cell: (session) => formatDate(session.expires_at), hideOnMobile: true },
  ];

  return (
    <Card>
      <CardHeader
        title="Active sessions"
        description="Devices currently signed in to your account."
        actions={
          <Button variant="outline" size="sm" leftIcon={<LogOut aria-hidden />} onClick={() => setConfirmAll(true)}>
            Sign out everywhere
          </Button>
        }
      />
      <DataTable
        columns={columns}
        data={sessions.data}
        getRowId={(session) => session.id}
        getRowLabel={(session) => describeAgent(session.user_agent).label}
        isLoading={sessions.isLoading}
        error={sessions.error}
        onRetry={() => void sessions.refetch()}
        skeletonRows={2}
        caption="Active sessions"
        rowActions={(session) => [
          {
            label: session.is_current ? "Sign out this device" : "Revoke session",
            icon: <LogOut aria-hidden />,
            destructive: true,
            onSelect: () => setPendingRevoke(session),
          },
        ]}
        emptyState={<p className="px-5 py-8 text-center text-[13px] text-fg-muted">No active sessions.</p>}
      />
      <CardFooter className="justify-start">
        <p className="flex items-center gap-2 text-xs text-fg-subtle">
          <ShieldCheck className="size-3.5" aria-hidden />
          Sessions are stored as secure, httpOnly cookies and refresh automatically.
        </p>
      </CardFooter>

      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => !open && setPendingRevoke(null)}
        title={pendingRevoke?.is_current ? "Sign out of this device?" : "Revoke this session?"}
        description={
          pendingRevoke?.is_current
            ? "You will be signed out of RightsFlow on this browser."
            : "That device will be signed out the next time it contacts RightsFlow."
        }
        confirmLabel={pendingRevoke?.is_current ? "Sign out" : "Revoke"}
        onConfirm={async () => {
          if (!pendingRevoke) return;
          const wasCurrent = pendingRevoke.is_current;
          await revoke.mutateAsync(pendingRevoke.id);
          if (wasCurrent) {
            await signOut();
          } else {
            toast.success("Session revoked");
          }
        }}
      />
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Sign out everywhere?"
        description="Every session, including this one, will be revoked. You'll need to sign in again on all devices."
        confirmLabel="Sign out everywhere"
        onConfirm={async () => {
          await logoutAll.mutateAsync();
          hardNavigate("/login");
        }}
      />
    </Card>
  );
}
