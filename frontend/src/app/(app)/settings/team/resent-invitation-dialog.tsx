"use client";

import { CopyButton } from "@/components/shared/copy-button";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogContent, DialogFooter, DialogHeader, DialogRoot } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { InvitationCreated } from "@/lib/api/types";

/**
 * Shown after re-sending an invitation when the email could not be handed to a
 * real mail provider (development outbox or a delivery failure), so the admin
 * can share the fresh one-time link manually.
 */
export function ResentInvitationDialog({
  invitation,
  onClose,
}: {
  invitation: InvitationCreated | null;
  onClose: () => void;
}) {
  return (
    <DialogRoot open={invitation !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md">
        {invitation ? (
          <>
            <DialogHeader
              title="New invitation link"
              description={
                <>
                  A fresh one-time link was created for <span className="font-medium text-fg">{invitation.email}</span>. Earlier links no
                  longer work, and this one won&apos;t be shown again.
                </>
              }
            />
            <DialogBody className="space-y-4">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={invitation.invite_url}
                  readOnly
                  aria-label="Invitation link"
                  className="font-mono text-xs"
                  onFocus={(event) => event.target.select()}
                />
                <CopyButton value={invitation.invite_url} label="Copy link" className="shrink-0" />
              </div>
              {invitation.email_delivery === "logged" ? (
                <Alert tone="warning" title="Email was not sent">
                  This server uses the development email provider, which writes messages to the outbox folder instead of delivering them.
                  Send the link above to the invitee yourself.
                </Alert>
              ) : (
                <Alert tone="danger" title="Email delivery failed">
                  The invitation was renewed, but the email could not be delivered ({invitation.email_delivery}). Share the link manually.
                </Alert>
              )}
            </DialogBody>
            <DialogFooter>
              <Button onClick={onClose}>Done</Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </DialogRoot>
  );
}
