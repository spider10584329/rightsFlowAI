"use client";

import { useState } from "react";

import { codeLabel } from "@/components/catalog/labels";
import { RoleToggleGroup } from "@/components/catalog/role-toggle-group";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toaster";
import { errorMessage, fieldErrors } from "@/lib/api/errors";
import { PARTY_ROLES, useCreateCatalogItem, type PartyDetail, type PartyRole, type PartyType } from "@/lib/api/hooks/catalog";

export interface QuickPartyDialogProps {
  orgId: string;
  /** Prefilled name; `null` closes the dialog. */
  initialName: string | null;
  defaultRoles?: PartyRole[];
  defaultType?: PartyType;
  onClose: () => void;
  onCreated: (party: PartyDetail) => void;
}

/** Inline "create party" used by contributor pickers. */
export function QuickPartyDialog({ initialName, ...props }: QuickPartyDialogProps) {
  // Remount the form for every new request so it starts from the prefilled values.
  return initialName === null ? null : <QuickPartyForm key={initialName} initialName={initialName} {...props} />;
}

function QuickPartyForm({ orgId, initialName, defaultRoles = [], defaultType = "person", onClose, onCreated }: QuickPartyDialogProps & { initialName: string }) {
  const create = useCreateCatalogItem(orgId, "party");
  const [name, setName] = useState(initialName);
  const [partyType, setPartyType] = useState<PartyType>(defaultType);
  const [roles, setRoles] = useState<PartyRole[]>(defaultRoles);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const submit = () => {
    if (!name.trim()) {
      setErrors({ name: "This field is required" });
      return;
    }
    setErrors({});
    setFormError(null);
    create.mutate(
      {
        body: {
          name: name.trim(),
          party_type: partyType,
          roles,
          legal_name: null,
          email: null,
          country_code: null,
          ipi_number: null,
          isni: null,
          pro_affiliation: null,
          is_internal: false,
          notes: null,
          status: "active",
        },
      },
      {
        onSuccess: (party) => {
          toast.success(`Created ${party.name}`);
          onCreated(party);
          onClose();
        },
        onError: (error) => {
          const fields = fieldErrors(error);
          if (Object.keys(fields).length > 0) setErrors(fields);
          else setFormError(errorMessage(error));
        },
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !create.isPending && onClose()}
      title="Create party"
      description="Add a new artist, writer, publisher or label. You can complete the profile later."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="quick-party-form" loading={create.isPending}>
            Create party
          </Button>
        </>
      }
    >
      <form
        id="quick-party-form"
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          submit();
        }}
      >
        {formError ? (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger-soft-fg">
            {formError}
          </p>
        ) : null}
        <FormField label="Name" required error={errors.name}>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={255} autoFocus />
        </FormField>
        <FormField label="Type">
          {(field) => (
            <Select
              {...field}
              value={partyType}
              onValueChange={setPartyType}
              options={(["person", "company"] as const).map((value) => ({ value, label: codeLabel(value) }))}
            />
          )}
        </FormField>
        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium text-fg">Roles</legend>
          <RoleToggleGroup options={PARTY_ROLES} value={roles} onChange={setRoles} />
          {errors.roles ? <p className="text-xs font-medium text-danger">{errors.roles}</p> : null}
        </fieldset>
      </form>
    </Dialog>
  );
}
