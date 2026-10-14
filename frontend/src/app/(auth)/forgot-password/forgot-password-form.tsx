"use client";

import { ArrowLeft, KeyRound, MailCheck } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";

import { AuthHeading } from "@/components/auth/auth-heading";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/errors";
import { useForgotPassword } from "@/lib/api/hooks/auth";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ForgotPasswordForm() {
  const forgot = useForgotPassword();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentMessage, setSentMessage] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!EMAIL_PATTERN.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    setError(null);
    forgot.mutate(email.trim(), {
      onSuccess: (data) => setSentMessage(data.message),
      onError: (cause) => setError(errorMessage(cause)),
    });
  };

  if (sentMessage) {
    return (
      <>
        <AuthHeading icon={<MailCheck aria-hidden />} title="Check your email" description={sentMessage} />
        <p className="mb-6 text-sm leading-relaxed text-fg-muted">
          The link expires soon and can be used once. If nothing arrives within a few minutes, check your spam folder or try again.
        </p>
        <ButtonLink href="/login" variant="outline" className="w-full" leftIcon={<ArrowLeft aria-hidden />}>
          Back to sign in
        </ButtonLink>
      </>
    );
  }

  return (
    <>
      <AuthHeading icon={<KeyRound aria-hidden />} title="Forgot your password?" description="Enter your account email and we'll send you a reset link." />
      <form onSubmit={submit} className="space-y-5" noValidate>
        {error ? (
          <Alert tone="danger" assertive>
            {error}
          </Alert>
        ) : null}
        <FormField label="Email address" required>
          <Input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} autoFocus />
        </FormField>
        <Button type="submit" size="lg" className="w-full" loading={forgot.isPending}>
          Send reset link
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-fg-muted">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
