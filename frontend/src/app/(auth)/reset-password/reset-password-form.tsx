"use client";

import { CheckCircle2, KeyRound, LinkIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { AuthHeading } from "@/components/auth/auth-heading";
import { PasswordChecklist, PasswordInput } from "@/components/auth/password-input";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { errorMessage, fieldErrors } from "@/lib/api/errors";
import { useResetPassword } from "@/lib/api/hooks/auth";
import { passwordMeetsRules } from "@/lib/password";

export function ResetPasswordForm() {
  const token = useSearchParams().get("token") ?? "";
  const reset = useResetPassword();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (token.length < 20) {
    return (
      <>
        <AuthHeading icon={<LinkIcon aria-hidden />} title="This link is incomplete" description="The password reset link is missing its token or was cut off." />
        <ButtonLink href="/forgot-password" className="w-full">
          Request a new link
        </ButtonLink>
      </>
    );
  }

  if (done) {
    return (
      <>
        <AuthHeading icon={<CheckCircle2 aria-hidden />} title="Password updated" description={done} />
        <ButtonLink href="/login" className="w-full">
          Sign in
        </ButtonLink>
      </>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (!passwordMeetsRules(password)) nextErrors.new_password = "Your password doesn't meet all the requirements.";
    if (confirm !== password) nextErrors.confirm = "Passwords don't match.";
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) return;
    reset.mutate(
      { token, new_password: password },
      {
        onSuccess: (data) => setDone(data.message),
        onError: (error) => {
          const fields = fieldErrors(error);
          setErrors(fields);
          if (Object.keys(fields).length === 0 || fields.token) setFormError(errorMessage(error));
        },
      },
    );
  };

  return (
    <>
      <AuthHeading icon={<KeyRound aria-hidden />} title="Choose a new password" description="Signing in again will be required on all your devices." />
      <form onSubmit={submit} className="space-y-5" noValidate>
        {formError ? (
          <Alert
            tone="danger"
            assertive
            action={
              <ButtonLink href="/forgot-password" size="sm" variant="outline">
                New link
              </ButtonLink>
            }
          >
            {formError}
          </Alert>
        ) : null}
        <FormField label="New password" required error={errors.new_password}>
          <PasswordInput autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} maxLength={128} autoFocus />
        </FormField>
        <FormField label="Confirm new password" required error={errors.confirm}>
          <PasswordInput autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} maxLength={128} />
        </FormField>
        <PasswordChecklist password={password} />
        <Button type="submit" size="lg" className="w-full" loading={reset.isPending}>
          Update password
        </Button>
      </form>
    </>
  );
}
