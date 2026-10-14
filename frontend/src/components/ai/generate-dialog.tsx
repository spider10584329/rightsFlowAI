"use client";

import { CheckCircle2, Sparkles } from "lucide-react";
import { useState } from "react";

import { AiErrorAlert, AiOutput } from "@/components/ai/ai-ui";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { SearchInput } from "@/components/ui/search-input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toaster";
import { useGenerateSuggestions, useRecordPicker, type CleanupEntityType, type MetadataSuggestionResponse } from "@/lib/api/hooks/ai";
import { cn, titleCase } from "@/lib/utils";

const ENTITY_OPTIONS: { value: CleanupEntityType; label: string }[] = [
  { value: "work", label: "Work" },
  { value: "recording", label: "Recording" },
  { value: "party", label: "Party" },
];

export function GenerateSuggestionsDialog({ orgId, open, onOpenChange }: { orgId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [entityType, setEntityType] = useState<CleanupEntityType>("work");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<{ id: string; title: string } | null>(null);
  const [result, setResult] = useState<MetadataSuggestionResponse | null>(null);
  const [touched, setTouched] = useState(false);
  const records = useRecordPicker(orgId, entityType, q, open && !result);
  const generate = useGenerateSuggestions(orgId);

  const reset = () => {
    setQ("");
    setSelected(null);
    setResult(null);
    setTouched(false);
    generate.reset();
  };

  const close = (next: boolean) => {
    if (generate.isPending) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const submit = () => {
    setTouched(true);
    if (!selected) return;
    generate.mutate(
      { entity_type: entityType, entity_id: selected.id },
      {
        onSuccess: (data) => {
          setResult(data);
          toast.success(data.suggestions.length ? `${data.suggestions.length} suggestion${data.suggestions.length === 1 ? "" : "s"} queued for review` : "No changes proposed");
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      size="lg"
      title="Generate metadata suggestions"
      description="The AI reviews one record and proposes cleanups (capitalisation, identifier formats, alternate titles). Proposals are validated and queued; nothing changes until approved."
      footer={
        result ? (
          <>
            <Button variant="outline" onClick={reset}>
              Another record
            </Button>
            <Button onClick={() => close(false)}>Done</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => close(false)} disabled={generate.isPending}>
              Cancel
            </Button>
            <Button onClick={submit} loading={generate.isPending} leftIcon={<Sparkles aria-hidden />}>
              Generate
            </Button>
          </>
        )
      }
    >
      {result ? (
        <AiOutput title="Proposal summary" provider={result.provider} model={result.model}>
          <p className="text-[13px] text-fg">{result.summary}</p>
          <p className="flex items-center gap-1.5 text-[13px] text-fg-muted">
            <CheckCircle2 className="size-4 text-success" aria-hidden />
            {result.suggestions.length} suggestion{result.suggestions.length === 1 ? "" : "s"} added to the pending queue.
          </p>
          {result.discarded.length > 0 ? (
            <div>
              <p className="text-xs font-semibold text-fg-muted">Discarded by validation</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-fg-subtle">
                {result.discarded.map((item, index) => (
                  <li key={`${item.field}-${index}`}>
                    {titleCase(item.field)}: {item.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </AiOutput>
      ) : (
        <div className="space-y-4">
          <FormField label="Record type" required>
            {(props) => (
              <Select
                {...props}
                value={entityType}
                onValueChange={(value) => {
                  setEntityType(value);
                  setSelected(null);
                }}
                options={ENTITY_OPTIONS}
              />
            )}
          </FormField>
          <FormField label={`Find the ${entityType}`} required error={touched && !selected ? `Choose a ${entityType}.` : undefined}>
            {(props) => (
              <div className="space-y-2">
                <SearchInput value={q} onChange={setQ} placeholder={`Search ${entityType === "party" ? "parties" : `${entityType}s`} by title, name or identifier`} aria-label={`Search ${entityType}s`} />
                <ul id={props.id} role="listbox" aria-label={`Matching ${entityType}s`} className="scrollbar-thin max-h-60 overflow-y-auto rounded-lg border border-border">
                  {records.isLoading ? (
                    <li className="flex items-center gap-2 px-3 py-3 text-[13px] text-fg-muted">
                      <Spinner /> Searching…
                    </li>
                  ) : records.error ? (
                    <li className="px-3 py-3 text-[13px] text-danger">Couldn&apos;t load records.</li>
                  ) : (records.data ?? []).length === 0 ? (
                    <li className="px-3 py-3 text-[13px] text-fg-muted">No matching {entityType} records.</li>
                  ) : (
                    records.data?.map((record) => (
                      <li key={record.id} role="option" aria-selected={selected?.id === record.id}>
                        <button
                          type="button"
                          onClick={() => setSelected({ id: record.id, title: record.title })}
                          className={cn(
                            "flex w-full flex-col items-start px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none",
                            selected?.id === record.id && "bg-primary-soft hover:bg-primary-soft",
                          )}
                        >
                          <span className="text-[13px] font-medium text-fg">{record.title}</span>
                          {record.subtitle ? <span className="text-xs text-fg-subtle">{record.subtitle}</span> : null}
                        </button>
                      </li>
                    ))
                  )}
                </ul>
                {selected ? <p className="text-xs text-fg-muted">Selected: <span className="font-medium text-fg">{selected.title}</span></p> : null}
              </div>
            )}
          </FormField>
          {generate.error ? <AiErrorAlert error={generate.error} onRetry={submit} /> : null}
        </div>
      )}
    </Dialog>
  );
}
