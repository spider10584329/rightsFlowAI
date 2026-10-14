"use client";

import { ArrowLeft } from "lucide-react";
import { useParams } from "next/navigation";

import { RequestReviewButton } from "@/components/automation/request-review-button";
import { ConflictStatusBadge } from "@/components/rights/badges";
import { ConflictDetail } from "@/components/rights/conflict-detail";
import { useOrg } from "@/components/session/org-provider";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { useConflict } from "@/lib/api/hooks/rights";

export function ConflictDetailClient() {
  const { org, can } = useOrg();
  const params = useParams<{ id: string }>();
  const id = typeof params.id === "string" ? params.id : null;
  const conflict = useConflict(org.id, id);

  if (conflict.isLoading) return <PageSkeleton rows={8} />;
  if (conflict.error || !conflict.data) {
    return (
      <>
        <PageHeader title="Rights conflict" breadcrumbs={[{ label: "Rights", href: "/rights" }, { label: "Conflicts", href: "/rights/conflicts" }, { label: "Conflict" }]} />
        <Card>
          <ErrorState error={conflict.error} onRetry={() => void conflict.refetch()} />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={conflict.data.title}
        meta={<ConflictStatusBadge status={conflict.data.status} />}
        breadcrumbs={[{ label: "Rights", href: "/rights" }, { label: "Conflicts", href: "/rights/conflicts" }, { label: "Conflict" }]}
        actions={
          <>
            {can("manager") && (conflict.data.status === "open" || conflict.data.status === "acknowledged") ? (
              <RequestReviewButton orgId={org.id} subjectType="rights_conflict" subjectId={conflict.data.id} />
            ) : null}
            <ButtonLink href="/rights/conflicts" variant="outline" leftIcon={<ArrowLeft aria-hidden />}>
              All conflicts
            </ButtonLink>
          </>
        }
      />
      <Card className="max-w-4xl">
        <CardBody>
          <ConflictDetail orgId={org.id} conflict={conflict.data} canEdit={can("manager")} headingLevel={2} />
        </CardBody>
      </Card>
    </>
  );
}
