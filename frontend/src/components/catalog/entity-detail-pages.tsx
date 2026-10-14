"use client";

import { Disc3, FileText, Mic2, Scale } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { IdentifierText, StatusBadge, VerificationBadge } from "@/components/catalog/catalog-badges";
import {
  DetailError,
  DetailShell,
  DetailSkeleton,
  externalIdItems,
  HeaderIdentifier,
  MetadataCard,
  OwnershipLink,
  RelatedLink,
  RelatedList,
} from "@/components/catalog/entity-detail";
import { formatDuration, formatIsni, formatIsrc, formatIswc } from "@/components/catalog/identifiers";
import { codeLabel, entityHref, referenceLabel } from "@/components/catalog/labels";
import { useOrg } from "@/components/session/org-provider";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { KeyValueList } from "@/components/ui/key-value";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { Skeleton } from "@/components/ui/skeleton";
import { useCatalogDetail, useCatalogList, type Recording, type Work } from "@/lib/api/hooks/catalog";
import { formatDate, pluralize } from "@/lib/utils";

function useIdParam(): string {
  return useParams<{ id: string }>().id;
}

function ContributorsCard({
  title,
  contributors,
  empty,
}: {
  title: string;
  contributors: { id: string; party_id: string; party_name: string | null; role: string; instrument?: string | null }[];
  empty: string;
}) {
  return (
    <RelatedList
      title={title}
      items={contributors}
      empty={empty}
      getKey={(contributor) => contributor.id}
      render={(contributor) => (
        <RelatedLink
          href={entityHref("party", contributor.party_id)}
          title={contributor.party_name ?? "Unknown party"}
          meta={contributor.instrument ?? undefined}
          aside={<Badge>{codeLabel(contributor.role)}</Badge>}
        />
      )}
    />
  );
}

function NotesCard({ notes, lyrics }: { notes: string | null; lyrics?: string | null }) {
  if (!notes && !lyrics) return null;
  return (
    <Card>
      <CardHeader title={lyrics ? "Lyrics & notes" : "Notes"} />
      <CardBody className="space-y-4 text-[13px] leading-relaxed text-fg-muted">
        {lyrics ? <blockquote className="whitespace-pre-wrap border-l-2 border-border-strong pl-3 italic">{lyrics}</blockquote> : null}
        {notes ? <p className="whitespace-pre-wrap">{notes}</p> : null}
      </CardBody>
    </Card>
  );
}

// ----------------------------------------------------------------- work

export function WorkDetailClient() {
  const { org } = useOrg();
  const id = useIdParam();
  const detail = useCatalogDetail(org.id, "work", id);
  if (detail.isLoading) return <DetailSkeleton />;
  if (detail.error || !detail.data) return <DetailError error={detail.error} entity="work" onRetry={() => void detail.refetch()} />;
  const work = detail.data;
  const writers = work.contributors.filter((c) => !["original_publisher", "sub_publisher", "administrator"].includes(c.role));
  const publishers = work.contributors.filter((c) => ["original_publisher", "sub_publisher", "administrator"].includes(c.role));

  return (
    <DetailShell
      entity="work"
      item={{ id: work.id, title: work.title, status: work.status, created_at: work.created_at, updated_at: work.updated_at }}
      title={work.title}
      subtitle={work.alternate_titles && work.alternate_titles.length > 0 ? `Also known as ${work.alternate_titles.join(" · ")}` : "Musical work"}
      badges={<VerificationBadge status={work.verification_status} />}
      identifiers={
        <>
          <HeaderIdentifier label="ISWC" value={work.iswc ? (work.iswc_display ?? formatIswc(work.iswc)) : null} />
          <HeaderIdentifier label="Internal code" value={work.internal_code} />
        </>
      }
      completeness={work.completeness}
      ownership={<OwnershipLink assetType="work" assetId={work.id} title={work.title} />}
      overview={
        <>
          <MetadataCard
            items={[
              { label: "Language", value: work.language ?? "—" },
              { label: "Genre", value: work.genre ?? "—" },
              { label: "Creation year", value: work.creation_year ?? "—" },
              { label: "Verification", value: <VerificationBadge status={work.verification_status} /> },
              ...externalIdItems(work.external_ids),
            ]}
          />
          <div className="grid gap-6 xl:grid-cols-2">
            <ContributorsCard title="Writers" contributors={writers} empty="No writers yet. Add composers or lyricists to pass validation." />
            <ContributorsCard title="Publishers" contributors={publishers} empty="No publishers linked." />
          </div>
          <RelatedList
            title="Recordings"
            description="Sound recordings that embody this work."
            items={work.recordings}
            empty="No recordings are linked to this work yet. Link one from a recording's edit page."
            getKey={(recording) => recording.id}
            render={(recording) => (
              <RelatedLink
                href={entityHref("recording", recording.id)}
                title={recording.version_title ? `${recording.title} (${recording.version_title})` : recording.title}
                meta={[recording.artist, recording.isrc ? formatIsrc(recording.isrc) : "No ISRC"].filter(Boolean).join(" · ")}
                aside={<StatusBadge status={recording.status} />}
              />
            )}
          />
          <NotesCard notes={work.notes} lyrics={work.lyrics_excerpt} />
        </>
      }
    />
  );
}

