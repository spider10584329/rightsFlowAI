"use client";

import { Plus, Trash2, UsersRound } from "lucide-react";
import { useState } from "react";

import { CatalogPicker } from "@/components/catalog/catalog-picker";
import { contributorRowErrors, rowKey, type ContributorRow } from "@/components/catalog/form-utils";
import { codeLabel } from "@/components/catalog/labels";
import { QuickPartyDialog } from "@/components/catalog/quick-party-dialog";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { Party, PartyRole } from "@/lib/api/hooks/catalog";

export interface ContributorsEditorProps<R extends string> {
  orgId: string;
  roles: readonly R[];
  rows: ContributorRow[];
  onChange: (rows: ContributorRow[]) => void;
  defaultRole: R;
  withInstrument?: boolean;
  /** Party roles suggested when creating a party inline for a contributor role. */
  partyRolesFor?: (role: R) => PartyRole[];
  /** Errors from the backend keyed by row index (`contributors.0.party_id`). */
  serverErrors?: Record<string, string>;
  /** Show row validation (after a submit attempt). */
  showErrors?: boolean;
  label: string;
}

export function ContributorsEditor<R extends string>({
  orgId,
  roles,
  rows,
  onChange,
  defaultRole,
  withInstrument,
  partyRolesFor,
  serverErrors = {},
  showErrors,
  label,
}: ContributorsEditorProps<R>) {
  const [creatingFor, setCreatingFor] = useState<{ key: string; name: string } | null>(null);
  const rowErrors = showErrors ? contributorRowErrors(rows) : {};

  const update = (key: string, patch: Partial<ContributorRow>) => onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const remove = (key: string) => onChange(rows.filter((row) => row.key !== key));
  const add = () => onChange([...rows, { key: rowKey("contributor"), party_id: "", party_name: "", role: defaultRole, instrument: "" }]);
  const creatingRow = creatingFor ? rows.find((row) => row.key === creatingFor.key) : undefined;

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-6 text-center">
          <UsersRound className="size-5 text-fg-subtle" aria-hidden />
          <p className="text-[13px] text-fg-muted">No {label.toLowerCase()} yet.</p>
        </div>
      ) : (
        <ul className="space-y-2" aria-label={label}>
          {rows.map((row, index) => {
            const error =
              rowErrors[row.key] ??
              serverErrors[`contributors.${index}.party_id`] ??
              serverErrors[`contributors.${index}.role`] ??
              serverErrors[`contributors.${index}.instrument`] ??
              serverErrors[`contributors.${index}`];
            return (
              <li key={row.key} className="rounded-lg border border-border bg-surface-2/40 p-2.5">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_auto] sm:items-center">
                  <CatalogPicker
                    orgId={orgId}
                    entity="party"
                    aria-label={`Party for ${label.toLowerCase()} row ${index + 1}`}
                    aria-invalid={error ? true : undefined}
                    selectedId={row.party_id || null}
                    selectedLabel={row.party_name || null}
                    placeholder="Search parties by name, IPI or ISNI"
                    onSelect={(party) => update(row.key, { party_id: party.id, party_name: (party as Party).name })}
                    onCreateRequest={(name) => setCreatingFor({ key: row.key, name })}
                    createLabel="Create party"
                  />
                  <Select
                    aria-label={`Role for ${label.toLowerCase()} row ${index + 1}`}
                    value={row.role || undefined}
                    onValueChange={(role) => update(row.key, { role })}
                    options={roles.map((role) => ({ value: role, label: codeLabel(role) }))}
                  />
                  <IconButton label={`Remove ${row.party_name || `row ${index + 1}`}`} icon={<Trash2 aria-hidden />} variant="danger" onClick={() => remove(row.key)} />
                </div>
                {withInstrument ? (
                  <Input
                    className="mt-2"
                    aria-label={`Instrument for ${label.toLowerCase()} row ${index + 1}`}
                    placeholder="Instrument (optional, e.g. Guitar)"
                    maxLength={100}
                    value={row.instrument ?? ""}
                    onChange={(event) => update(row.key, { instrument: event.target.value })}
                  />
                ) : null}
                {error ? (
                  <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
                    {error}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <Button variant="outline" size="sm" leftIcon={<Plus aria-hidden />} onClick={add}>
        Add {label.toLowerCase().replace(/s$/, "")}
      </Button>
      <QuickPartyDialog
        orgId={orgId}
        initialName={creatingFor?.name ?? null}
        defaultRoles={creatingRow && partyRolesFor ? partyRolesFor(creatingRow.role as R) : []}
        onClose={() => setCreatingFor(null)}
        onCreated={(party) => {
          if (creatingFor) update(creatingFor.key, { party_id: party.id, party_name: party.name });
        }}
      />
    </div>
  );
}
