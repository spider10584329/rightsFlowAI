import type { ReactNode } from "react";

import { OnboardingShell } from "./onboarding-shell";

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <OnboardingShell>{children}</OnboardingShell>;
}
