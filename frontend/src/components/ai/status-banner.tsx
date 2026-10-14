"use client";

import { AlertTriangle, Bot, CheckCircle2, CircleSlash, KeyRound, PlugZap } from "lucide-react";

import { AI_NOT_CONFIGURED_HELP } from "@/components/ai/errors";
import { formatUsd } from "@/components/billing/usage";
import { UsageMeter } from "@/components/billing/usage-meter";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { AIStatus } from "@/lib/api/hooks/ai";
import { formatRelative } from "@/lib/utils";

type Connectivity = AIStatus["connectivity"];

/** "Configured" only means settings exist; the badge reflects whether the provider actually answered. */
export function connectivityBadge(connectivity: Connectivity): { title: string; label: string; tone: "success" | "neutral" | "danger" } {
  if (connectivity.state === "verified") return { title: "AI assistant ready", label: "Connected", tone: "success" };
  if (connectivity.state === "failing") return { title: "AI provider not working", label: "Not working", tone: "danger" };
  return { title: "AI assistant configured", label: "Configured · not yet verified", tone: "neutral" };
}

export const DETERMINISTIC_TOOLS: { tab: string; label: string; description: string }[] = [
  { tab: "suggestions", label: "Suggestion review", description: "Approve or reject queued suggestions." },
  { tab: "duplicates", label: "Duplicate candidates", description: "Rule-based duplicate detection." },
  { tab: "anomalies", label: "Royalty anomalies", description: "Rate outliers and period swings." },
  { tab: "completeness", label: "Metadata completeness", description: "Missing identifiers and links." },
  { tab: "usage", label: "Usage log", description: "Past AI requests and costs." },
];

export function AiStatusBanner({
  status,
  isLoading,
  error,
  onRetry,
  onOpenTab,
  canCheck = false,
  checking = false,
  onCheckConnection,
}: {
  status: AIStatus | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  onOpenTab: (tab: string) => void;
  /** Admins can send one minimal real request to verify the provider. */
  canCheck?: boolean;
  checking?: boolean;
  onCheckConnection?: () => void;
}) {
  if (isLoading) return <Skeleton className="h-28 rounded-xl" />;
  if (error || !status) {
    return (
      <Card>
        <ErrorState error={error} onRetry={onRetry} compact title="Couldn't load AI status" />
      </Card>
    );
  }

  if (!status.configured) {
    return (
      <Card className="overflow-hidden border-warning/30">
        <div className="flex flex-col gap-4 bg-warning-soft/50 px-5 py-4 md:flex-row md:items-start">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-warning-soft text-warning-soft-fg">
            <KeyRound className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="text-[15px] font-semibold text-fg">AI provider not configured</h2>
            <p className="text-[13px] leading-relaxed text-fg-muted">{AI_NOT_CONFIGURED_HELP}</p>
            <p className="text-[13px] leading-relaxed text-fg-muted">
              Example: <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-fg">AI_PROVIDER=anthropic</code>{" "}
              <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-fg">AI_API_KEY=…</code> (optionally{" "}
              <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-fg">AI_MODEL</code>). Nothing is generated or invented while AI is off.
            </p>
          </div>
        </div>
        <div className="border-t border-border px-5 py-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">These deterministic tools still work</p>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {DETERMINISTIC_TOOLS.map((tool) => (
              <li key={tool.tab}>
                <button
                  type="button"
                  onClick={() => onOpenTab(tool.tab)}
                  className="h-full w-full rounded-lg border border-border bg-surface px-3 py-2 text-left transition-colors hover:border-border-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                    <CheckCircle2 className="size-3.5 text-success" aria-hidden /> {tool.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-fg-subtle">{tool.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </Card>
    );
  }

  const badge = connectivityBadge(status.connectivity);
  const failing = status.connectivity.state === "failing";
  return (
    <Card className="grid gap-5 px-5 py-4 md:grid-cols-[1.2fr_1fr_auto] md:items-center">
      <div className="flex items-start gap-3">
        <span
          className={
            failing
              ? "flex size-10 shrink-0 items-center justify-center rounded-lg bg-danger-soft text-danger-soft-fg"
              : "flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-fg"
          }
        >
          {failing ? <AlertTriangle className="size-5" aria-hidden /> : <Bot className="size-5" aria-hidden />}
        </span>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold text-fg">{badge.title}</h2>
            <Badge tone={badge.tone} dot>
              {badge.label}
            </Badge>
            {status.plan_allows_ai ? null : (
              <Badge tone="warning" dot>
                <CircleSlash className="size-3" aria-hidden /> Not in plan
              </Badge>
            )}
          </div>
          <p className="text-[13px] text-fg-muted">
            Provider <span className="font-medium text-fg">{status.provider ?? "—"}</span> · model{" "}
            <span className="font-mono text-xs text-fg">{status.model ?? "—"}</span>
          </p>
          {failing && status.connectivity.last_error_message ? (
            <p className="text-xs text-danger-soft-fg">
              {status.connectivity.last_error_message} ({formatRelative(status.connectivity.last_error_at)})
            </p>
          ) : status.connectivity.state === "verified" ? (
            <p className="text-xs text-fg-subtle">Last successful AI request {formatRelative(status.connectivity.last_success_at)}</p>
          ) : (
            <p className="text-xs text-fg-subtle">No AI request has succeeded yet, so the provider connection is not verified.</p>
          )}
          {canCheck && onCheckConnection ? (
            <Button size="xs" variant="outline" loading={checking} onClick={onCheckConnection} leftIcon={<PlugZap aria-hidden />}>
              Test connection
            </Button>
          ) : null}
          {status.plan_allows_ai ? null : (
            <p className="text-xs text-warning-soft-fg">
              Your plan doesn&apos;t include AI assistance. <ButtonLink href="/settings/billing" variant="link" className="text-xs">See plans</ButtonLink>
            </p>
          )}
        </div>
      </div>
      <UsageMeter label="AI requests this month" used={status.requests_this_month} limit={status.monthly_limit} />
      <dl className="grid grid-cols-2 gap-x-5 gap-y-1 text-[13px] md:grid-cols-1">
        <div>
          <dt className="text-xs text-fg-subtle">Estimated cost this month</dt>
          <dd className="font-semibold text-fg">{formatUsd(status.estimated_cost_this_month)}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-subtle">Tokens this month</dt>
          <dd className="font-semibold text-fg tabular-nums">{status.tokens_this_month.toLocaleString()}</dd>
        </div>
      </dl>
    </Card>
  );
}
