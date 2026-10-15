"use client";

import { Download, FileText, Send } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import { downloadFile } from "@/lib/api/client";
import { errorMessage } from "@/lib/api/errors";
import { useAutomationRunDetail } from "@/lib/api/hooks/automation";
import { titleCase } from "@/lib/utils";

import { reviewKindLabel, safeAppPath } from "./automation-format";

/** What a run produced, with links into the app and report downloads. */
export function RunOutputs({ orgId, runId }: { orgId: string; runId: string }) {
  const detail = useAutomationRunDetail(orgId, runId);
  const [downloading, setDownloading] = useState<string | null>(null);

  if (detail.isLoading) return <Skeleton className="h-16 w-full" />;
  if (detail.error || !detail.data) {
    return <ErrorState error={detail.error} title="Couldn't load the run's results" compact onRetry={() => void detail.refetch()} />;
  }
  const { statements, review_tasks: tasks, deliveries, files } = detail.data.outputs;
  const empty = statements.length + tasks.length + deliveries.length + files.length === 0;

  const download = async (file: { id: string; filename: string }) => {
    setDownloading(file.id);
    try {
      await downloadFile(`/organizations/${encodeURIComponent(orgId)}/files/${encodeURIComponent(file.id)}/download`, file.filename);
    } catch (error) {
      toast.error("Couldn't download the file", { description: errorMessage(error) });
    } finally {
      setDownloading(null);
    }
  };

  if (empty) return <p className="text-xs text-fg-muted">This run didn&apos;t produce anything to review or download.</p>;

  return (
    <div className="grid gap-4 text-[13px] md:grid-cols-2">
      {files.length > 0 ? (
        <section aria-label="Files">
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Files</h4>
          <ul className="space-y-1.5">
            {files.map((file) => (
              <li key={file.id}>
                <Button size="xs" variant="outline" leftIcon={<Download aria-hidden />} loading={downloading === file.id} onClick={() => void download(file)}>
                  {file.filename}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {statements.length > 0 ? (
        <section aria-label="Statements">
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Statements</h4>
          <ul className="space-y-1">
            {statements.map((statement) => (
              <li key={statement.id} className="flex items-center gap-2">
                <FileText className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                <Link href={`/royalties/statements/${statement.id}`} className="truncate hover:text-primary hover:underline">
                  {statement.source_name} ({statement.period_start} – {statement.period_end})
                </Link>
                <Badge size="sm">{titleCase(statement.status)}</Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {tasks.length > 0 ? (
        <section aria-label="Review tasks">
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Review tasks</h4>
          <ul className="space-y-1">
            {tasks.map((task) => {
              const href = safeAppPath(task.link);
              return (
                <li key={task.id} className="flex items-center gap-2">
                  <Badge size="sm">{reviewKindLabel(task.kind)}</Badge>
                  {href ? (
                    <Link href={href} className="truncate hover:text-primary hover:underline">
                      {task.title}
                    </Link>
                  ) : (
                    <span className="truncate">{task.title}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {deliveries.length > 0 ? (
        <section aria-label="Notifications sent">
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-fg-subtle">Notifications</h4>
          <ul className="space-y-1">
            {deliveries.map((delivery) => (
              <li key={delivery.id} className="flex items-center gap-2 text-fg-muted">
                <Send className="size-3.5 shrink-0" aria-hidden />
                <span>
                  {titleCase(delivery.kind)}: {delivery.status}
                  {delivery.recipient_count ? `, ${delivery.recipient_count} recipient${delivery.recipient_count === 1 ? "" : "s"}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
