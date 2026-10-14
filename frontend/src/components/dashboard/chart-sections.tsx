"use client";

import { BarChart3, FileSpreadsheet, Globe2, Library, PieChart, Upload } from "lucide-react";
import { useMemo } from "react";

import { ChartCard, DataGrid } from "@/components/dashboard/chart-card";
import { MonthlyColumns, MultiLineChart, RankedBars, SplitBars } from "@/components/dashboard/charts";
import {
  formatCount,
  formatMoney,
  monthLabel,
  otherCurrenciesNote,
  toDisplayNumber,
  toMonthlyPoints,
  toRankedItems,
  type RankedItem,
} from "@/components/dashboard/format";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  useCatalogGrowth,
  useOwnershipDistribution,
  useRevenueBySource,
  useRevenueByTerritory,
  useRoyaltiesOverTime,
  useTopRecordings,
  useTopWorks,
} from "@/lib/api/hooks/dashboard";
import { pluralize, titleCase } from "@/lib/utils";

interface CurrencyChartProps {
  orgId: string;
  currency: string;
  canEdit: boolean;
}

function NoRoyaltiesEmpty({ currency, canEdit, title }: { currency: string; canEdit: boolean; title: string }) {
  return (
    <EmptyState
      compact
      icon={<FileSpreadsheet aria-hidden />}
      title={title}
      description={`Nothing has been reported in ${currency} yet. Charts fill in once statements are processed.`}
      action={
        canEdit ? (
          <ButtonLink href="/royalties/statements" size="sm" variant="outline" leftIcon={<Upload aria-hidden />}>
            Import your first statement
          </ButtonLink>
        ) : null
      }
    />
  );
}

function OtherCurrencyFootnote({ list }: { list: { currency: string; amount: string }[] | undefined }) {
  const note = otherCurrenciesNote(list);
  return note ? <>Not included (other currencies, no FX conversion): {note}</> : null;
}

export function RoyaltiesOverTimeCard({ orgId, currency, canEdit }: CurrencyChartProps) {
  const query = useRoyaltiesOverTime(orgId, { currency, months: 12 });
  const data = query.data;
  const points = useMemo(() => (data ? toMonthlyPoints(data.series) : []), [data]);
  const isEmpty = points.every((point) => point.value === 0);
  const peak = points.reduce<(typeof points)[number] | null>((best, point) => (best === null || point.value > best.value ? point : best), null);
  const summary =
    data && peak
      ? `${formatMoney(data.total, data.currency)} reported in ${data.currency} from ${monthLabel(points[0]?.key ?? "").long} to ${monthLabel(points[points.length - 1]?.key ?? "").long}. Highest month: ${peak.longLabel} with ${formatMoney(peak.amount, data.currency)}.`
      : null;

  return (
    <ChartCard
      title="Royalties over time"
      description={`Reported royalties per month of statement period end · last 12 months · ${currency}`}
      summary={summary}
      isLoading={query.isLoading}
      isFetching={query.isFetching}
      error={query.error}
      onRetry={() => void query.refetch()}
      isEmpty={!query.isLoading && !query.error && isEmpty}
      empty={<NoRoyaltiesEmpty currency={currency} canEdit={canEdit} title="No royalties in the last 12 months" />}
      skeletonClassName="h-64"
      footnote={<OtherCurrencyFootnote list={data?.other_currencies} />}
      table={
        data ? (
          <DataGrid
            caption={`Reported royalties per month in ${data.currency}`}
            columns={[
              { key: "month", header: "Month" },
              { key: "amount", header: `Amount (${data.currency})`, align: "right" },
            ]}
            rows={points.map((point) => ({ key: point.key, cells: { month: point.longLabel, amount: formatMoney(point.amount, data.currency) } }))}
          />
        ) : null
      }
    >
      {data ? <MonthlyColumns points={points} currency={data.currency} seriesLabel="Reported royalties" /> : null}
    </ChartCard>
  );
}

function rankedSummary(items: RankedItem[], total: string, currency: string, noun: string): string | null {
  const top = items[0];
  if (!top) return null;
  return `${formatMoney(total, currency)} across ${items.length} ${noun}. Largest: ${top.label} with ${formatMoney(top.amount, currency)}.`;
}

