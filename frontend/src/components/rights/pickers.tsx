"use client";

import { Disc3, FileSignature, FileText, UserRound } from "lucide-react";
import { useState } from "react";

import { useContractOptions } from "@/lib/api/hooks/contracts";
import { useCatalogSearch, type AssetType } from "@/lib/api/hooks/rights";
import { titleCase } from "@/lib/utils";

import { SearchCombobox, type ComboOption } from "./search-combobox";

export interface PickedRef {
  id: string;
  label: string;
}

interface PickerProps {
  orgId: string;
  value: PickedRef | null;
  onChange: (value: PickedRef | null) => void;
  disabled?: boolean;
  id?: string;
  size?: "sm" | "md";
  placeholder?: string;
  clearable?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true | boolean;
}

function toRef(option: ComboOption | null): PickedRef | null {
  return option ? { id: option.id, label: option.label } : null;
}

/** Party (person / company) picker backed by `GET /parties?q=`. Archived parties are shown but disabled. */
export function PartyPicker({ orgId, value, onChange, placeholder = "Select party", className, ...rest }: PickerProps) {
  const [search, setSearch] = useState("");
  const [opened, setOpened] = useState(false);
  const query = useCatalogSearch(orgId, "parties", search, { enabled: opened });
  const options: ComboOption[] = (query.data?.items ?? []).map((party) => ({
    id: party.id,
    label: party.name,
    description: [party.roles.map(titleCase).join(", "), party.ipi_number ? `IPI ${party.ipi_number}` : null, party.status === "archived" ? "Archived" : null]
      .filter(Boolean)
      .join(" · "),
    disabled: party.status === "archived",
  }));
  return (
    <div className={className}>
      <SearchCombobox
        {...rest}
        onOpenChange={(open) => open && setOpened(true)}
        value={value ? { id: value.id, label: value.label } : null}
        onChange={(option) => onChange(toRef(option))}
        options={options}
        search={search}
        onSearchChange={setSearch}
        loading={query.isFetching}
        error={query.error}
        placeholder={placeholder}
        searchPlaceholder="Search parties by name or IPI"
        emptyText="No parties match. Add them in the catalog first."
        icon={<UserRound aria-hidden />}
      />
    </div>
  );
}

/** Work or recording picker backed by `GET /works?q=` / `GET /recordings?q=`. */
export function AssetPicker({ orgId, assetType, value, onChange, placeholder, className, ...rest }: PickerProps & { assetType: AssetType }) {
  const [search, setSearch] = useState("");
  const [opened, setOpened] = useState(false);
  const works = useCatalogSearch(orgId, "works", search, { enabled: opened && assetType === "work" });
  const recordings = useCatalogSearch(orgId, "recordings", search, { enabled: opened && assetType === "recording" });
  const options: ComboOption[] =
    assetType === "work"
      ? (works.data?.items ?? []).map((work) => ({
          id: work.id,
          label: work.title,
          description: [work.iswc_display ?? work.iswc, work.contributors.map((c) => c.party_name).filter(Boolean).slice(0, 3).join(", ")]
            .filter(Boolean)
            .join(" · "),
        }))
      : (recordings.data?.items ?? []).map((recording) => ({
          id: recording.id,
          label: recording.version_title ? `${recording.title} (${recording.version_title})` : recording.title,
          description: [recording.isrc, recording.display_artist ?? recording.primary_artist_name].filter(Boolean).join(" · "),
        }));
  const active = assetType === "work" ? works : recordings;
  return (
    <div className={className}>
      <SearchCombobox
        {...rest}
        onOpenChange={(open) => open && setOpened(true)}
        value={value}
        onChange={(option) => onChange(toRef(option))}
        options={options}
        search={search}
        onSearchChange={setSearch}
        loading={active.isFetching}
        error={active.error}
        placeholder={placeholder ?? (assetType === "work" ? "Select a work" : "Select a recording")}
        searchPlaceholder={assetType === "work" ? "Search works by title or ISWC" : "Search recordings by title, artist or ISRC"}
        emptyText={assetType === "work" ? "No works match." : "No recordings match."}
        icon={assetType === "work" ? <FileText aria-hidden /> : <Disc3 aria-hidden />}
      />
    </div>
  );
}

/** Contract picker (title / reference search) for linking shares to agreements. */
export function ContractPicker({ orgId, value, onChange, placeholder = "No contract", className, ...rest }: PickerProps) {
  const [search, setSearch] = useState("");
  const [opened, setOpened] = useState(false);
  const query = useContractOptions(orgId, search, { enabled: opened });
  const options: ComboOption[] = (query.data?.items ?? []).map((contract) => ({
    id: contract.id,
    label: contract.title,
    description: [contract.reference, titleCase(contract.contract_type), titleCase(contract.status)].filter(Boolean).join(" · "),
  }));
  return (
    <div className={className}>
      <SearchCombobox
        {...rest}
        onOpenChange={(open) => open && setOpened(true)}
        clearable
        value={value}
        onChange={(option) => onChange(toRef(option))}
        options={options}
        search={search}
        onSearchChange={setSearch}
        loading={query.isFetching}
        error={query.error}
        placeholder={placeholder}
        searchPlaceholder="Search contracts by title or reference"
        emptyText="No contracts match."
        icon={<FileSignature aria-hidden />}
      />
    </div>
  );
}
