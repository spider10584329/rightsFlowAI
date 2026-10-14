"use client";

import { ArrowRight, Calculator, CheckCircle2, Loader2, OctagonAlert, Play, SlidersHorizontal } from "lucide-react";

import { Money, ProgressBar, StatementStatusBadge } from "@/components/royalties/shared";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat-card";
import { toast } from "@/components/ui/toaster";
import { errorMessage } from "@/lib/api/errors";
import { useJob, useProcessStatement, useStatement, type Statement, type StatementError } from "@/lib/api/hooks/royalties";

export function ProcessStep({ orgId, statement: initial, onEditMapping }: { orgId: string; statement: Statement; onEditMapping: () => void }) {
  const statementQuery = useStatement(orgId, initial.id);
  const statement = statementQuery.data ?? initial;
  const inFlight = statement.status === "queued" || statement.status === "processing";
  const job = useJob(orgId, inFlight ? statement.job_id : null);
  const process = useProcessStatement(orgId);
  const errors = (statement.errors ?? []) as unknown as StatementError[];

  const start = () =>
    process.mutate(statement.id, {
      onSuccess: () => toast.success("Processing started"),
      onError: (error) => toast.error("Could not start processing", { description: errorMessage(error) }),
    });

  const progress =
    statement.status === "queued" ? Math.max(2, job.data?.progress ?? 0) : statement.status === "processing" ? Math.max(5, job.data?.progress ?? 0) : statement.status === "uploaded" ? 0 : 100;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {statement.source_name} <StatementStatusBadge status={statement.status} />
          </span>
        }
        description="Every row is parsed, validated and matched to your catalog by ISRC, ISWC, UPC and title."
      />
      <CardBody className="space-y-6">
        {statement.status === "uploaded" ? (
          <Alert tone="info" title="Ready to process" action={<Button size="sm" onClick={start} loading={process.isPending} leftIcon={<Play aria-hidden />}>Start processing</Button>}>
            The column mapping is saved. Start processing to validate and match the rows.
          </Alert>
        ) : null}

        {inFlight ? (
          <div className="space-y-3" aria-live="polite">
            <p className="flex items-center gap-2 text-sm font-medium text-fg">
              <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
              {statement.status === "queued" ? "Waiting for a worker…" : "Validating and matching rows…"}
            </p>
            <ProgressBar value={progress} label={statement.status === "queued" ? "Queued" : "Processing"} />
            <p className="text-xs text-fg-subtle">You can leave this page — processing continues in the background and you&apos;ll be notified when it finishes.</p>
          </div>
        ) : null}

        {statement.status === "failed" ? (
          <Alert
            tone="danger"
            title="Processing failed"
            action={
              <>
                <Button size="sm" variant="outline" onClick={onEditMapping} leftIcon={<SlidersHorizontal aria-hidden />}>
                  Adjust mapping
                </Button>
                <Button size="sm" onClick={start} loading={process.isPending}>
                  Retry
                </Button>
              </>
            }
          >
            {errors.length > 0 ? errors.flatMap((e) => e.errors).slice(0, 3).join(" · ") : "The file could not be processed."}
          </Alert>
        ) : null}

        {!inFlight && statement.status !== "uploaded" && statement.status !== "failed" ? (
          <div className="space-y-5" aria-live="polite">
            <p className="flex items-center gap-2 text-sm font-medium text-success">
              <CheckCircle2 className="size-4" aria-hidden /> Processing complete
            </p>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Rows" value={statement.total_rows.toLocaleString()} />
              <StatCard label="Valid rows" value={statement.valid_rows.toLocaleString()} hint={statement.error_rows > 0 ? `${statement.error_rows.toLocaleString()} with errors` : "No errors"} />
              <StatCard
                label="Matched rows"
                value={statement.matched_rows.toLocaleString()}
                hint={statement.valid_rows > 0 ? `${Math.round((statement.matched_rows / statement.valid_rows) * 100)}% of valid rows` : undefined}
              />
              <StatCard label="Statement total" value={<Money amount={statement.total_amount} currency={statement.currency} />} hint={statement.currency} />
            </div>
            {statement.error_rows > 0 ? (
              <Alert tone="warning" title={`${statement.error_rows.toLocaleString()} rows could not be used`}>
                <ul className="list-disc pl-4">
                  {errors.slice(0, 5).map((e, index) => (
                    <li key={index}>
                      {e.row ? `Row ${e.row}: ` : ""}
                      {e.errors.join("; ")}
                    </li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {statement.valid_rows > statement.matched_rows ? (
              <Alert tone="info" title={`${(statement.valid_rows - statement.matched_rows).toLocaleString()} valid rows are unmatched`}>
                Match them to recordings or works on the statement&apos;s Lines tab, or calculate now — unmatched income is held as unallocated.
              </Alert>
            ) : null}
          </div>
        ) : null}
        {statement.status === "failed" && errors.length > 0 ? (
          <div className="rounded-lg border border-danger/25 bg-danger-soft/40 p-4 text-[13px]">
            <p className="mb-2 flex items-center gap-2 font-semibold text-danger-soft-fg">
              <OctagonAlert className="size-4" aria-hidden /> Errors
            </p>
            <ul className="list-disc space-y-1 pl-5 text-fg">
              {errors.slice(0, 10).map((e, index) => (
                <li key={index}>
                  {e.row ? `Row ${e.row}: ` : ""}
                  {e.errors.join("; ")}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
      <CardFooter>
        <ButtonLink href={`/royalties/statements/${statement.id}`} variant="outline" rightIcon={<ArrowRight aria-hidden />}>
          Review statement
        </ButtonLink>
        {!inFlight && ["processed", "calculated"].includes(statement.status) ? (
          <ButtonLink href={`/royalties/statements/${statement.id}?tab=calculation`} leftIcon={<Calculator aria-hidden />}>
            Calculate royalties
          </ButtonLink>
        ) : null}
      </CardFooter>
    </Card>
  );
}
