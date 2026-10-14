"use client";

import { Search, SearchX } from "lucide-react";
import { useState } from "react";

import { AiErrorAlert, AiOutput, EntityBadge, ManagerOnlyNotice, RecordLink } from "@/components/ai/ai-ui";
import { Badge, statusTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { useSmartSearch, type SearchResult } from "@/lib/api/hooks/ai";
import { formatDate, titleCase } from "@/lib/utils";

const EXAMPLES = ["Works without an ISWC created this year", "Recordings by artists named Nova missing ISRC", "Active contracts with no end date"];

function planValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function SearchPanel({ orgId, canRun, configured }: { orgId: string; canRun: boolean; configured: boolean }) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState("25");
  const [error, setError] = useState<string | null>(null);
  const search = useSmartSearch(orgId);

  if (!canRun) return <ManagerOnlyNotice feature="Smart search" />;

  const run = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length < 2) return setError("Enter at least 2 characters.");
    if (trimmed.length > 500) return setError("Keep the query under 500 characters.");
    setError(null);
    setQuery(trimmed);
    search.mutate({ query: trimmed, limit: Number(limit) });
  };

  const result = search.data;
  const plan = result ? Object.entries(result.interpreted_plan).filter(([key, value]) => key !== "explanation" && planValue(value) !== "") : [];
  const explanation = result && typeof result.interpreted_plan.explanation === "string" ? result.interpreted_plan.explanation : null;

  const columns: DataTableColumn<SearchResult>[] = [
    {
      id: "title",
      header: "Record",
      cell: (row) => (
        <div className="min-w-0">
          <RecordLink entityType={row.entity_type} id={row.id}>
            {row.title}
          </RecordLink>
          {row.subtitle ? <p className="truncate text-xs text-fg-subtle">{row.subtitle}</p> : null}
        </div>
      ),
    },
    { id: "type", header: "Type", cell: (row) => <EntityBadge entityType={row.entity_type} /> },
    { id: "identifier", header: "Identifier", cell: (row) => <span className="font-mono text-xs">{row.identifier ?? "—"}</span>, hideOnMobile: true },
    {
      id: "status",
      header: "Status",
      cell: (row) =>
        row.status ? (
          <Badge tone={statusTone(row.status)} dot>
            {titleCase(row.status)}
          </Badge>
        ) : (
          "—"
        ),
    },
    { id: "created", header: "Created", cell: (row) => formatDate(row.created_at), hideOnMobile: true },
  ];

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <form
          className="grid gap-3 md:grid-cols-[1fr_8rem_auto] md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            run(query);
          }}
        >
          <FormField label="Describe what you're looking for" error={error ?? undefined} hint="The AI turns your words into filters; results come straight from the database.">
            <Input value={query} maxLength={500} onChange={(event) => setQuery(event.target.value)} placeholder="e.g. works by Jane Doe missing an ISWC" disabled={!configured} />
          </FormField>
          <FormField label="Max results">
            <NativeSelect value={limit} onChange={(event) => setLimit(event.target.value)}>
              {["10", "25", "50", "100"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <Button type="submit" loading={search.isPending} disabled={!configured} leftIcon={<Search aria-hidden />} className="md:mb-[1.375rem]">
            Search
          </Button>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-fg-subtle">Try:</span>
          {EXAMPLES.map((example) => (
            <Button key={example} size="xs" variant="outline" disabled={!configured || search.isPending} onClick={() => run(example)}>
              {example}
            </Button>
          ))}
        </div>
      </Card>

      {search.error ? <AiErrorAlert error={search.error} onRetry={() => run(query)} /> : null}

      {result ? (
        <>
          <AiOutput title="How your query was interpreted" provider={result.provider} model={result.model}>
            {explanation ? <p className="text-[13px] text-fg">{explanation}</p> : null}
            {plan.length > 0 ? (
              <dl className="flex flex-wrap gap-2">
                {plan.map(([key, value]) => (
                  <div key={key} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs">
                    <dt className="text-fg-subtle">{titleCase(key)}</dt>
                    <dd className="font-medium text-fg">{planValue(value)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {result.ignored_filters.length > 0 ? (
              <p className="text-xs text-warning-soft-fg">Ignored (not valid for this record type): {result.ignored_filters.join(", ")}</p>
            ) : null}
          </AiOutput>
          <Card>
            <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
              <h3 className="text-sm font-semibold text-fg">Results</h3>
              <p className="text-xs text-fg-subtle">
                {result.results.length} of {result.total.toLocaleString()} matching records · from the {result.results_source}
              </p>
            </div>
            <DataTable
              columns={columns}
              data={result.results}
              getRowId={(row) => `${row.entity_type}-${row.id}`}
              getRowLabel={(row) => row.title}
              caption="Smart search results"
              emptyState={<EmptyState compact icon={<SearchX aria-hidden />} title="No matching records" description="Try a broader description or different filters." />}
            />
          </Card>
        </>
      ) : null}
    </div>
  );
}
