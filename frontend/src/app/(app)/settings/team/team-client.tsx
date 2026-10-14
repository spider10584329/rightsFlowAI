"use client";

import { MailPlus, Send, ShieldCheck, Trash2, UserCheck, UserCog, UserX, Users, XCircle } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { useOrg } from "@/components/session/org-provider";
import { useSession } from "@/components/session/session-provider";
import { RoleBadge } from "@/components/shared/role-badge";
import { Avatar } from "@/components/ui/avatar";
import { Badge, statusTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn, type RowAction } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import {
  useChangeMemberRole,
  useInvitations,
  useMembers,
  useRemoveMember,
  useResendInvitation,
  useRevokeInvitation,
  useSetMemberActive,
} from "@/lib/api/hooks/organizations";
import type { AssignableRole, Invitation, InvitationCreated, Membership, Role } from "@/lib/api/types";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/roles";
import { formatDate, titleCase } from "@/lib/utils";

import { InviteDialog } from "./invite-dialog";
import { ResentInvitationDialog } from "./resent-invitation-dialog";

type MemberDialog =
  | { kind: "role"; member: Membership }
  | { kind: "deactivate"; member: Membership }
  | { kind: "reactivate"; member: Membership }
  | { kind: "remove"; member: Membership }
  | null;

const ROLE_FILTERS = ["all", "owner", "admin", "manager", "viewer"] as const;
const INVITATION_FILTERS = ["pending", "all", "accepted", "declined", "revoked", "expired"] as const;

