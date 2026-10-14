"use client";

import { LogIn } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";

import { AuthHeading } from "@/components/auth/auth-heading";
import { PasswordInput } from "@/components/auth/password-input";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { useLogin } from "@/lib/api/hooks/auth";
import { safeNextPath } from "@/lib/auth/constants";

export function LoginForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const login = useLogin();
  const next = safeNextPath(searchParams.get("next"));
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError("Enter your email address and password.");
      return;
    }
    setError(null);
    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => {
          router.replace(next);
          router.refresh();
        },
        onError: (cause) => {
          setPassword("");
          setError(
            isApiError(cause) && cause.status === 429
              ? "Too many sign-in attempts. Please wait a few minutes and try again."
              : errorMessage(cause),
          );
        },
      },
    );
  };

  const registerHref = next !== "/dashboard" ? `/register?next=${encodeURIComponent(next)}` : "/register";

  return (
    <>
      <AuthHeading title="Sign in to RightsFlow" description="Welcome back. Enter your credentials to continue." />
      <form onSubmit={submit} className="space-y-5" noValidate>
        {error ? (
          <Alert tone="danger" assertive>
            {error}
          </Alert>
        ) : null}
        <FormField label="Email address" required>
          <Input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@company.com"
            autoFocus
          />
        </FormField>
        <FormField
          label="Password"
          required
          labelAside={
            <Link href="/forgot-password" className="text-xs font-medium text-primary hover:underline">
              Forgot password?
            </Link>
          }
        >
          <PasswordInput autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </FormField>
        <Button type="submit" size="lg" className="w-full" loading={login.isPending} leftIcon={<LogIn aria-hidden />}>
          Sign in
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-fg-muted">
        New to RightsFlow?{" "}
        <Link href={registerHref} className="font-medium text-primary hover:underline">
          Create an account
        </Link>
      </p>
    </>
  );
}
