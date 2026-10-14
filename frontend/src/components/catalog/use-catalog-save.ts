"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { formErrorsFrom, internalCodeConflict } from "@/components/catalog/form-utils";
import { ENTITY_LABEL, entityHref } from "@/components/catalog/labels";
import { toast } from "@/components/ui/toaster";
import { isApiError } from "@/lib/api/errors";
import { useCreateCatalogItem, useUpdateCatalogItem, type CatalogEntityType, type CatalogInput } from "@/lib/api/hooks/catalog";

/**
 * Create/update with the catalog's error conventions: 422 -> field errors,
 * 409 duplicate internal code -> `internal_code` field, 409 duplicate
 * identifier -> the form re-submits with `allowDuplicate` ("save anyway").
 */
export function useCatalogSave<E extends CatalogEntityType>(orgId: string, entity: E, id: string | null, onFieldErrors: (errors: Record<string, string>) => void) {
  const router = useRouter();
  const create = useCreateCatalogItem(orgId, entity);
  const update = useUpdateCatalogItem(orgId, entity);
  const [saveError, setSaveError] = useState<unknown>(null);
  const label = ENTITY_LABEL[entity].singular;

  const handleError = (error: unknown) => {
    const fields = formErrorsFrom(error);
    const codeConflict = internalCodeConflict(error);
    if (codeConflict) fields.internal_code = codeConflict;
    const { _form: formLevel, ...fieldOnly } = fields;
    if (Object.keys(fieldOnly).length > 0) {
      onFieldErrors(fieldOnly);
      setSaveError(formLevel ? error : null);
      toast.error("Please fix the highlighted fields");
      return;
    }
    setSaveError(error);
    if (!(isApiError(error) && error.code === "duplicate_identifier")) toast.error(`Could not save ${label.toLowerCase()}`);
  };

  const save = (body: CatalogInput<E>, allowDuplicate = false) => {
    setSaveError(null);
    onFieldErrors({});
    const onSuccess = (saved: { id: string }) => {
      toast.success(id ? `${label} updated` : `${label} created`);
      router.push(entityHref(entity, saved.id));
    };
    if (id) update.mutate({ id, body, allowDuplicate }, { onSuccess, onError: handleError });
    else create.mutate({ body, allowDuplicate }, { onSuccess, onError: handleError });
  };

  return {
    save,
    pending: create.isPending || update.isPending,
    saveError,
  };
}
