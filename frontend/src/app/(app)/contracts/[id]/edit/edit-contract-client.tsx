"use client";

import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

import { contractFormErrors } from "@/components/contracts/contract-errors";
import { ContractForm, toPayload } from "@/components/contracts/contract-form";
import { useOrg } from "@/components/session/org-provider";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toaster";
import { useContract, useUpdateContract, type ContractUpdate } from "@/lib/api/hooks/contracts";

export function EditContractClient() {
  const { org, can } = useOrg();
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : "";
  const router = useRouter();
  const contract = useContract(org.id, id);
  const update = useUpdateContract(org.id, id);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  if (contract.isLoading) return <PageSkeleton rows={10} />;
  if (contract.error || !contract.data) {
    return (
      <Card>
        <ErrorState error={contract.error} onRetry={() => void contract.refetch()} />
      </Card>
    );
  }
  const data = contract.data;

  return (
    <>
      <PageHeader
        title={`Edit ${data.title}`}
        breadcrumbs={[{ label: "Contracts", href: "/contracts" }, { label: data.title, href: `/contracts/${id}` }, { label: "Edit" }]}
      />
      {!can("manager") ? (
        <Alert tone="info" title="Read-only access" action={<ButtonLink href={`/contracts/${id}`} size="sm" variant="outline">Back to contract</ButtonLink>}>
          Only managers and above can edit contracts.
        </Alert>
      ) : (
        <ContractForm
          key={data.updated_at}
          orgId={org.id}
          contract={data}
          defaultCurrency={org.defaultCurrency}
          submitting={update.isPending}
          serverErrors={serverErrors}
          formError={formError}
          cancelHref={`/contracts/${id}`}
          onSubmit={(state) => {
            setServerErrors({});
            setFormError(null);
            const payload = toPayload(state) as ContractUpdate;
            // Only send status when it changes, so an unchanged status never trips the transition check.
            if (payload.status === data.status) delete payload.status;
            update.mutate(payload, {
              onSuccess: () => {
                toast.success("Contract saved");
                router.push(`/contracts/${id}`);
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
