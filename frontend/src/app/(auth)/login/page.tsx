import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <Suspense fallback={<Skeleton className="h-80 w-full rounded-xl" />}>
      <LoginForm />
    </Suspense>
  );
}
