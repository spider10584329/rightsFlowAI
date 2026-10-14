"use client";

import { CreditCard, RotateCw, Sparkles } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { AI_ADVISORY_LABEL, describeAiError } from "@/components/ai/errors";
import { entityHref } from "@/components/dashboard/format";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { isApiError } from "@/lib/api/errors";
import { cn, titleCase } from "@/lib/utils";

/** Required label on every AI-generated output. */
export function AdvisoryLabel({ provider, model, className }: { provider?: string | null; model?: string | null; className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-1.5 text-2xs leading-relaxed text-fg-subtle", className)}>
      <Sparkles className="size-3 shrink-0 text-accent" aria-hidden />
      <span>{AI_ADVISORY_LABEL}</span>
      {provider || model ? <span className="text-fg-subtle/80">({[provider, model].filter(Boolean).join(" · ")})</span> : null}
    </p>
  );
}

/** Distinct states for AI failures (not configured / plan limit / provider error / …). */
export function AiErrorAlert({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const info = describeAiError(error);
  const tone =
    info.kind === "not_configured" || info.kind === "provider_config" || info.kind === "limit_reached" || info.kind === "feature_unavailable"
      ? "warning"
      : "danger";
  const requestId = isApiError(error) ? error.requestId : null;
  return (
    <Alert
      tone={tone}
      title={info.title}
      className={className}
      action={
        info.billingLink ? (
          <ButtonLink href="/settings/billing" size="xs" variant="outline" leftIcon={<CreditCard aria-hidden />}>
            Billing
          </ButtonLink>
        ) : info.retryable && onRetry ? (
          <Button size="xs" variant="outline" onClick={onRetry} leftIcon={<RotateCw aria-hidden />}>
            Try again
          </Button>
        ) : null
      }
    >
      <p>{info.message}</p>
      {requestId ? <p className="mt-1 text-2xs opacity-80">Request ID: {requestId}</p> : null}
    </Alert>
  );
}

/** Link to the catalog record behind an AI reference; plain text when there is no page for it. */
export function RecordLink({ entityType, id, children, className }: { entityType: string; id: string; children?: ReactNode; className?: string }) {
  const href = entityHref(entityType, id);
  const content = children ?? id;
  return href ? (
    <Link href={href} className={cn("font-medium text-primary hover:underline", className)}>
      {content}
    </Link>
  ) : (
    <span className={className}>{content}</span>
  );
}

export function EntityBadge({ entityType }: { entityType: string }) {
  return <Badge tone="neutral">{titleCase(entityType)}</Badge>;
}

/** Wraps AI-generated content in a visually distinct, labelled panel. */
export function AiOutput({ children, provider, model, className, title }: { children: ReactNode; provider?: string | null; model?: string | null; className?: string; title?: ReactNode }) {
  return (
    <section className={cn("space-y-3 rounded-lg border border-accent/25 bg-accent-soft/30 p-4", className)} aria-label="AI-generated output">
      {title ? <h3 className="text-sm font-semibold text-fg">{title}</h3> : null}
      {children}
      <AdvisoryLabel provider={provider} model={model} />
    </section>
  );
}

export function ManagerOnlyNotice({ feature }: { feature: string }) {
  return (
    <Alert tone="info" title="Manager role required">
      {feature} sends organization data to the AI provider, so it is limited to managers, admins and owners. Ask one of them to run it.
    </Alert>
  );
}