// ----------------------------------------------------------------- recording

export function RecordingDetailClient() {
  const { org } = useOrg();
  const id = useIdParam();
  const detail = useCatalogDetail(org.id, "recording", id);
  if (detail.isLoading) return <DetailSkeleton />;
  if (detail.error || !detail.data) return <DetailError error={detail.error} entity="recording" onRetry={() => void detail.refetch()} />;
  const recording = detail.data;

  return (
    <DetailShell
      entity="recording"
      item={{ id: recording.id, title: recording.title, status: recording.status, created_at: recording.created_at, updated_at: recording.updated_at }}
      title={recording.version_title ? `${recording.title} (${recording.version_title})` : recording.title}
      subtitle={
        recording.primary_artist_id ? (
          <>
            Recording by{" "}
            <Link href={entityHref("party", recording.primary_artist_id)} className="font-medium text-fg hover:text-primary hover:underline">
              {recording.display_artist ?? recording.primary_artist_name}
            </Link>
          </>
        ) : recording.artist ? (
          `Recording by ${recording.artist}`
        ) : (
          "Sound recording · no artist set"
        )
      }
      badges={
        <>
          <VerificationBadge status={recording.verification_status} />
          {recording.is_explicit ? <Badge>Explicit</Badge> : null}
        </>
      }
      identifiers={
        <>
          <HeaderIdentifier label="ISRC" value={recording.isrc ? formatIsrc(recording.isrc) : null} />
          <HeaderIdentifier label="Internal code" value={recording.internal_code} />
        </>
      }
      completeness={recording.completeness}
      ownership={<OwnershipLink assetType="recording" assetId={recording.id} title={recording.title} />}
      overview={
        <>
          <MetadataCard
            items={[
              { label: "Primary artist", value: recording.primary_artist_name ?? "—" },
              { label: "Display artist", value: recording.display_artist ?? "—" },
              { label: "Duration", value: formatDuration(recording.duration_seconds) },
              { label: "Recording date", value: recording.recording_date ? formatDate(recording.recording_date) : "—" },
              { label: "℗ line", value: recording.p_line ?? "—" },
              { label: "Explicit", value: recording.is_explicit ? "Yes" : "No" },
              ...externalIdItems(recording.external_ids),
            ]}
          />
          <RelatedList
            title="Underlying works"
            description="Compositions embodied in this recording."
            items={recording.works}
            empty="Not linked to a work yet — publishing royalties can't be matched until it is."
            getKey={(work) => work.id}
            render={(work) => (
              <RelatedLink
                href={entityHref("work", work.id)}
                title={work.title}
                meta={work.iswc ? formatIswc(work.iswc) : "No ISWC"}
                aside={<StatusBadge status={work.status} />}
              />
            )}
          />
          <ContributorsCard title="Contributors" contributors={recording.contributors} empty="No contributors credited." />
          <RelatedList
            title="Releases"
            description="Products this recording appears on."
            items={recording.releases}
            empty="Not on any release yet."
            getKey={(release) => `${release.id}-${release.disc_number}-${release.track_number}`}
            render={(release) => (
              <RelatedLink
                href={entityHref("release", release.id)}
                title={release.title}
                meta={`Disc ${release.disc_number} · Track ${release.track_number}${release.upc ? ` · UPC ${release.upc}` : ""}`}
                aside={<StatusBadge status={release.status} />}
              />
            )}
          />
          <NotesCard notes={recording.notes} />
        </>
      }
    />
  );
}

