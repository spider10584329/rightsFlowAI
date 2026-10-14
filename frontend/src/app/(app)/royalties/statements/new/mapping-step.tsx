"use client";

import { ArrowRight, Sparkles, Wand2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { sourceCategoryLabel } from "@/components/royalties/labels";
import { applySuggestions, cleanMapping, orderedFields, validateMapping, type ColumnMapping } from "@/components/royalties/mapping";
import { AiAdvisoryNotice } from "@/components/royalties/shared";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import { errorMessage, isApiError } from "@/lib/api/errors";
import {
  useClassifyStatement,
  useProcessStatement,
  useStatementPreview,
  useUpdateMapping,
  type Statement,
  type StatementClassification,
  type StatementPreview,
} from "@/lib/api/hooks/royalties";
import { cn, titleCase } from "@/lib/utils";

const NONE = "__none__";
const IDENTIFIERS = new Set(["isrc", "iswc", "upc", "title"]);

export function MappingStep({ orgId, statement, onProcessing }: { orgId: string; statement: Statement; onProcessing: () => void }) {
  const preview = useStatementPreview(orgId, statement.id);
  if (preview.isLoading) {
    return (
      <Card>
        <CardBody className="space-y-3">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </CardBody>
      </Card>
    );
  }
  if (preview.error || !preview.data) {
    return (
      <Card>
        <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
      </Card>
    );
  }
  return <MappingForm key={statement.id} orgId={orgId} statement={statement} preview={preview.data} onProcessing={onProcessing} />;
}

function MappingForm({ orgId, statement, preview, onProcessing }: { orgId: string; statement: Statement; preview: StatementPreview; onProcessing: () => void }) {
  const [adapter, setAdapter] = useState(statement.adapter || preview.detected_adapter);
  const [mapping, setMapping] = useState<ColumnMapping>(() => {
    const base = preview.current_mapping ?? preview.suggested_mapping ?? {};
    return applySuggestions({}, base, preview.headers).mapping;
  });
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const updateMapping = useUpdateMapping(orgId, statement.id);
  const process = useProcessStatement(orgId);
  const fields = orderedFields(Object.keys(preview.canonical_fields));
  const validation = validateMapping(mapping, preview.headers, fields);
  const mappedColumns = new Map<string, string[]>();
  for (const [field, column] of Object.entries(cleanMapping(mapping))) mappedColumns.set(column, [...(mappedColumns.get(column) ?? []), field]);
  const busy = updateMapping.isPending || process.isPending;

  const setField = (field: string, column: string) => setMapping((current) => ({ ...current, [field]: column === NONE ? "" : column }));

  const resetToDetected = () => {
    setMapping(applySuggestions({}, preview.suggested_mapping, preview.headers).mapping);
    setAdapter(preview.detected_adapter);
  };

  const save = async () => {
    setAttempted(true);
    setServerError(null);
    if (!validation.valid) return;
    try {
      await updateMapping.mutateAsync({ adapter, column_mapping: cleanMapping(mapping) });
      await process.mutateAsync(statement.id);
      toast.success("Processing started", { description: "Rows are being validated and matched to your catalog." });
      onProcessing();
    } catch (error) {
      setServerError(errorMessage(error));
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Card>
          <CardHeader
            title="Column mapping"
            description={`${preview.total_rows.toLocaleString()} rows · ${preview.headers.length} columns. Map each field to a column in the file; detected suggestions are pre-filled.`}
            actions={
              <Button variant="ghost" size="sm" onClick={resetToDetected}>
                Reset to detected
              </Button>
            }
          />
          <CardBody className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
              <label htmlFor="adapter" className="text-[13px] font-medium text-fg">
                Statement format
              </label>
              <div>
                <Select
                  id="adapter"
                  value={adapter}
                  onValueChange={setAdapter}
                  options={preview.adapters.map((a) => ({
                    value: a.key,
                    label: a.key === preview.detected_adapter ? `${a.label} (detected)` : a.label,
                    description: a.description,
                  }))}
                />
              </div>
            </div>
            <div className="rounded-lg border border-border bg-surface-2/50 px-4 py-3 text-xs text-fg-muted">
              <span className="font-semibold text-fg">Required:</span> net amount, plus at least one identifier (ISRC, ISWC, UPC or title). ISRC/ISWC give the most
              reliable matching.
            </div>
            <ul className="grid gap-x-6 gap-y-3 md:grid-cols-2">
              {fields.map((field) => {
                const required = field === "amount";
                const identifier = IDENTIFIERS.has(field);
                const error = attempted ? validation.fieldErrors[field] : validation.fieldErrors[field]?.includes("not in this file") ? validation.fieldErrors[field] : undefined;
                const id = `map-${field}`;
                return (
                  <li key={field} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <label htmlFor={id} className="text-[13px] font-medium text-fg">
                        {preview.canonical_fields[field] ?? titleCase(field)}
                      </label>
                      {required ? <Badge tone="danger">Required</Badge> : identifier ? <Badge tone="info">Identifier</Badge> : null}
                    </div>
                    <Select
                      id={id}
                      size="sm"
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `${id}-error` : undefined}
                      value={mapping[field] || NONE}
                      onValueChange={(value) => setField(field, value)}
                      options={[{ value: NONE, label: "— Not mapped —" }, ...preview.headers.map((header) => ({ value: header, label: header }))]}
                    />
                    {error ? (
                      <p id={`${id}-error`} role="alert" className="text-xs font-medium text-danger">
                        {error}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {attempted && validation.errors.length > 0 ? (
              <Alert tone="danger" title="Fix the mapping before processing">
                <ul className="list-disc pl-4">
                  {validation.errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {validation.warnings.length > 0 ? (
              <Alert tone="info" title="Check before processing">
                <ul className="list-disc pl-4">
                  {validation.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {serverError ? <Alert tone="danger" title="Could not start processing">{serverError}</Alert> : null}
          </CardBody>
          <CardFooter>
            <Button onClick={() => void save()} loading={busy} rightIcon={<ArrowRight aria-hidden />}>
              Save mapping & process
            </Button>
          </CardFooter>
        </Card>
        <AiSuggestionPanel
          orgId={orgId}
          statement={statement}
          preview={preview}
          onApply={(suggestion) => {
            const result = applySuggestions(mapping, suggestion, preview.headers);
            setMapping(result.mapping);
            toast.success(result.applied.length > 0 ? `Applied ${result.applied.length} AI suggestion${result.applied.length === 1 ? "" : "s"}` : "Mapping already matches the AI suggestions", {
              description: "Review every field before processing.",
            });
          }}
        />
      </div>

      <Card>
        <CardHeader title="Sample rows" description={`First ${preview.sample_rows.length} of ${preview.total_rows.toLocaleString()} rows. Mapped columns show the field they feed.`} />
        <ScrollRegion>
          <table className="w-full min-w-max text-left text-[13px]">
            <caption className="sr-only">Sample rows from the uploaded file</caption>
            <thead>
              <tr className="border-b border-border bg-surface-2/60">
                {preview.headers.map((header) => {
                  const mappedTo = mappedColumns.get(header);
                  return (
                    <th key={header} scope="col" className={cn("px-4 py-2 align-bottom font-medium text-fg", mappedTo ? "bg-primary-soft/50" : "text-fg-muted")}>
                      <span className="block whitespace-nowrap">{header}</span>
                      {mappedTo ? (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {mappedTo.map((field) => (
                            <Badge key={field} tone="primary">
                              → {field}
                            </Badge>
                          ))}
                        </span>
                      ) : (
                        <span className="mt-1 block text-2xs font-normal text-fg-subtle">not mapped</span>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {preview.sample_rows.map((row, index) => (
                <tr key={index} className="border-b border-border last:border-0">
                  {preview.headers.map((header) => (
                    <td key={header} className={cn("max-w-[16rem] truncate px-4 py-2 tabular-nums", mappedColumns.has(header) ? "text-fg" : "text-fg-subtle")}>
                      {row[header] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </Card>
    </div>
  );
}

function AiSuggestionPanel({
  orgId,
  statement,
  preview,
  onApply,
}: {
  orgId: string;
  statement: Statement;
  preview: StatementPreview;
  onApply: (mapping: ColumnMapping) => void;
}) {
  const classify = useClassifyStatement(orgId);
  const [result, setResult] = useState<StatementClassification | null>(null);
  const error = classify.error;
  const notConfigured = isApiError(error) && (error.code === "ai_not_configured" || error.status === 503);
  const planLimit = isApiError(error) && (error.code === "plan_limit_exceeded" || error.status === 402);

  const run = () => {
    const rows = preview.sample_rows.slice(0, 20).map((row) => preview.headers.slice(0, 100).map((header) => (row[header] ?? "").slice(0, 500) || null));
    classify.mutate(
      { headers: preview.headers.slice(0, 100).map((h) => h.slice(0, 200)), sample_rows: rows, filename: statement.file_name ?? null },
      { onSuccess: setResult },
    );
  };

  return (
    <Card className="h-fit">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Sparkles className="size-4 text-accent" aria-hidden /> AI mapping assistant
          </span>
        }
        description="Optional. Suggests a category and column mapping from the headers and sample rows."
      />
      <CardBody className="space-y-4">
        <Button variant="soft" onClick={run} loading={classify.isPending} leftIcon={<Wand2 aria-hidden />} className="w-full">
          {result ? "Ask again" : "Suggest with AI"}
        </Button>
        {notConfigured ? (
          <Alert tone="info" title="AI provider not configured">
            AI suggestions aren&apos;t available for this workspace. Map the columns manually — the detected mapping is already pre-filled.
          </Alert>
        ) : planLimit ? (
          <Alert tone="warning" title="AI allowance used up">
            {error.message}{" "}
            <Link href="/settings/billing" className="font-medium underline">
              Review your plan
            </Link>
          </Alert>
        ) : error ? (
          <Alert tone="danger" title="AI suggestion failed">
            {errorMessage(error)}
          </Alert>
        ) : null}
        {result ? (
          <div className="space-y-3 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={result.confidence === "high" ? "success" : result.confidence === "medium" ? "warning" : "danger"}>{titleCase(String(result.confidence))} confidence</Badge>
              <Badge tone="neutral">{sourceCategoryLabel(result.source_category)}</Badge>
              {result.source_name_guess ? <Badge tone="neutral">Source: {result.source_name_guess}</Badge> : null}
            </div>
            {result.notes ? <p className="leading-relaxed text-fg-muted">{result.notes}</p> : null}
            <dl className="divide-y divide-border rounded-md border border-border">
              {Object.entries(result.column_mapping).map(([field, column]) => (
                <div key={field} className="flex items-center justify-between gap-3 px-3 py-1.5">
                  <dt className="text-fg-muted">{preview.canonical_fields[field] ?? field}</dt>
                  <dd className="truncate font-medium text-fg">{column}</dd>
                </div>
              ))}
              {Object.keys(result.column_mapping).length === 0 ? <p className="px-3 py-2 text-fg-subtle">No mapping suggested.</p> : null}
            </dl>
            {result.dropped_mappings.length > 0 ? (
              <p className="text-xs text-fg-subtle">{result.dropped_mappings.length} invalid suggestion(s) were discarded because they referenced unknown fields or columns.</p>
            ) : null}
            {result.unmapped_headers.length > 0 ? <p className="text-xs text-fg-subtle">Unused columns: {result.unmapped_headers.join(", ")}</p> : null}
            <Button variant="outline" size="sm" className="w-full" onClick={() => onApply(result.column_mapping)} disabled={Object.keys(result.column_mapping).length === 0}>
              Apply AI mapping
            </Button>
            <AiAdvisoryNotice />
          </div>
        ) : (
          <AiAdvisoryNotice />
        )}
      </CardBody>
    </Card>
  );
}
