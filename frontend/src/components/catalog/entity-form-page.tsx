"use client";

import { useParams } from "next/navigation";

import { ReadOnlyNotice } from "@/components/catalog/form-shell";
import { ENTITY_LABEL, entityHref } from "@/components/catalog/labels";
import { PartyForm } from "@/components/catalog/party-form";
import { RecordingForm } from "@/components/catalog/recording-form";
import { ReleaseForm } from "@/components/catalog/release-form";
import { WorkForm } from "@/components/catalog/work-form";
import { useOrg } from "@/components/session/org-provider";
import { ButtonLink } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/skeleton";
import { isApiError } from "@/lib/api/errors";
import { useCatalogDetail, type CatalogDetail, type CatalogEntityType, type PartyDetail, type RecordingDetail, type Release, type WorkDetail } from "@/lib/api/hooks/catalog";

const DESCRIPTIONS: Record<CatalogEntityType, string> = {
  work: "Register a composition with its writers and publishers.",
  recording: "Add a master recording, its credits and the works it embodies.",
  release: "Create an album, EP or single and build its track list.",
  party: "Add an artist, writer, publisher or label.",
};

function titleOf(entity: CatalogEntityType, item: CatalogDetail<CatalogEntityType>): string {
  return entity === "party" ? (item as PartyDetail).name : (item as WorkDetail).title;
}

function EntityForm({ entity, orgId, item }: { entity: CatalogEntityType; orgId: string; item?: CatalogDetail<CatalogEntityType> }) {
  switch (entity) {
    case "work":
      return <WorkForm orgId={orgId} work={item as WorkDetail | undefined} />;
    case "recording":
      return <RecordingForm orgId={orgId} recording={item as RecordingDetail | undefined} />;
    case "release":
      return <ReleaseForm orgId={orgId} release={item as Release | undefined} />;
    default:
      return <PartyForm orgId={orgId} party={item as PartyDetail | undefined} />;
  }
}

/** `/catalog/<type>/new` */
export function NewEntityClient({ entity }: { entity: CatalogEntityType }) {
  const { org, can } = useOrg();
  const label = ENTITY_LABEL[entity];
  const noun = entity === "party" ? "party" : label.singular.toLowerCase();
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={`New ${noun}`}
        description={DESCRIPTIONS[entity]}
        breadcrumbs={[{ label: "Catalog", href: "/catalog" }, { label: label.plural, href: entityHref(entity) }, { label: "New" }]}
      />
      {can("manager") ? <EntityForm entity={entity} orgId={org.id} /> : <ReadOnlyNotice />}
    </div>
  );
}

/** `/catalog/<type>/[id]/edit` */
export function EditEntityClient({ entity }: { entity: CatalogEntityType }) {
  const { org, can } = useOrg();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const detail = useCatalogDetail(org.id, entity, id);
  const label = ENTITY_LABEL[entity];

  if (detail.isLoading) return <PageSkeleton rows={8} />;
  if (detail.error || !detail.data) {
    const notFound = isApiError(detail.error) && detail.error.isNotFound;
    return (
      <ErrorState
        error={detail.error}
        title={notFound ? `${label.singular} not found` : undefined}
        onRetry={notFound ? undefined : () => void detail.refetch()}
      />
    );
  }
  const title = titleOf(entity, detail.data);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={`Edit ${title}`}
        breadcrumbs={[
          { label: "Catalog", href: "/catalog" },
          { label: label.plural, href: entityHref(entity) },
          { label: title, href: entityHref(entity, id) },
          { label: "Edit" },
        ]}
        actions={
          <ButtonLink href={entityHref(entity, id)} variant="ghost">
            Back to {label.singular.toLowerCase()}
          </ButtonLink>
        }
      />
      {can("manager") ? <EntityForm key={id} entity={entity} orgId={org.id} item={detail.data} /> : <ReadOnlyNotice />}
    </div>
  );
}
