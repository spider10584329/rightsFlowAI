"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { contractFormErrors } from "@/components/contracts/contract-errors";
import { ContractForm, toPayload } from "@/components/contracts/contract-form";
import { useOrg } from "@/components/session/org-provider";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "@/components/ui/toaster";
import { useCreateContract } from "@/lib/api/hooks/contracts";

export function NewContractClient() {
  const { org, can } = useOrg();
  const router = useRouter();
  const create = useCreateContract(org.id);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="New contract"
        description="Record the agreement's key terms, parties, royalty rates and the catalog it covers. Upload the signed document after saving."
        breadcrumbs={[{ label: "Contracts", href: "/contracts" }, { label: "New" }]}
      />
      {!can("manager") ? (
        <Alert tone="info" title="Read-only access" action={<ButtonLink href="/contracts" size="sm" variant="outline">Back to contracts</ButtonLink>}>
          Only managers and above can create contracts.
        </Alert>
      ) : (
        <ContractForm
          orgId={org.id}
          contract={null}
          defaultCurrency={org.defaultCurrency}
          submitting={create.isPending}
          serverErrors={serverErrors}
          formError={formError}
          cancelHref="/contracts"
          onSubmit={(state) => {
            setServerErrors({});
            setFormError(null);
            create.mutate(toPayload(state), {
              onSuccess: (contract) => {
                toast.success("Contract created", { description: contract.title });
                router.push(`/contracts/${contract.id}`);
              },
              onError: (error) => {
                const mapped = contractFormErrors(error);
                setServerErrors(mapped.fields);
                setFormError(mapped.form);
              },
            });
          }}
        />
      )}
    </>
  );
}
