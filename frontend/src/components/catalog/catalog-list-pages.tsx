"use client";

import { Disc3, FileText, Mic2, UsersRound } from "lucide-react";
import Link from "next/link";

import { CompletenessBar, IdentifierText, StatusBadge, VerificationBadge } from "@/components/catalog/catalog-badges";
import { CatalogList, type CatalogListConfig, type ListFilter } from "@/components/catalog/catalog-list";
import { formatDuration, formatIsrc, formatIswc } from "@/components/catalog/identifiers";
import { codeLabel, entityHref } from "@/components/catalog/labels";
import { Badge } from "@/components/ui/badge";
import { PARTY_ROLES, RELEASE_TYPES, type Party, type Recording, type Release, type Work } from "@/lib/api/hooks/catalog";
import { formatDate } from "@/lib/utils";

const VERIFICATION_FILTER: ListFilter = {
  key: "verification_status",
  label: "Verification",
  allLabel: "Any verification",
  options: (["unverified", "verified", "disputed"] as const).map((value) => ({ value, label: codeLabel(value) })),
};

function presenceFilter(key: string, label: string, identifier: string): ListFilter {
  return {
    key,
    label,
    allLabel: `Any ${identifier}`,
    options: [
      { value: "true", label: `Has ${identifier}` },
      { value: "false", label: `Missing ${identifier}` },
    ],
  };
}

function TitleCell({ href, title, sub }: { href: string; title: string; sub?: string | null }) {
  return (
    <div className="min-w-0 max-w-[22rem]">
      <Link href={href} className="block truncate font-medium text-fg hover:text-primary hover:underline" onClick={(event) => event.stopPropagation()}>
        {title}
      </Link>
      {sub ? <p className="truncate text-xs text-fg-subtle">{sub}</p> : null}
    </div>
  );
}

function names(list: { party_name: string | null }[], limit = 3): string {
  const all = list.map((item) => item.party_name).filter(Boolean) as string[];
  const shown = all.slice(0, limit).join(", ");
  return all.length > limit ? `${shown} +${all.length - limit}` : shown;
}

// ----------------------------------------------------------------- works

const WRITER_ROLES = new Set(["composer", "lyricist", "composer_lyricist", "arranger", "adapter", "translator"]);

const WORKS: CatalogListConfig<"work"> = {
  entity: "work",
  description: "Compositions with their writers, publishers and ISWCs.",
  searchPlaceholder: "Search title, code or ISWC",
  icon: <FileText aria-hidden />,
  importable: true,
  defaultSort: { key: "title", order: "asc" },
  titleOf: (work: Work) => work.title,
  filters: [VERIFICATION_FILTER, presenceFilter("has_iswc", "ISWC", "ISWC")],
  columns: [
    {
      id: "title",
      header: "Title",
      sortKey: "title",
      cell: (work) => <TitleCell href={entityHref("work", work.id)} title={work.title} sub={work.internal_code} />,
    },
    { id: "iswc", header: "ISWC", sortKey: "iswc", cell: (work) => <IdentifierText value={work.iswc ? formatIswc(work.iswc) : null} /> },
    {
      id: "writers",
      header: "Writers",
      hideOnMobile: true,
      cell: (work) => {
        const writers = names(work.contributors.filter((c) => WRITER_ROLES.has(c.role)));
        return writers ? <span className="text-[13px] text-fg-muted">{writers}</span> : <span className="text-xs italic text-fg-subtle">No writers</span>;
      },
    },
    { id: "status", header: "Status", sortKey: "status", cell: (work) => <StatusBadge status={work.status} /> },
    { id: "verification", header: "Verification", sortKey: "verification_status", hideOnMobile: true, cell: (work) => <VerificationBadge status={work.verification_status} /> },
    { id: "completeness", header: "Complete", hideOnMobile: true, cell: (work) => <CompletenessBar score={work.completeness.score} /> },
    { id: "updated", header: "Updated", sortKey: "updated_at", hideOnMobile: true, cell: (work) => <span className="whitespace-nowrap text-[13px] text-fg-muted">{formatDate(work.updated_at)}</span> },
  ],
};

export function WorksListClient() {
  return <CatalogList config={WORKS} />;
}

// ----------------------------------------------------------------- recordings

const RECORDINGS: CatalogListConfig<"recording"> = {
  entity: "recording",
  description: "Master recordings with ISRCs, credits and links to the underlying works.",
  searchPlaceholder: "Search title, artist, code or ISRC",
  icon: <Mic2 aria-hidden />,
  importable: true,
  defaultSort: { key: "title", order: "asc" },
  titleOf: (recording: Recording) => (recording.version_title ? `${recording.title} (${recording.version_title})` : recording.title),
  filters: [
    VERIFICATION_FILTER,
    presenceFilter("has_isrc", "ISRC", "ISRC"),
    { key: "has_work", label: "Linked work", allLabel: "Any work link", options: [{ value: "true", label: "Linked to a work" }, { value: "false", label: "No linked work" }] },
  ],
  columns: [
    {
      id: "title",
      header: "Title",
      sortKey: "title",
      cell: (recording) => (
        <TitleCell href={entityHref("recording", recording.id)} title={recording.title} sub={[recording.version_title, recording.artist].filter(Boolean).join(" · ") || null} />
      ),
    },
    { id: "isrc", header: "ISRC", sortKey: "isrc", cell: (recording) => <IdentifierText value={recording.isrc ? formatIsrc(recording.isrc) : null} /> },
    {
      id: "works",
      header: "Works",
      hideOnMobile: true,
      cell: (recording) =>
        recording.works.length > 0 ? (
          <span className="text-[13px] text-fg-muted">{recording.works.map((work) => work.title).join(", ")}</span>
        ) : (
          <Badge tone="warning">Not linked</Badge>
        ),
    },
    { id: "duration", header: "Time", sortKey: "duration_seconds", align: "right", hideOnMobile: true, cell: (recording) => <span className="tabular-nums text-fg-muted">{formatDuration(recording.duration_seconds)}</span> },
    {
      id: "status",
      header: "Status",
      sortKey: "status",
      cell: (recording) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge status={recording.status} />
          {recording.is_explicit ? <Badge tone="neutral">Explicit</Badge> : null}
        </div>
      ),
    },
    { id: "verification", header: "Verification", sortKey: "verification_status", hideOnMobile: true, cell: (recording) => <VerificationBadge status={recording.verification_status} /> },
    { id: "completeness", header: "Complete", hideOnMobile: true, cell: (recording) => <CompletenessBar score={recording.completeness.score} /> },
  ],
};

