"use client";

import { ShieldAlert } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

import { Stepper, type StepItem } from "@/components/royalties/shared";
import { useOrg } from "@/components/session/org-provider";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { useStatement } from "@/lib/api/hooks/royalties";

import { DetailsStep } from "./details-step";
import { MappingStep } from "./mapping-step";
import { ProcessStep } from "./process-step";

type WizardStep = "details" | "map" | "process";

const MAPPABLE = new Set(["uploaded", "failed", "processed", "calculated"]);

export function UploadWizardClient() {
  const { org, can } = useOrg();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const statementId = searchParams.get("statement");
  const stepParam = searchParams.get("step");
  const statement = useStatement(org.id, statementId ?? "");

  const go = useCallback(
    (next: { statement?: string; step?: WizardStep }) => {
      const params = new URLSearchParams();
      const id = next.statement ?? statementId;
      if (id) params.set("statement", id);
      if (next.step && next.step !== "details") params.set("step", next.step);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, statementId],
  );

  if (!can("manager")) {
    return (
      <>
        <PageHeader title="Upload statement" breadcrumbs={[{ label: "Royalties" }, { label: "Statements", href: "/royalties/statements" }, { label: "Upload" }]} />
        <Card>
          <EmptyState
            icon={<ShieldAlert aria-hidden />}
            title="Managers upload statements"
            description="Your role can view statements but not upload or process them. Ask a manager or admin for access."
            action={
              <ButtonLink href="/royalties/statements" variant="outline" size="sm">
                Back to statements
              </ButtonLink>
            }
          />
        </Card>
      </>
    );
  }

  let step: WizardStep = "details";
  if (statementId) {
    const status = statement.data?.status;
    if (stepParam === "map" && (!status || MAPPABLE.has(status))) step = "map";
    else if (stepParam === "process") step = "process";
    else step = status === "uploaded" || status === "failed" ? "map" : "process";
  }

  const order: WizardStep[] = ["details", "map", "process"];
  const currentIndex = order.indexOf(step);
  const processedOk = statement.data?.status && !["uploaded", "queued", "processing", "failed"].includes(statement.data.status);
  const steps: StepItem[] = [
    { key: "details", label: "Details & file", description: "Source, period, currency" },
    { key: "map", label: "Map columns", description: "Match file columns to fields" },
    { key: "process", label: "Process", description: "Validate and match lines" },
  ].map((item, index) => ({
    ...item,
    state: index < currentIndex || (index === currentIndex && step === "process" && processedOk) ? "complete" : index === currentIndex ? "current" : "upcoming",
  }));

  return (
    <>
      <PageHeader
        title="Upload statement"
        description="Import a royalty statement (CSV, TSV or XLSX, up to 25 MB). Identical files are rejected to prevent double counting."
        breadcrumbs={[{ label: "Royalties" }, { label: "Statements", href: "/royalties/statements" }, { label: "Upload" }]}
      />
      <Card className="mb-6">
        <CardBody className="py-4">
          <Stepper steps={steps} label="Upload progress" />
        </CardBody>
      </Card>
      {step === "details" ? (
        <DetailsStep orgId={org.id} defaultCurrency={org.defaultCurrency} onUploaded={(id) => go({ statement: id, step: "map" })} />
      ) : statement.isLoading ? (
        <PageSkeleton rows={4} />
      ) : statement.error || !statement.data ? (
        <Card>
          <ErrorState error={statement.error} onRetry={() => void statement.refetch()} />
        </Card>
      ) : step === "map" ? (
        <MappingStep orgId={org.id} statement={statement.data} onProcessing={() => go({ step: "process" })} />
      ) : (
        <ProcessStep orgId={org.id} statement={statement.data} onEditMapping={() => go({ step: "map" })} />
      )}
    </>
  );
}
