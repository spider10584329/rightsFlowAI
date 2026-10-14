"use client";

import { FolderInput } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { INBOX_FILE_STATES, useAutomationInboxFiles, type InboxFileOutcome, type InboxFileState } from "@/lib/api/hooks/automation";
import { cn, titleCase } from "@/lib/utils";

import { When } from "./automation-activity";
import { inboxErrorText, inboxStateTone, statementPath } from "./automation-format";

/** What happened to each file n8n picked up from the statement inbox (by content hash). */
export function InboxFilesPanel({ orgId }: { orgId: string }) {
  const [state, setState] = useState<InboxFileState | "all">("all");
  const files = useAutomationInboxFiles(orgId, { state: state === "all" ? undefined : state, limit: 100 });

  const columns: DataTableColumn<InboxFileOutcome>[] = [
    {
      id: "file",
      header: "File",
      cell: (file) => (
        <div className="min-w-0">
          <p className="truncate font-medium" title={file.file_name}>
            {file.file_name}
          </p>
          <p className="truncate font-mono text-2xs text-fg-subtle" title="SHA-256 prefix">
            {file.sha256}
          </p>
        </div>
      ),
    },
    {
      id: "state",
      header: "Outcome",
      cell: (file) => (
        <Badge tone={inboxStateTone(file.state)} dot>
          {titleCase(file.state)}
        </Badge>
      ),
    },
    {
      id: "statement",
      header: "Statement",
      hideOnMobile: true,
      cell: (file) =>
        file.statement_id ? (
          <Link href={statementPath(file.statement_id)} className="font-mono text-xs text-primary hover:underline">
            {file.statement_id.slice(0, 8)}
          </Link>
        ) : (
          <span className="text-fg-subtle">—</span>
        ),
    },
    {
      id: "error",
      header: "Reason",
      cell: (file) => {
        const text = inboxErrorText(file);
        return text ? (
          <span className={cn("line-clamp-2 max-w-xs text-xs", file.state === "rejected" ? "text-danger" : "text-fg-muted")} title={text}>
            {text}
          </span>
        ) : (
          <span className="text-fg-subtle">—</span>
        );
      },
    },
    { id: "times_seen", header: "Times seen", align: "right", hideOnMobile: true, cell: (file) => <span className="tabular-nums">{file.times_seen}</span> },
    { id: "first_seen", header: "First seen", hideOnMobile: true, cell: (file) => <When value={file.first_seen_at} /> },
    { id: "last_seen", header: "Last seen", cell: (file) => <When value={file.last_seen_at} /> },
  ];

  return (
    <Card>
      <CardHeader
        title="Inbox files"
        description="Files n8n picked up from the statement inbox. Identical files are recognized by content and never imported twice."
      />
      <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center">
        <Select
          size="sm"
          className="sm:w-44"
          aria-label="Filter inbox files by outcome"
          value={state}
          onValueChange={setState}
          options={[{ value: "all", label: "All outcomes" }, ...INBOX_FILE_STATES.map((value) => ({ value, label: titleCase(value) }))]}
        />
      </div>
      <DataTable
        columns={columns}
        data={files.data}
        getRowId={(file) => file.sha256}
        getRowLabel={(file) => file.file_name}
        isLoading={files.isLoading}
        isFetching={files.isFetching}
        error={files.error}
        onRetry={() => void files.refetch()}
        caption="Statement inbox files"
        emptyState={
          <EmptyState
            compact
            icon={<FolderInput aria-hidden />}
            title={state === "all" ? "No inbox files yet" : `No ${state} files`}
            description="Files appear once the n8n inbox workflow uploads statements with an automation key."
          />
        }
      />
    </Card>
  );
}