// ----------------------------------------------------------------- release

export function ReleaseDetailClient() {
  const { org } = useOrg();
  const id = useIdParam();
  const detail = useCatalogDetail(org.id, "release", id);
  if (detail.isLoading) return <DetailSkeleton />;
  if (detail.error || !detail.data) return <DetailError error={detail.error} entity="release" onRetry={() => void detail.refetch()} />;
  const release = detail.data;
  const tracks = [...release.tracks].sort((a, b) => a.disc_number - b.disc_number || a.track_number - b.track_number);
  const discs = new Set(tracks.map((track) => track.disc_number)).size;
  const runtime = tracks.every((track) => track.duration_seconds !== null) ? tracks.reduce((sum, track) => sum + (track.duration_seconds ?? 0), 0) : null;

  return (
    <DetailShell
      entity="release"
      item={{ id: release.id, title: release.title, status: release.status, created_at: release.created_at, updated_at: release.updated_at }}
      title={release.title}
      subtitle={[release.display_artist, release.label_name, release.release_date ? formatDate(release.release_date) : null].filter(Boolean).join(" · ") || "Release"}
      badges={<Badge tone="primary">{codeLabel(release.release_type)}</Badge>}
      identifiers={
        <>
          <HeaderIdentifier label="UPC/EAN" value={release.upc} />
          <HeaderIdentifier label="Catalog no." value={release.catalog_number} />
        </>
      }
      completeness={release.completeness}
      ownership={
        <RelatedList
          title="Ownership by track"
          description="Rights are held in the underlying recordings and works. Open a track to review its splits."
          items={tracks}
          empty="Add tracks to review their ownership."
          getKey={(track) => track.id}
          render={(track) => (
            <RelatedLink
              href={entityHref("recording", track.recording_id)}
              title={`${track.disc_number}-${track.track_number}. ${track.recording_title ?? "Untitled"}`}
              meta={track.isrc ? formatIsrc(track.isrc) : "No ISRC"}
              aside={
                <ButtonLink size="xs" variant="outline" leftIcon={<Scale aria-hidden />} href={`/rights?asset_type=recording&asset_id=${encodeURIComponent(track.recording_id)}`}>
                  Ownership
                </ButtonLink>
              }
            />
          )}
        />
      }
      overview={
        <>
          <Card>
            <CardHeader
              title="Track list"
              description={tracks.length > 0 ? `${pluralize(tracks.length, "track")} on ${pluralize(discs, "disc")}${runtime !== null ? ` · ${formatDuration(runtime)}` : ""}` : undefined}
            />
            {tracks.length === 0 ? (
              <EmptyState compact icon={<Disc3 aria-hidden />} title="No tracks" description="Releases without tracks fail validation. Edit the release to add recordings." />
            ) : (
              <ScrollRegion>
                <table className="w-full min-w-[32rem] text-[13px]">
                  <caption className="sr-only">Tracks</caption>
                  <thead className="text-left text-2xs uppercase tracking-[0.06em] text-fg-subtle">
                    <tr className="border-b border-border">
                      <th scope="col" className="w-16 px-5 py-2 font-semibold">
                        Pos.
                      </th>
                      <th scope="col" className="px-3 py-2 font-semibold">
                        Recording
                      </th>
                      <th scope="col" className="px-3 py-2 font-semibold">
                        ISRC
                      </th>
                      <th scope="col" className="px-5 py-2 text-right font-semibold">
                        Time
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {tracks.map((track) => (
                      <tr key={track.id}>
                        <td className="px-5 py-2.5 tabular-nums text-fg-muted">
                          {discs > 1 ? `${track.disc_number}-` : ""}
                          {track.track_number}
                        </td>
                        <td className="px-3 py-2.5">
                          <Link href={entityHref("recording", track.recording_id)} className="font-medium text-fg hover:text-primary hover:underline">
                            {track.recording_title ?? "Untitled"}
                            {track.version_title ? <span className="text-fg-muted"> ({track.version_title})</span> : null}
                          </Link>
                          {track.artist ? <p className="text-xs text-fg-subtle">{track.artist}</p> : null}
                        </td>
                        <td className="px-3 py-2.5">
                          <IdentifierText value={track.isrc ? formatIsrc(track.isrc) : null} />
                        </td>
                        <td className="px-5 py-2.5 text-right tabular-nums text-fg-muted">{formatDuration(track.duration_seconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
            )}
          </Card>
          <MetadataCard
            items={[
              { label: "Type", value: codeLabel(release.release_type) },
              {
                label: "Label",
                value: release.label_id ? (
                  <Link href={entityHref("party", release.label_id)} className="hover:text-primary hover:underline">
                    {release.label_name}
                  </Link>
                ) : (
                  "—"
                ),
              },
              { label: "Display artist", value: release.display_artist ?? "—" },
              { label: "Release date", value: release.release_date ? formatDate(release.release_date) : "—" },
              { label: "© line", value: release.c_line ?? "—" },
              { label: "Catalog number", value: release.catalog_number ?? "—" },
              ...externalIdItems(release.external_ids),
            ]}
          />
          <NotesCard notes={release.notes} />
        </>
      }
    />
  );
}

// ----------------------------------------------------------------- party

function PartyAssets({ orgId, partyId }: { orgId: string; partyId: string }) {
  const works = useCatalogList(orgId, "work", { party_id: partyId, page_size: 50, sort: "title" });
  const recordings = useCatalogList(orgId, "recording", { party_id: partyId, page_size: 50, sort: "title" });
  const releases = useCatalogList(orgId, "release", { label_id: partyId, page_size: 50, sort: "title" });
  const loading = <Skeleton className="h-24 w-full rounded-xl" />;
  return (
    <>
      {works.isLoading ? (
        loading
      ) : (
        <RelatedList
          title={`Works${works.data ? ` (${works.data.total})` : ""}`}
          items={works.data?.items ?? []}
          empty={works.error ? "Could not load works." : "Not credited on any work."}
          getKey={(work) => work.id}
          render={(work: Work) => (
            <RelatedLink
              href={entityHref("work", work.id)}
              title={work.title}
              meta={work.contributors
                .filter((c) => c.party_id === partyId)
                .map((c) => codeLabel(c.role))
                .join(", ")}
              aside={<IdentifierText value={work.iswc ? formatIswc(work.iswc) : null} missingLabel="No ISWC" />}
            />
          )}
          action={works.data && works.data.total > 50 ? <span className="text-xs text-fg-subtle">Showing first 50</span> : null}
        />
      )}
      {recordings.isLoading ? (
        loading
      ) : (
        <RelatedList
          title={`Recordings${recordings.data ? ` (${recordings.data.total})` : ""}`}
          items={recordings.data?.items ?? []}
          empty={recordings.error ? "Could not load recordings." : "Not the artist or a contributor on any recording."}
          getKey={(recording) => recording.id}
          render={(recording: Recording) => (
            <RelatedLink
              href={entityHref("recording", recording.id)}
              title={recording.version_title ? `${recording.title} (${recording.version_title})` : recording.title}
              meta={recording.primary_artist_id === partyId ? "Primary artist" : recording.contributors.filter((c) => c.party_id === partyId).map((c) => codeLabel(c.role)).join(", ")}
              aside={<IdentifierText value={recording.isrc ? formatIsrc(recording.isrc) : null} missingLabel="No ISRC" />}
            />
          )}
        />
      )}
      {releases.isLoading ? (
        loading
      ) : releases.data && releases.data.total > 0 ? (
        <RelatedList
          title={`Releases as label (${releases.data.total})`}
          items={releases.data.items}
          empty=""
          getKey={(release) => release.id}
          render={(release) => <RelatedLink href={entityHref("release", release.id)} title={release.title} meta={release.upc ?? "No UPC"} aside={<StatusBadge status={release.status} />} />}
        />
      ) : null}
    </>
  );
}

export function PartyDetailClient() {
  const { org } = useOrg();
  const id = useIdParam();
  const detail = useCatalogDetail(org.id, "party", id);
  const works = useCatalogList(org.id, "work", { party_id: id, page_size: 50, sort: "title" });
  const recordings = useCatalogList(org.id, "recording", { party_id: id, page_size: 50, sort: "title" });
  if (detail.isLoading) return <DetailSkeleton />;
  if (detail.error || !detail.data) return <DetailError error={detail.error} entity="party" onRetry={() => void detail.refetch()} />;
  const party = detail.data;
  const references = Object.entries(party.references);

  return (
    <DetailShell
      entity="party"
      item={{ id: party.id, title: party.name, status: party.status, created_at: party.created_at, updated_at: party.updated_at }}
      title={party.name}
      subtitle={[codeLabel(party.party_type), party.legal_name && party.legal_name !== party.name ? `Legal name: ${party.legal_name}` : null, party.pro_affiliation].filter(Boolean).join(" · ")}
      badges={
        <>
          {party.roles.map((role) => (
            <Badge key={role} tone="primary">
              {codeLabel(role)}
            </Badge>
          ))}
          {party.is_internal ? <Badge tone="accent">Internal</Badge> : null}
        </>
      }
      identifiers={
        <>
          <HeaderIdentifier label="IPI" value={party.ipi_number} />
          <HeaderIdentifier label="ISNI" value={party.isni ? formatIsni(party.isni) : null} />
        </>
      }
      side={
        <Card>
          <CardHeader title="Catalog footprint" />
          <CardBody className="py-1">
            <KeyValueList
              items={[
                { label: "Works", value: party.work_count },
                { label: "Recordings", value: party.recording_count },
                { label: "Releases (label)", value: party.release_count },
                ...references.map(([key, count]) => ({ label: referenceLabel(key), value: count })),
              ]}
            />
            {party.is_referenced ? <p className="pb-3 text-xs text-fg-subtle">Referenced parties can be archived but not deleted.</p> : null}
          </CardBody>
        </Card>
      }
      ownership={
        <div className="space-y-6">
          <Card>
            <CardBody className="text-[13px] text-fg-muted">
              {party.references.ownership_shares ? (
                <>
                  {party.name} holds <span className="font-medium text-fg">{pluralize(party.references.ownership_shares, "ownership share")}</span>. Open an asset below to review its splits in Rights & ownership.
                </>
              ) : (
                <>{party.name} has no ownership shares recorded yet. Shares are added per work or recording in Rights & ownership.</>
              )}
            </CardBody>
          </Card>
          <RelatedList
            title="Works"
            items={works.data?.items ?? []}
            empty={works.isLoading ? "Loading…" : "Not credited on any work."}
            getKey={(work) => work.id}
            render={(work) => (
              <RelatedLink
                href={entityHref("work", work.id)}
                title={work.title}
                aside={
                  <ButtonLink size="xs" variant="outline" leftIcon={<FileText aria-hidden />} href={`/rights?asset_type=work&asset_id=${encodeURIComponent(work.id)}`}>
                    Ownership
                  </ButtonLink>
                }
              />
            )}
          />
          <RelatedList
            title="Recordings"
            items={recordings.data?.items ?? []}
            empty={recordings.isLoading ? "Loading…" : "Not on any recording."}
            getKey={(recording) => recording.id}
            render={(recording) => (
              <RelatedLink
                href={entityHref("recording", recording.id)}
                title={recording.title}
                aside={
                  <ButtonLink size="xs" variant="outline" leftIcon={<Mic2 aria-hidden />} href={`/rights?asset_type=recording&asset_id=${encodeURIComponent(recording.id)}`}>
                    Ownership
                  </ButtonLink>
                }
              />
            )}
          />
        </div>
      }
      overview={
        <>
          <MetadataCard
            title="Profile"
            items={[
              { label: "Type", value: codeLabel(party.party_type) },
              { label: "Legal name", value: party.legal_name ?? "—" },
              { label: "Email", value: party.email ? <a href={`mailto:${party.email}`} className="hover:text-primary hover:underline">{party.email}</a> : "—" },
              { label: "Country", value: party.country_code ?? "—" },
              { label: "IPI name number", value: party.ipi_number ?? "—", mono: true },
              { label: "ISNI", value: party.isni ? formatIsni(party.isni) : "—", mono: true },
              { label: "PRO", value: party.pro_affiliation ?? "—" },
              { label: "Internal", value: party.is_internal ? "Yes" : "No" },
              ...externalIdItems(party.external_ids),
            ]}
          />
          <PartyAssets orgId={org.id} partyId={party.id} />
          <NotesCard notes={party.notes} />
        </>
      }
    />
  );
}
