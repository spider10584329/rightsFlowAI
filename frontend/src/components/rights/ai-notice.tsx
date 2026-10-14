import { Sparkles } from "lucide-react";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { errorMessage, isApiError } from "@/lib/api/errors";
import { cn } from "@/lib/utils";

export const AI_ADVISORY_LABEL = "AI-generated · advisory — verify before relying on it. Not legal advice.";

/** Required label on every piece of AI output. */
export function AiAdvisoryLabel({ className, notice }: { className?: string; notice?: string | null }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs font-medium text-accent-soft-fg", className)}>
      <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        {AI_ADVISORY_LABEL}
        {notice && notice !== AI_ADVISORY_LABEL ? <span className="block font-normal text-fg-subtle">{notice}</span> : null}
      </span>
    </p>
  );
}

/** Explains AI-specific backend errors (provider missing, plan limit, feature disabled). */
export function AiErrorAlert({ error, fallbackHint, className }: { error: unknown; fallbackHint?: string; className?: string }) {
  if (!error) return null;
  const code = isApiError(error) ? error.code : null;
  if (code === "ai_not_configured") {
    return (
      <Alert tone="info" title="AI provider not configured" className={className}>
        No AI provider is configured for this RightsFlow deployment, so AI features are unavailable. {fallbackHint}
      </Alert>
    );
  }
  if (code === "plan_limit_exceeded" || (isApiError(error) && error.status === 402)) {
    return (
      <Alert
        tone="warning"
        title="AI allowance used up"
        className={className}
        action={
          <Link href="/settings/billing" className="font-medium underline underline-offset-2">
            View billing
          </Link>
        }
      >
        {errorMessage(error)}
      </Alert>
    );
  }
  if (code === "ai_contract_analysis_disabled") {
    return (
      <Alert
        tone="info"
        title="AI contract analysis is disabled"
        className={className}
        action={
          <Link href="/settings/organization" className="font-medium underline underline-offset-2">
            Organization settings
          </Link>
        }
      >
        {errorMessage(error)} {fallbackHint}
      </Alert>
    );
  }
  return (
    <Alert tone="danger" title="AI request failed" className={className}>
      {errorMessage(error)}
    </Alert>
  );
}