export function TeamClient() {
  const { org, can } = useOrg();
  const { user } = useSession();
  const isAdmin = can("admin");
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = searchParams.get("tab") === "invitations" && isAdmin ? "invitations" : "members";
  const [inviteOpen, setInviteOpen] = useState(false);

  const setTab = (value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "members") params.delete("tab");
    else params.set("tab", value);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <>
      <PageHeader
        title="Team"
        description={`People with access to ${org.name} and what they can do.`}
        breadcrumbs={[{ label: "Admin" }, { label: "Team" }]}
        actions={
          isAdmin ? (
            <Button leftIcon={<MailPlus aria-hidden />} onClick={() => setInviteOpen(true)}>
              Invite member
            </Button>
          ) : null
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="members">
            <Users aria-hidden /> Members
          </TabsTrigger>
          {isAdmin ? (
            <TabsTrigger value="invitations">
              <MailPlus aria-hidden /> Invitations
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="members">
          <MembersPanel orgId={org.id} myRole={org.role} myUserId={user.id} isAdmin={isAdmin} />
        </TabsContent>
        {isAdmin ? (
          <TabsContent value="invitations">
            <InvitationsPanel orgId={org.id} onInvite={() => setInviteOpen(true)} />
          </TabsContent>
        ) : null}
      </Tabs>
      {isAdmin ? <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} orgId={org.id} canAssignAdmin={org.role === "owner"} /> : null}
    </>
  );
}

function assignableRoles(myRole: Role): AssignableRole[] {
  return myRole === "owner" ? ["admin", "manager", "viewer"] : ["manager", "viewer"];
}

/** Mirrors `assert_can_manage` in backend/app/services/organization_service.py. */
function canManage(member: Membership, myRole: Role, myUserId: string): boolean {
  if (member.role === "owner" || member.user_id === myUserId) return false;
  if (myRole === "admin") return member.role !== "admin";
  return myRole === "owner";
}

function MembersPanel({ orgId, myRole, myUserId, isAdmin }: { orgId: string; myRole: Role; myUserId: string; isAdmin: boolean }) {
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<(typeof ROLE_FILTERS)[number]>("all");
  const [dialog, setDialog] = useState<MemberDialog>(null);
  const members = useMembers(orgId, isAdmin && showInactive);
  const setActive = useSetMemberActive(orgId);
  const remove = useRemoveMember(orgId);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (members.data ?? []).filter((member) => {
      if (roleFilter !== "all" && member.role !== roleFilter) return false;
      if (!term) return true;
      return [member.user_full_name, member.user_email].some((value) => value?.toLowerCase().includes(term));
    });
  }, [members.data, search, roleFilter]);

  const columns: DataTableColumn<Membership>[] = [
    {
      id: "member",
      header: "Member",
      cell: (member) => (
        <div className="flex items-center gap-3">
          <Avatar name={member.user_full_name ?? member.user_email} seed={member.user_id} />
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate font-medium">
              {member.user_full_name ?? "Unnamed user"}
              {member.user_id === myUserId ? <Badge tone="primary">You</Badge> : null}
            </p>
            <p className="truncate text-xs text-fg-subtle">{member.user_email}</p>
          </div>
        </div>
      ),
    },
    { id: "role", header: "Role", cell: (member) => <RoleBadge role={member.role} /> },
    {
      id: "status",
      header: "Status",
      cell: (member) =>
        member.is_active ? (
          <Badge tone="success" dot>
            Active
          </Badge>
        ) : (
          <Badge tone="danger" dot>
            Deactivated
          </Badge>
        ),
    },
    { id: "joined", header: "Joined", cell: (member) => formatDate(member.created_at), hideOnMobile: true },
  ];

  const actionsFor = (member: Membership): RowAction[] => {
    if (!isAdmin || !canManage(member, myRole, myUserId)) return [];
    const actions: RowAction[] = [];
    if (member.is_active) {
      actions.push({ label: "Change role", icon: <UserCog aria-hidden />, onSelect: () => setDialog({ kind: "role", member }) });
      actions.push({ label: "Deactivate", icon: <UserX aria-hidden />, onSelect: () => setDialog({ kind: "deactivate", member }) });
    } else {
      actions.push({ label: "Reactivate", icon: <UserCheck aria-hidden />, onSelect: () => setDialog({ kind: "reactivate", member }) });
    }
    actions.push({
      label: "Remove from organization",
      icon: <Trash2 aria-hidden />,
      destructive: true,
      separated: true,
      onSelect: () => setDialog({ kind: "remove", member }),
    });
    return actions;
  };

  const memberName = (member: Membership) => member.user_full_name ?? member.user_email ?? "this member";

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3 md:flex-row md:items-center">
        <SearchInput value={search} onChange={setSearch} placeholder="Search name or email" aria-label="Search members" />
        <Select
          size="sm"
          className="md:w-40"
          aria-label="Filter by role"
          value={roleFilter}
          onValueChange={setRoleFilter}
          options={ROLE_FILTERS.map((value) => ({ value, label: value === "all" ? "All roles" : ROLE_LABELS[value] }))}
        />
        {isAdmin ? (
          <div className="flex items-center gap-2 md:ml-auto">
            <Switch id="show-inactive" checked={showInactive} onCheckedChange={setShowInactive} />
            <Label htmlFor="show-inactive" className="font-normal text-fg-muted">
              Show deactivated
            </Label>
          </div>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        data={members.data ? filtered : undefined}
        getRowId={(member) => member.id}
        getRowLabel={memberName}
        isLoading={members.isLoading}
        isFetching={members.isFetching}
        error={members.error}
        onRetry={() => void members.refetch()}
        rowActions={isAdmin ? actionsFor : undefined}
        caption="Organization members"
        emptyState={
          <EmptyState compact icon={<Users aria-hidden />} title="No members match" description="Try a different search or role filter." />
        }
        footer={
          members.data ? (
            <p className="px-5 py-3 text-xs text-fg-subtle">
              {filtered.length} of {members.data.length} member{members.data.length === 1 ? "" : "s"}
            </p>
          ) : null
        }
      />

      <ChangeRoleDialog
        orgId={orgId}
        member={dialog?.kind === "role" ? dialog.member : null}
        roles={assignableRoles(myRole)}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog?.kind === "deactivate"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Deactivate member?"
        description={dialog ? `${memberName(dialog.member)} will lose access to this organization immediately. You can reactivate them later.` : undefined}
        confirmLabel="Deactivate"
        onConfirm={async () => {
          if (dialog?.kind !== "deactivate") return;
          await setActive.mutateAsync({ membershipId: dialog.member.id, active: false });
          toast.success("Member deactivated");
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === "reactivate"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Reactivate member?"
        description={dialog ? `${memberName(dialog.member)} will regain access with their previous role.` : undefined}
        confirmLabel="Reactivate"
        tone="primary"
        onConfirm={async () => {
          if (dialog?.kind !== "reactivate") return;
          await setActive.mutateAsync({ membershipId: dialog.member.id, active: true });
          toast.success("Member reactivated");
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === "remove"}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Remove member?"
        description={
          dialog
            ? `${memberName(dialog.member)} will be removed from this organization. Their past activity stays in the audit log.`
            : undefined
        }
        confirmLabel="Remove member"
        confirmText={dialog?.kind === "remove" ? (dialog.member.user_email ?? undefined) : undefined}
        onConfirm={async () => {
          if (dialog?.kind !== "remove") return;
          await remove.mutateAsync(dialog.member.id);
          toast.success("Member removed");
        }}
      />
    </Card>
  );
}

function ChangeRoleDialog({
  orgId,
  member,
  roles,
  onClose,
}: {
  orgId: string;
  member: Membership | null;
  roles: AssignableRole[];
  onClose: () => void;
}) {
  const changeRole = useChangeMemberRole(orgId);
  const [role, setRole] = useState<AssignableRole | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);

  // Reset the form whenever a different member is opened.
  if ((member?.id ?? null) !== memberId) {
    setMemberId(member?.id ?? null);
    setRole(member && member.role !== "owner" ? member.role : undefined);
    setError(null);
  }

  const save = () => {
    if (!member || !role) return;
    setError(null);
    changeRole.mutate(
      { membershipId: member.id, role },
      {
        onSuccess: () => {
          toast.success(`Role changed to ${ROLE_LABELS[role]}`);
          onClose();
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  };

  return (
    <Dialog
      open={member !== null}
      onOpenChange={(open) => !open && !changeRole.isPending && onClose()}
      title="Change role"
      description={member ? `Choose what ${member.user_full_name ?? member.user_email} can do in this organization.` : undefined}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={changeRole.isPending}>
            Cancel
          </Button>
          <Button onClick={save} loading={changeRole.isPending} disabled={!role || role === member?.role}>
            Save role
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label="Role" hint={role ? ROLE_DESCRIPTIONS[role] : undefined} error={error ?? undefined}>
          {(props) => (
            <Select
              {...props}
              value={role}
              onValueChange={setRole}
              options={roles.map((value) => ({ value, label: ROLE_LABELS[value], description: ROLE_DESCRIPTIONS[value] }))}
            />
          )}
        </FormField>
        {!roles.includes("admin") ? (
          <p className="flex items-center gap-2 text-xs text-fg-subtle">
            <ShieldCheck className="size-3.5" aria-hidden /> Only the owner can grant the admin role.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function InvitationsPanel({ orgId, onInvite }: { orgId: string; onInvite: () => void }) {
  const [status, setStatus] = useState<(typeof INVITATION_FILTERS)[number]>("pending");
  const invitations = useInvitations(orgId, status === "all" ? undefined : status);
  const revoke = useRevokeInvitation(orgId);
  const resend = useResendInvitation(orgId);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const [resent, setResent] = useState<InvitationCreated | null>(null);

  const resendInvitation = (invitation: Invitation) => {
    resend.mutate(invitation.id, {
      onSuccess: (result) => {
        if (result.email_delivery === "sent" || result.email_delivery === "queued") {
          toast.success("Invitation re-sent", { description: `A new link was emailed to ${result.email}. The previous link no longer works.` });
        } else {
          setResent(result);
        }
      },
      onError: (error) => toast.error("Could not re-send invitation", { description: errorMessage(error) }),
    });
  };

  const columns: DataTableColumn<Invitation>[] = [
    {
      id: "email",
      header: "Email",
      cell: (invitation) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{invitation.email}</p>
          {invitation.message ? <p className="truncate text-xs text-fg-subtle">“{invitation.message}”</p> : null}
        </div>
      ),
    },
    { id: "role", header: "Role", cell: (invitation) => <RoleBadge role={invitation.role} /> },
    {
      id: "status",
      header: "Status",
      cell: (invitation) => (
        <Badge tone={statusTone(invitation.status)} dot>
          {titleCase(invitation.status)}
        </Badge>
      ),
    },
    { id: "sent", header: "Sent", cell: (invitation) => formatDate(invitation.created_at), hideOnMobile: true },
    {
      id: "expires",
      header: "Expires",
      cell: (invitation) => (invitation.status === "pending" ? formatDate(invitation.expires_at) : "—"),
      hideOnMobile: true,
    },
  ];

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <Select
          size="sm"
          className="sm:w-44"
          aria-label="Filter invitations by status"
          value={status}
          onValueChange={setStatus}
          options={INVITATION_FILTERS.map((value) => ({ value, label: value === "all" ? "All invitations" : titleCase(value) }))}
        />
        <p className="text-xs text-fg-subtle">Invitation links are single-use and expire automatically.</p>
      </div>
      <DataTable
        columns={columns}
        data={invitations.data}
        getRowId={(invitation) => invitation.id}
        getRowLabel={(invitation) => invitation.email}
        isLoading={invitations.isLoading}
        isFetching={invitations.isFetching}
        error={invitations.error}
        onRetry={() => void invitations.refetch()}
        caption="Invitations"
        rowActions={(invitation) => {
          const actions: RowAction[] = [];
          if (invitation.status === "pending" || invitation.status === "expired") {
            actions.push({ label: "Re-send with a new link", icon: <Send aria-hidden />, onSelect: () => resendInvitation(invitation) });
          }
          if (invitation.status === "pending") {
            actions.push({ label: "Revoke invitation", icon: <XCircle aria-hidden />, destructive: true, onSelect: () => setRevoking(invitation) });
          }
          return actions;
        }}
        emptyState={
          <EmptyState
            compact
            icon={<MailPlus aria-hidden />}
            title={status === "pending" ? "No pending invitations" : "No invitations"}
            description="Invite teammates to collaborate on your catalog and royalties."
            action={
              <Button size="sm" variant="outline" onClick={onInvite}>
                Invite member
              </Button>
            }
          />
        }
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title="Revoke invitation?"
        description={revoking ? `The invitation link sent to ${revoking.email} will stop working.` : undefined}
        confirmLabel="Revoke"
        onConfirm={async () => {
          if (!revoking) return;
          await revoke.mutateAsync(revoking.id);
          toast.success("Invitation revoked");
        }}
      />
      <ResentInvitationDialog invitation={resent} onClose={() => setResent(null)} />
    </Card>
  );
}
