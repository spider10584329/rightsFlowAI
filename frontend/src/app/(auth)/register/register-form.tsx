"use client";

import { UserPlus } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

import { AuthHeading } from "@/components/auth/auth-heading";
import { PasswordChecklist, PasswordInput } from "@/components/auth/password-input";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { errorMessage, fieldErrors } from "@/lib/api/errors";
import { useRegister } from "@/lib/api/hooks/auth";
import { safeNextPath } from "@/lib/auth/constants";
import { passwordMeetsRules } from "@/lib/password";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function RegisterForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const register = useRegister();
  const checklistId = useId();
  const next = safeNextPath(searchParams.get("next"), "/onboarding");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (fullName.trim().length < 2) nextErrors.full_name = "Enter your full name.";
    if (!EMAIL_PATTERN.test(email.trim())) nextErrors.email = "Enter a valid email address.";
    if (!passwordMeetsRules(password)) nextErrors.password = "Your password doesn't meet all the requirements below.";
    else if (password.toLowerCase() === email.trim().toLowerCase()) nextErrors.password = "Password must not equal your email address.";
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length > 0) return;

    register.mutate(
      { full_name: fullName.trim(), email: email.trim(), password },
      {
        onSuccess: () => {
          router.replace(next);
          router.refresh();
        },
        onError: (error) => {
          const fields = fieldErrors(error);
          setErrors(fields);
          if (Object.keys(fields).length === 0) setFormError(errorMessage(error));
        },
      },
    );
  };

  const loginHref = searchParams.get("next") ? `/login?next=${encodeURIComponent(next)}` : "/login";

  return (
    <>
      <AuthHeading title="Create your account" description="Start managing your catalog and royalties in minutes." />
      <form onSubmit={submit} className="space-y-5" noValidate>
        {formError ? (
          <Alert tone="danger" assertive>
            {formError}
          </Alert>
        ) : null}
        <FormField label="Full name" required error={errors.full_name}>
          <Input autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} maxLength={255} autoFocus />
        </FormField>
        <FormField label="Work email" required error={errors.email}>
          <Input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@company.com" />
        </FormField>
        <FormField label="Password" required error={errors.password}>
          {(props) => (
            <PasswordInput
              {...props}
              aria-describedby={[props["aria-describedby"], checklistId].filter(Boolean).join(" ")}
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              maxLength={128}
            />
          )}
        </FormField>
        <PasswordChecklist password={password} id={checklistId} />
        <Button type="submit" size="lg" className="w-full" loading={register.isPending} leftIcon={<UserPlus aria-hidden />}>
          Create account
        </Button>
        <p className="text-center text-xs leading-relaxed text-fg-subtle">
          We&apos;ll email you a link to verify your address.
        </p>
      </form>
      <p className="mt-8 text-center text-sm text-fg-muted">
        Already have an account?{" "}
        <Link href={loginHref} className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