function rankedTable(caption: string, items: RankedItem[], currency: string, header: string, extra?: (item: RankedItem) => string) {
  return (
    <DataGrid
      caption={caption}
      columns={[
        { key: "label", header },
        ...(extra ? [{ key: "extra", header: "Detail" }] : []),
        { key: "amount", header: `Amount (${currency})`, align: "right" as const },
      ]}
      rows={items.map((item) => ({
        key: item.key,
        cells: { label: item.label, extra: extra?.(item) ?? "", amount: formatMoney(item.amount, currency) },
      }))}
    />
  );
}

export function RevenueBySourceCard({ orgId, currency, canEdit }: CurrencyChartProps) {
  const query = useRevenueBySource(orgId, { currency });
  const data = query.data;
  const items = useMemo(
    () =>
      data
        ? toRankedItems(data.items, (item) => ({
            key: `${item.source_category}|${item.source_name}`,
            label: item.source_name,
            sublabel: titleCase(item.source_category),
            amount: item.amount,
          }))
        : [],
    [data],
  );
  return (
    <ChartCard
      title="Revenue by source"
      description={`All reported periods · ${currency}`}
      summary={data ? rankedSummary(items, data.total, data.currency, items.length === 1 ? "source" : "sources") : null}
      isLoading={query.isLoading}
      isFetching={query.isFetching}
      error={query.error}
      onRetry={() => void query.refetch()}
      isEmpty={!query.isLoading && !query.error && items.length === 0}
      empty={<NoRoyaltiesEmpty currency={currency} canEdit={canEdit} title="No revenue sources yet" />}
      footnote={<OtherCurrencyFootnote list={data?.other_currencies} />}
      table={data ? rankedTable(`Revenue by source in ${data.currency}`, items, data.currency, "Source", (item) => item.sublabel ?? "") : null}
    >
      {data ? (
        <RankedBars items={items} formatValue={(item) => formatMoney(item.amount, data.currency, { compact: true })} moreHint={(n) => `${n} more in the table view.`} />
      ) : null}
    </ChartCard>
  );
}

export function RevenueByTerritoryCard({ orgId, currency, canEdit }: CurrencyChartProps) {
  const query = useRevenueByTerritory(orgId, { currency });
  const data = query.data;
  const items = useMemo(
    () =>
      data
        ? toRankedItems(data.items, (item) => ({
            key: item.territory,
            label: item.territory === "UNKNOWN" ? "Unknown territory" : item.territory,
            sublabel: pluralize(item.line_count, "line"),
            amount: item.amount,
          }))
        : [],
    [data],
  );
  return (
    <ChartCard
      title="Revenue by territory"
      description={`All reported periods · ${currency}`}
      summary={data ? rankedSummary(items, data.total, data.currency, items.length === 1 ? "territory" : "territories") : null}
      isLoading={query.isLoading}
      isFetching={query.isFetching}
      error={query.error}
      onRetry={() => void query.refetch()}
      isEmpty={!query.isLoading && !query.error && items.length === 0}
      empty={<NoRoyaltiesEmpty currency={currency} canEdit={canEdit} title="No territory data yet" />}
      footnote={<OtherCurrencyFootnote list={data?.other_currencies} />}
      table={data ? rankedTable(`Revenue by territory in ${data.currency}`, items, data.currency, "Territory", (item) => item.sublabel ?? "") : null}
    >
      {data ? (
        <RankedBars items={items} formatValue={(item) => formatMoney(item.amount, data.currency, { compact: true })} moreHint={(n) => `${n} more in the table view.`} />
      ) : null}
    </ChartCard>
  );
}

