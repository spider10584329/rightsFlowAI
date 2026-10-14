"use client";

import { Plus, Trash2 } from "lucide-react";
import { useId } from "react";

import { EXTERNAL_ID_SUGGESTIONS, MAX_EXTERNAL_IDS, type ExternalIdRow } from "@/components/catalog/external-ids";
import { rowKey } from "@/components/catalog/form-utils";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";

/** Key/value editor for external identifiers (DSP ids, society codes, ...). */
export function ExternalIdsEditor({
  rows,
  onChange,
  errors,
  showErrors,
}: {
  rows: ExternalIdRow[];
  onChange: (rows: ExternalIdRow[]) => void;
  errors: Record<string, string>;
  showErrors: boolean;
}) {
  const listId = useId();
  const update = (key: string, patch: Partial<ExternalIdRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <div className="space-y-2">
      <datalist id={listId}>
        {EXTERNAL_ID_SUGGESTIONS.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      {rows.length === 0 ? (
        <p className="text-[13px] text-fg-muted">No external identifiers. Add DSP ids or society codes to help matching and exports.</p>
      ) : (
        <ul className="space-y-2" aria-label="External identifiers">
          {rows.map((row, index) => {
            const nameError = showErrors ? errors[`${row.key}.name`] : undefined;
            const valueError = showErrors ? errors[`${row.key}.value`] : undefined;
            return (
              <li key={row.key} className="grid grid-cols-[1fr_1.4fr_auto] items-start gap-2">
                <div>
                  <Input
                    value={row.name}
                    list={listId}
                    maxLength={50}
                    placeholder="Name, e.g. spotify_id"
                    aria-label={`Identifier ${index + 1} name`}
                    aria-invalid={nameError ? true : undefined}
                    onChange={(event) => update(row.key, { name: event.target.value })}
                    className="font-mono text-[13px]"
                    spellCheck={false}
                  />
                  {nameError ? <p className="mt-1 text-xs font-medium text-danger">{nameError}</p> : null}
                </div>
                <div>
                  <Input
                    value={row.value}
                    maxLength={255}
                    placeholder="Value"
                    aria-label={`Identifier ${index + 1} value`}
                    aria-invalid={valueError ? true : undefined}
                    onChange={(event) => update(row.key, { value: event.target.value })}
                    className="font-mono text-[13px]"
                    spellCheck={false}
                  />
                  {valueError ? <p className="mt-1 text-xs font-medium text-danger">{valueError}</p> : null}
                </div>
                <IconButton
                  label={`Remove identifier ${index + 1}`}
                  icon={<Trash2 aria-hidden />}
                  onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
                />
              </li>
            );
          })}
        </ul>
      )}
      {showErrors && errors.external_ids ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {errors.external_ids}
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="outline"
        leftIcon={<Plus aria-hidden />}
        disabled={rows.length >= MAX_EXTERNAL_IDS}
        onClick={() => onChange([...rows, { key: rowKey("ext"), name: "", value: "" }])}
      >
        Add identifier
      </Button>
    </div>
  );
}
