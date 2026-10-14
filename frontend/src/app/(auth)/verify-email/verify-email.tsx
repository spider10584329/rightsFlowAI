"use client";

import { CheckCircle2, LinkIcon, MailWarning } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { AuthHeading } from "@/components/auth/auth-heading";
import { ButtonLink } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api/errors";
import { useVerifyEmail } from "@/lib/api/hooks/auth";

export function VerifyEmail() {
  const token = useSearchParams().get("token") ?? "";
  const verify = useVerifyEmail();
  const { mutate } = verify;
  // Verification tokens are single-use: never submit twice (React dev remounts effects).
  const submitted = useRef<string | null>(null);

  useEffect(() => {
    if (token.length < 20 || submitted.current === token) return;
    submitted.current = token;
    mutate(token);
  }, [token, mutate]);

  if (token.length < 20) {
    return (
      <>
        <AuthHeading icon={<LinkIcon aria-hidden />} title="This link is incomplete" description="The verification link is missing its token or was cut off. Request a new one from your profile." />
        <ButtonLink href="/settings/profile" className="w-full">
          Go to profile
        </ButtonLink>
      </>
    );
  }

  if (verify.isSuccess) {
    return (
      <>
        <AuthHeading
          icon={<CheckCircle2 aria-hidden />}
          title="Email verified"
          description={`Thanks${verify.data.full_name ? `, ${verify.data.full_name.split(" ")[0]}` : ""}. ${verify.data.email} is confirmed.`}
        />
        <ButtonLink href="/dashboard" className="w-full">
          Continue to RightsFlow
        </ButtonLink>
      </>
    );
  }

  if (verify.isError) {
    return (
      <>
        <AuthHeading icon={<MailWarning aria-hidden />} title="We couldn't verify your email" description={errorMessage(verify.error)} />
        <p className="mb-6 text-sm leading-relaxed text-fg-muted">
          Links expire and can only be used once. Sign in and request a new verification email from your profile.
        </p>
        <ButtonLink href="/settings/profile" className="w-full">
          Request a new link
        </ButtonLink>
      </>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 py-10 text-center" role="status">
      <Spinner size="lg" className="text-primary" />
      <p className="text-sm text-fg-muted">Verifying your email address…</p>
    </div>
  );
}