export function TopWorksCard({ orgId, currency, canEdit }: CurrencyChartProps) {
  const query = useTopWorks(orgId, { currency, limit: 10 });
  const data = query.data;
  const items = useMemo(
    () =>
      data
        ? toRankedItems(data.items, (item) => ({
            key: item.work_id,
            label: item.title,
            sublabel: item.iswc,
            href: `/catalog/works/${item.work_id}`,
            amount: item.amount,
          }))
        : [],
    [data],
  );
  return (
    <ChartCard
      title="Top works"
      description={`By matched royalties · ${currency}`}
      summary={items[0] && data ? `${items[0].label} leads with ${formatMoney(items[0].amount, data.currency)}.` : null}
      isLoading={query.isLoading}
      isFetching={query.isFetching}
      error={query.error}
      onRetry={() => void query.refetch()}
      isEmpty={!query.isLoading && !query.error && items.length === 0}
      empty={
        <EmptyState
          compact
          icon={<Library aria-hidden />}
          title="No matched works yet"
          description="Works appear here once statement lines are matched to them."
          action={canEdit ? <ButtonLink href="/catalog/works" size="sm" variant="outline">Add works</ButtonLink> : null}
        />
      }
      footnote={<OtherCurrencyFootnote list={data?.other_currencies} />}
      table={data ? rankedTable(`Top works in ${data.currency}`, items, data.currency, "Work", (item) => item.sublabel ?? "") : null}
    >
      {data ? <RankedBars items={items} max={10} formatValue={(item) => formatMoney(item.amount, data.currency, { compact: true })} /> : null}
    </ChartCard>
  );
}

export function TopRecordingsCard({ orgId, currency, canEdit }: CurrencyChartProps) {
  const query = useTopRecordings(orgId, { currency, limit: 10 });
  const data = query.data;
  const items = useMemo(
    () =>
      data
        ? toRankedItems(data.items, (item) => ({
            key: item.recording_id,
            label: item.title,
            sublabel: [item.display_artist, item.isrc].filter(Boolean).join(" · ") || null,
            href: `/catalog/recordings/${item.recording_id}`,
            amount: item.amount,
          }))
        : [],
    [data],
  );
  return (
    <ChartCard
      title="Top recordings"
      description={`By matched royalties · ${currency}`}
      summary={items[0] && data ? `${items[0].label} leads with ${formatMoney(items[0].amount, data.currency)}.` : null}
      isLoading={query.isLoading}
      isFetching={query.isFetching}
      error={query.error}
      onRetry={() => void query.refetch()}
      isEmpty={!query.isLoading && !query.error && items.length === 0}
      empty={
        <EmptyState
          compact
          icon={<BarChart3 aria-hidden />}
          title="No matched recordings yet"
          description="Recordings appear here once statement lines are matched by ISRC or manually."
          action={canEdit ? <ButtonLink href="/catalog/recordings" size="sm" variant="outline">Add recordings</ButtonLink> : null}
        />
      }
      footnote={<OtherCurrencyFootnote list={data?.other_currencies} />}
      table={data ? rankedTable(`Top recordings in ${data.currency}`, items, data.currency, "Recording", (item) => item.sublabel ?? "") : null}
    >
      {data ? <RankedBars items={items} max={10} formatValue={(item) => formatMoney(item.amount, data.currency, { compact: true })} /> : null}
    </ChartCard>
  );
}

export function OwnershipCard({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const query = useOwnershipDistribution(orgId, 8);
  const data = query.data;
  const parties = useMemo(
    () =>
      data
        ? toRankedItems(data.by_party, (party) => ({
            key: party.party_id,
            label: party.party_name,
            sublabel: `${formatCount(party.share_count)} shares`,
            href: `/catalog/parties/${party.party_id}`,
            amount: party.weighted_asset_count,
          }))
        : [],
    [data],
  );
  const rightsRows = (data?.by_rights_type ?? []).map((row) => ({
    key: row.rights_type,
    label: titleCase(row.rights_type),
    first: row.controlled,
    second: row.non_controlled,
  }));
  const formatAssets = (item: RankedItem) => `${(toDisplayNumber(item.amount) ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} assets`;

  return (
    <ChartCard
      title="Ownership distribution"
      description="Active ownership shares. A 50% share of one asset counts as 0.5 assets."
      summary={
        data && parties[0]
          ? `${formatCount(data.total_active_shares)} active shares. ${parties[0].label} holds the most (${formatAssets(parties[0])}).`
          : null
      }
      isLoading={query.isLoading}
      isFetching={query.isFetching}
      error={query.error}
      onRetry={() => void query.refetch()}
      isEmpty={!query.isLoading && !query.error && (data?.total_active_shares ?? 0) === 0}
      empty={
        <EmptyState
          compact
          icon={<PieChart aria-hidden />}
          title="No ownership shares recorded"
          description="Register writer and publisher splits on works and recordings to see who owns what."
          action={canEdit ? <ButtonLink href="/rights" size="sm" variant="outline">Manage rights</ButtonLink> : null}
        />
      }
      table={
        data ? (
          <div className="space-y-4">
            <DataGrid
              caption="Ownership by party"
              columns={[
                { key: "party", header: "Party" },
                { key: "shares", header: "Shares", align: "right" },
                { key: "percent", header: "Total share %", align: "right" },
                { key: "assets", header: "Weighted assets", align: "right" },
              ]}
              rows={data.by_party.map((party) => ({
                key: party.party_id,
                cells: {
                  party: party.party_name,
                  shares: formatCount(party.share_count),
                  percent: party.total_share_percent,
                  assets: party.weighted_asset_count,
                },
              }))}
            />
            <DataGrid
              caption="Controlled shares by rights type"
              columns={[
                { key: "type", header: "Rights type" },
                { key: "controlled", header: "Controlled", align: "right" },
                { key: "other", header: "Not controlled", align: "right" },
              ]}
              rows={rightsRows.map((row) => ({ key: row.key, cells: { type: row.label, controlled: formatCount(row.first), other: formatCount(row.second) } }))}
            />
          </div>
        ) : null
      }
    >
      {data ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Top parties</h3>
            <RankedBars items={parties} formatValue={formatAssets} />
          </div>
          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">Control by rights type</h3>
            {rightsRows.length > 0 ? <SplitBars rows={rightsRows} labels={["Controlled", "Not controlled"]} /> : <p className="text-[13px] text-fg-muted">No rights types yet.</p>}
          </div>
        </div>
      ) : null}
    </ChartCard>
  );
}