export function RecordingsListClient() {
  return <CatalogList config={RECORDINGS} />;
}

// ----------------------------------------------------------------- releases

const RELEASES: CatalogListConfig<"release"> = {
  entity: "release",
  description: "Albums, EPs and singles with UPCs and track lists.",
  searchPlaceholder: "Search title, artist, catalog no. or UPC",
  icon: <Disc3 aria-hidden />,
  defaultSort: { key: "title", order: "asc" },
  titleOf: (release: Release) => release.title,
  filters: [
    { key: "release_type", label: "Release type", allLabel: "All types", options: RELEASE_TYPES.map((value) => ({ value, label: codeLabel(value) })) },
    presenceFilter("has_upc", "UPC", "UPC"),
  ],
  columns: [
    {
      id: "title",
      header: "Title",
      sortKey: "title",
      cell: (release) => <TitleCell href={entityHref("release", release.id)} title={release.title} sub={[release.display_artist, release.label_name].filter(Boolean).join(" · ") || null} />,
    },
    { id: "type", header: "Type", sortKey: "release_type", cell: (release) => <Badge tone="primary">{codeLabel(release.release_type)}</Badge> },
    { id: "upc", header: "UPC", sortKey: "upc", cell: (release) => <IdentifierText value={release.upc} /> },
    { id: "tracks", header: "Tracks", align: "right", hideOnMobile: true, cell: (release) => <span className="tabular-nums text-fg-muted">{release.track_count}</span> },
    { id: "date", header: "Release date", sortKey: "release_date", hideOnMobile: true, cell: (release) => <span className="whitespace-nowrap text-[13px] text-fg-muted">{release.release_date ? formatDate(release.release_date) : "—"}</span> },
    { id: "status", header: "Status", sortKey: "status", cell: (release) => <StatusBadge status={release.status} /> },
    { id: "completeness", header: "Complete", hideOnMobile: true, cell: (release) => <CompletenessBar score={release.completeness.score} /> },
  ],
};

export function ReleasesListClient() {
  return <CatalogList config={RELEASES} />;
}

// ----------------------------------------------------------------- parties

const PARTIES: CatalogListConfig<"party"> = {
  entity: "party",
  description: "Artists, songwriters, publishers, labels and other contributors.",
  searchPlaceholder: "Search name, legal name, IPI or ISNI",
  icon: <UsersRound aria-hidden />,
  importable: true,
  defaultSort: { key: "name", order: "asc" },
  titleOf: (party: Party) => party.name,
  filters: [
    { key: "role", label: "Role", allLabel: "All roles", options: PARTY_ROLES.map((value) => ({ value, label: codeLabel(value) })) },
    { key: "party_type", label: "Type", allLabel: "People & companies", options: [{ value: "person", label: "People" }, { value: "company", label: "Companies" }] },
  ],
  columns: [
    {
      id: "name",
      header: "Name",
      sortKey: "name",
      cell: (party) => <TitleCell href={entityHref("party", party.id)} title={party.name} sub={party.legal_name && party.legal_name !== party.name ? party.legal_name : party.email} />,
    },
    { id: "type", header: "Type", sortKey: "party_type", hideOnMobile: true, cell: (party) => <span className="text-[13px] text-fg-muted">{codeLabel(party.party_type)}</span> },
    {
      id: "roles",
      header: "Roles",
      cell: (party) =>
        party.roles.length > 0 ? (
          <div className="flex max-w-[16rem] flex-wrap gap-1">
            {party.roles.map((role) => (
              <Badge key={role}>{codeLabel(role)}</Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs italic text-fg-subtle">No roles</span>
        ),
    },
    { id: "ipi", header: "IPI", cell: (party) => <IdentifierText value={party.ipi_number} missingLabel="—" /> },
    { id: "pro", header: "PRO", hideOnMobile: true, cell: (party) => <span className="text-[13px] text-fg-muted">{party.pro_affiliation ?? "—"}</span> },
    {
      id: "status",
      header: "Status",
      sortKey: "status",
      cell: (party) => (
        <div className="flex items-center gap-1.5">
          <StatusBadge status={party.status} />
          {party.is_internal ? <Badge tone="accent">Internal</Badge> : null}
        </div>
      ),
    },
  ],
};

export function PartiesListClient() {
  return <CatalogList config={PARTIES} />;
}
