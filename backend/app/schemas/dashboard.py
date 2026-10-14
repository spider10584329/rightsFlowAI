"""Dashboard and analytics schemas. Money is serialized as strings and is
never converted between currencies."""

from datetime import date, datetime

from pydantic import BaseModel

from app.schemas.common import DecimalStr


class CurrencyAmount(BaseModel):
    currency: str
    amount: DecimalStr


class CurrencyAmountCount(CurrencyAmount):
    count: int


class MoneyByCurrency(BaseModel):
    """``amount`` is in ``currency``; other currencies are listed separately."""

    currency: str
    amount: DecimalStr
    other_currencies: list[CurrencyAmount]


class YearMoneyByCurrency(MoneyByCurrency):
    year: int


class CatalogCounts(BaseModel):
    works: int
    recordings: int
    releases: int
    parties: int


class ConflictCounts(BaseModel):
    total: int
    by_severity: dict[str, int]


class UnmatchedTransactions(BaseModel):
    count: int
    primary_count: int
    currency: str
    amount: DecimalStr
    other_currencies: list[CurrencyAmountCount]


class ReportedRoyalties(BaseModel):
    all_time: MoneyByCurrency
    current_year: YearMoneyByCurrency


class PayableBalance(BaseModel):
    currency: str
    gross_balance: DecimalStr
    reserved_in_payouts: DecimalStr
    available: DecimalStr
    payee_count: int


class PayableBalances(PayableBalance):
    other_currencies: list[PayableBalance]


class ActivityItem(BaseModel):
    id: str
    action: str
    entity_type: str | None = None
    entity_id: str | None = None
    summary: str | None = None
    actor_name: str | None = None
    created_at: datetime


class RecentStatement(BaseModel):
    id: str
    source_name: str
    source_category: str
    period_start: date
    period_end: date
    currency: str
    status: str
    total_rows: int
    valid_rows: int
    matched_rows: int
    total_amount: DecimalStr
    created_at: datetime


class ExpiringContract(BaseModel):
    id: str
    title: str
    reference: str | None = None
    contract_type: str
    end_date: date
    days_remaining: int
    auto_renew: bool


class DashboardSummary(BaseModel):
    primary_currency: str
    as_of: datetime
    catalog: CatalogCounts
    active_contracts: int
    open_conflicts: ConflictCounts
    unmatched_transactions: UnmatchedTransactions
    reported_royalties: ReportedRoyalties
    payable_balances: PayableBalances
    recent_catalog_activity: list[ActivityItem]
    recent_statements: list[RecentStatement]
    upcoming_contract_expirations: list[ExpiringContract]


class MonthAmount(BaseModel):
    month: str
    amount: DecimalStr


class RoyaltiesOverTime(BaseModel):
    currency: str
    primary_currency: str
    months: int
    period_start: date
    period_end: date
    total: DecimalStr
    series: list[MonthAmount]
    other_currencies: list[CurrencyAmount]


class _Breakdown(BaseModel):
    currency: str
    primary_currency: str
    period_start: date | None = None
    period_end: date | None = None
    total: DecimalStr
    other_currencies: list[CurrencyAmount]


class SourceItem(BaseModel):
    source_category: str
    source_name: str
    amount: DecimalStr
    line_count: int


class RevenueBySource(_Breakdown):
    items: list[SourceItem]


class TerritoryItem(BaseModel):
    territory: str
    amount: DecimalStr
    line_count: int


class RevenueByTerritory(_Breakdown):
    items: list[TerritoryItem]


class TopWorkItem(BaseModel):
    work_id: str
    title: str
    iswc: str | None = None
    amount: DecimalStr
    line_count: int


class TopWorks(_Breakdown):
    items: list[TopWorkItem]


class TopRecordingItem(BaseModel):
    recording_id: str
    title: str
    isrc: str | None = None
    display_artist: str | None = None
    amount: DecimalStr
    line_count: int


class TopRecordings(_Breakdown):
    items: list[TopRecordingItem]


class PartyOwnership(BaseModel):
    party_id: str
    party_name: str
    share_count: int
    total_share_percent: DecimalStr
    weighted_asset_count: DecimalStr


class RightsTypeControl(BaseModel):
    rights_type: str
    controlled: int
    non_controlled: int


class OwnershipDistribution(BaseModel):
    total_active_shares: int
    by_party: list[PartyOwnership]
    by_rights_type: list[RightsTypeControl]


class GrowthPoint(BaseModel):
    month: str
    works: int
    recordings: int
    releases: int
    works_total: int
    recordings_total: int
    releases_total: int


class CatalogGrowth(BaseModel):
    months: int
    baseline: dict[str, int]
    series: list[GrowthPoint]