export function CatalogGrowthCard({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const query = useCatalogGrowth(orgId, 12);
  const data = query.data;
  const points = useMemo(
    () =>
      (data?.series ?? []).map((point) => {
        const label = monthLabel(point.month);
        return {
          key: point.month,
          label: label.short,
          longLabel: label.long,
          works: point.works_total,
          recordings: point.recordings_total,
          releases: point.releases_total,
          added: { works: point.works, recordings: point.recordings, releases: point.releases },
        };
      }),
    [data],
  );
  const last = points[points.length - 1];
  const isEmpty = !last || last.works + last.recordings + last.releases === 0;
  const series = [
    { key: "works", label: "Works" },
    { key: "recordings", label: "Recordings" },
    { key: "releases", label: "Releases" },
  ];
  const addedWorks = points.reduce((sum, point) => sum + point.added.works, 0);
  const addedRecordings = points.reduce((sum, point) => sum + point.added.recordings, 0);

  return (
    <ChartCard
      title="Catalog growth"
      description="Running totals of works, recordings and releases · last 12 months (archived items excluded)"
      summary={
        last
          ? `Catalog now holds ${formatCount(last.works)} works, ${formatCount(last.recordings)} recordings and ${formatCount(last.releases)} releases; ${formatCount(addedWorks)} works and ${formatCount(addedRecordings)} recordings were added in the last 12 months.`
          : null
      }
      isLoading={query.isLoading}
      isFetching={query.isFetching}
      error={query.error}
      onRetry={() => void query.refetch()}
      isEmpty={!query.isLoading && !query.error && isEmpty}
      empty={
        <EmptyState
          compact
          icon={<Globe2 aria-hidden />}
          title="Your catalog is empty"
          description="Add works and recordings, or import a catalog spreadsheet, to track growth."
          action={canEdit ? <ButtonLink href="/catalog/works" size="sm" variant="outline">Add works</ButtonLink> : null}
        />
      }
      skeletonClassName="h-64"
      table={
        <DataGrid
          caption="Catalog totals per month"
          columns={[
            { key: "month", header: "Month" },
            { key: "works", header: "Works (new)", align: "right" },
            { key: "recordings", header: "Recordings (new)", align: "right" },
            { key: "releases", header: "Releases (new)", align: "right" },
          ]}
          rows={points.map((point) => ({
            key: point.key,
            cells: {
              month: point.longLabel,
              works: `${formatCount(point.works)} (+${formatCount(point.added.works)})`,
              recordings: `${formatCount(point.recordings)} (+${formatCount(point.added.recordings)})`,
              releases: `${formatCount(point.releases)} (+${formatCount(point.added.releases)})`,
            },
          }))}
        />
      }
    >
      <MultiLineChart data={points} series={series} />
    </ChartCard>
  );
}
