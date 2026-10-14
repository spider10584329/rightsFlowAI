import type { Metadata } from "next";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Create your account" };

export default function RegisterPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[30rem] w-full rounded-xl" />}>
      <RegisterForm />
    </Suspense>
  );
}
