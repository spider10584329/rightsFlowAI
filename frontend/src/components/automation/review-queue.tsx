"use client";

import { ArrowUpRight, CheckCircle2, ClipboardCheck, Sparkles, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toaster";
import {
  REVIEW_TASK_KINDS,
  useCloseReviewTask,
  useReviewTasks,
  type ReviewTask,
  type ReviewTaskAction,
  type ReviewTaskKind,
  type ReviewTaskStatus,
} from "@/lib/api/hooks/automation";
import { cn, formatDateTime, formatRelative } from "@/lib/utils";

import { reviewKindLabel, reviewKindTone, safeAppPath, summarizeReviewTask } from "./automation-format";

const STATUS_OPTIONS: { value: ReviewTaskStatus; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "dismissed", label: "Dismissed" },
];

const EMPTY_TITLES: Record<ReviewTaskStatus, string> = {
  open: "Nothing to review",
  resolved: "No resolved tasks",
  dismissed: "No dismissed tasks",
};

const ACTION_COPY: Record<ReviewTaskAction, { title: string; confirm: string; done: string; hint: string }> = {
  resolve: { title: "Resolve review task?", confirm: "Resolve", done: "Review task resolved", hint: "Optional. What was checked or fixed." },
  dismiss: { title: "Dismiss review task?", confirm: "Dismiss", done: "Review task dismissed", hint: "Optional. Why no action is needed." },
};

function ReviewTaskItem({ task, canAct, onAction }: { task: ReviewTask; canAct: boolean; onAction: (action: ReviewTaskAction) => void }) {
  const summary = summarizeReviewTask(task);
  const href = safeAppPath(task.link);
  const titleId = `review-task-${task.id}`;
  return (
    <li className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-start">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={reviewKindTone(task.kind)}>{reviewKindLabel(task.kind)}</Badge>
          {summary.aiNote ? (
            <Badge tone="accent" className="gap-1">
              <Sparkles className="size-3" aria-hidden /> {summary.aiNote}
            </Badge>
          ) : null}
          <time dateTime={task.updated_at} title={formatDateTime(task.updated_at)} className="text-xs text-fg-subtle">
            Updated {formatRelative(task.updated_at)}
          </time>
        </div>
        <h3 id={titleId} className="text-sm font-medium text-fg">
          {href ? (
            <Link href={href} className="inline-flex items-start gap-1 hover:text-primary hover:underline">
              {task.title}
              <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden />
            </Link>
          ) : (
            task.title
          )}
        </h3>
        {summary.lines.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-fg-muted marker:text-fg-subtle">
            {summary.lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : null}
        {summary.note ? <p className="text-xs text-fg-subtle">{summary.note}</p> : null}
        {task.status !== "open" ? (
          <p className="text-xs text-fg-muted">
            {task.status === "resolved" ? "Resolved" : "Dismissed"} {formatDateTime(task.resolved_at)}
            {task.resolution_note ? <span className="text-fg-subtle"> · “{task.resolution_note}”</span> : null}
          </p>
        ) : null}
      </div>
      {canAct && task.status === "open" ? (
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" leftIcon={<CheckCircle2 aria-hidden />} onClick={() => onAction("resolve")} aria-describedby={titleId}>
            Resolve
          </Button>
          <Button size="sm" variant="ghost" leftIcon={<XCircle aria-hidden />} onClick={() => onAction("dismiss")} aria-describedby={titleId}>
            Dismiss
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** Review tasks raised by automation. Visible to every member; managers and above can resolve or dismiss. */
export function ReviewQueue({ orgId, canAct }: { orgId: string; canAct: boolean }) {
  const [status, setStatus] = useState<ReviewTaskStatus>("open");
  const [kind, setKind] = useState<ReviewTaskKind | "all">("all");
  const tasks = useReviewTasks(orgId, { status, kind: kind === "all" ? undefined : kind, limit: 100 });
  const close = useCloseReviewTask(orgId);
  const [pending, setPending] = useState<{ task: ReviewTask; action: ReviewTaskAction } | null>(null);
  const [note, setNote] = useState("");
  const list = tasks.data ?? [];

  return (
    <Card>
      <CardHeader
        title="Review queue"
        description="Findings from automated checks that need a person. Automation never posts, approves or resolves anything on its own."
      />
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center">
        <SegmentedControl aria-label="Show review tasks" value={status} onValueChange={setStatus} options={STATUS_OPTIONS} />
        <Select
          size="sm"
          className="sm:ml-auto sm:w-48"
          aria-label="Filter by kind"
          value={kind}
          onValueChange={setKind}
          options={[{ value: "all", label: "All kinds" }, ...REVIEW_TASK_KINDS.map((value) => ({ value, label: reviewKindLabel(value) }))]}
        />
      </div>
      {tasks.isLoading ? (
        <ul className="divide-y divide-border" aria-label="Loading review tasks">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index} className="space-y-2 px-5 py-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </li>
          ))}
        </ul>
      ) : tasks.error && list.length === 0 ? (
        <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} retrying={tasks.isFetching} compact />
      ) : list.length === 0 ? (
        <EmptyState
          compact
          icon={<ClipboardCheck aria-hidden />}
          title={EMPTY_TITLES[status]}
          description={status === "open" ? "Automated checks will add tasks here when a statement, catalog item or conflict needs attention." : undefined}
        />
      ) : (
        <ul className={cn("divide-y divide-border", tasks.isFetching && "opacity-70 transition-opacity")} aria-busy={tasks.isFetching || undefined} aria-label="Review tasks">
          {list.map((task) => (
            <ReviewTaskItem key={task.id} task={task} canAct={canAct} onAction={(action) => setPending({ task, action })} />
          ))}
        </ul>
      )}
      {canAct ? (
        <ConfirmDialog
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open) {
              setPending(null);
              setNote("");
            }
          }}
          tone="primary"
          title={pending ? ACTION_COPY[pending.action].title : ""}
          description={pending?.task.title}
          confirmLabel={pending ? ACTION_COPY[pending.action].confirm : "Confirm"}
          onConfirm={async () => {
            if (!pending) return;
            await close.mutateAsync({ taskId: pending.task.id, action: pending.action, note });
            toast.success(ACTION_COPY[pending.action].done);
          }}
        >
          <FormField label="Note" hint={pending ? ACTION_COPY[pending.action].hint : undefined}>
            <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} rows={3} />
          </FormField>
        </ConfirmDialog>
      ) : null}
    </Card>
  );
}
