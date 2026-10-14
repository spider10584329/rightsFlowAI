"use client";

import { MailWarning } from "lucide-react";
import type { ReactNode } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { useResendVerification } from "@/lib/api/hooks/auth";

export function VerifyEmailBanner({ email, children }: { email: string; children?: ReactNode }) {
  const resend = useResendVerification();
  return (
    <Alert
      tone="warning"
      title="Verify your email address"
      action={
        <Button
          size="sm"
          variant="outline"
          leftIcon={<MailWarning aria-hidden />}
          loading={resend.isPending}
          onClick={() =>
            resend.mutate(undefined, {
              onSuccess: (data) => toast.success(data.message, { description: `Check ${email} for the verification link.` }),
              onError: (error) => toast.error("Could not resend verification", { description: errorMessage(error) }),
            })
          }
        >
          Resend link
        </Button>
      }
    >
      {children ?? (
        <>
          We sent a verification link to <span className="font-medium">{email}</span>. Some actions may require a verified address.
        </>
      )}
    </Alert>
  );
}
