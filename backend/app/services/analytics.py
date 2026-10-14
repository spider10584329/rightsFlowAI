"""Dashboard analytics computed from an organization's own data.

Rules:
- Every query is filtered by ``organization_id``.
- Nothing is estimated or invented: no data means zeros and empty lists.
- No FX conversion. Money is grouped by currency; callers pick one currency
  (default: the organization's ``default_currency``) and receive the totals
  for the other currencies separately.
- Money is ``Decimal`` end to end.

Definitions:
- *Reported royalties*: ``SUM(StatementLine.amount)`` for valid lines of
  statements in ``processed``, ``calculated`` or ``posted`` status. The
  currency is ``COALESCE(line.currency, statement.currency)``.
- *Period filters* (``period_start``/``period_end``) select statements whose
  ``period_end`` falls inside the range (inclusive).
"""

from collections import defaultdict
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import Select, and_, extract, func, select
from sqlalchemy.orm import Session

from app.core.errors import ValidationFailedError
from app.db.mixins import utc_now
from app.models.catalog import Party, Recording, RecordingWork, Release, Work
from app.models.contract import Contract
from app.models.platform import AuditLog
from app.models.rights import OwnershipShare, RightsConflict
from app.models.royalty import LedgerEntry, Payout, PayoutBatch, RoyaltyStatement, StatementLine
from app.models.user import User

REPORTED_STATUSES = ("processed", "calculated", "posted")
OPEN_CONFLICT_STATUSES = ("open", "acknowledged")
SEVERITIES = ("critical", "high", "medium", "low")
RESERVING_BATCH_STATUSES = ("pending_approval", "approved")
CATALOG_ENTITY_TYPES = ("work", "recording", "release", "party")
EXPIRY_WINDOW_DAYS = 90

ZERO = Decimal("0")
_CENT = Decimal("0.01")
_MONEY_PLACES = Decimal("0.00000001")


def money(value: Any) -> Decimal:
    """Canonical money value: exact to 8 places, at least 2 decimals, no
    trailing zeros beyond that (``Decimal('150.5')`` -> ``150.50``)."""
    value = Decimal(value if value is not None else 0).quantize(_MONEY_PLACES)
    if value == value.quantize(_CENT):
        return value.quantize(_CENT)
    return value.normalize()


def _currency_expr():
    return func.coalesce(StatementLine.currency, RoyaltyStatement.currency)


def validate_period(period_start: date | None, period_end: date | None) -> None:
    if period_start and period_end and period_start > period_end:
        raise ValidationFailedError(
            "period_start must be on or before period_end", code="invalid_period"
        )


def _reported_lines(
    stmt: Select,
    organization_id: str,
    *,
    period_start: date | None = None,
    period_end: date | None = None,
    currency: str | None = None,
) -> Select:
    """Restrict ``stmt`` (which selects from StatementLine) to reported lines."""
    stmt = stmt.join_from(
        StatementLine, RoyaltyStatement, RoyaltyStatement.id == StatementLine.statement_id
    ).where(
        StatementLine.organization_id == organization_id,
        RoyaltyStatement.organization_id == organization_id,
        StatementLine.is_valid.is_(True),
        StatementLine.amount.is_not(None),
        RoyaltyStatement.status.in_(REPORTED_STATUSES),
    )
    if period_start:
        stmt = stmt.where(RoyaltyStatement.period_end >= period_start)
    if period_end:
        stmt = stmt.where(RoyaltyStatement.period_end <= period_end)
    if currency:
        stmt = stmt.where(_currency_expr() == currency)
    return stmt


def _split_by_currency(totals: dict[str, Decimal], primary: str) -> dict[str, Any]:
    """{currency: amount} -> primary amount plus the other currencies."""
    return {
        "currency": primary,
        "amount": money(totals.get(primary, ZERO)),
        "other_currencies": [
            {"currency": cur, "amount": money(amount)}
            for cur, amount in sorted(totals.items())
            if cur != primary
        ],
    }


def reported_totals_by_currency(
    db: Session,
    organization_id: str,
    *,
    period_start: date | None = None,
    period_end: date | None = None,
) -> dict[str, Decimal]:
    cur = _currency_expr()
    stmt = _reported_lines(
        select(cur, func.sum(StatementLine.amount)),
        organization_id,
        period_start=period_start,
        period_end=period_end,
    ).group_by(cur)
    return {c: Decimal(a or 0) for c, a in db.execute(stmt).all()}


# --------------------------------------------------------------------------- summary


def _count(db: Session, model, organization_id: str, *conditions) -> int:
    return int(
        db.scalar(
            select(func.count()).select_from(model).where(
                model.organization_id == organization_id, *conditions
            )
        )
        or 0
    )


def _conflicts(db: Session, organization_id: str) -> dict[str, Any]:
    rows = db.execute(
        select(RightsConflict.severity, func.count())
        .where(
            RightsConflict.organization_id == organization_id,
            RightsConflict.status.in_(OPEN_CONFLICT_STATUSES),
        )
        .group_by(RightsConflict.severity)
    ).all()
    by_severity = {s: 0 for s in SEVERITIES}
    for severity, count in rows:
        by_severity[severity] = int(count)
    return {"total": sum(by_severity.values()), "by_severity": by_severity}


def _unmatched(db: Session, organization_id: str, primary: str) -> dict[str, Any]:
    cur = _currency_expr()
    rows = db.execute(
        select(cur, func.count(), func.coalesce(func.sum(StatementLine.amount), 0))
        .join(RoyaltyStatement, RoyaltyStatement.id == StatementLine.statement_id)
        .where(
            StatementLine.organization_id == organization_id,
            RoyaltyStatement.organization_id == organization_id,
            StatementLine.is_valid.is_(True),
            StatementLine.match_status == "unmatched",
            RoyaltyStatement.status != "posted",
        )
        .group_by(cur)
    ).all()
    counts = {c: int(n) for c, n, _ in rows}
    amounts = {c: Decimal(a or 0) for c, _, a in rows}
    split = _split_by_currency(amounts, primary)
    for item in split["other_currencies"]:
        item["count"] = counts.get(item["currency"], 0)
    return {
        "count": sum(counts.values()),
        "primary_count": counts.get(primary, 0),
        **split,
    }


def payable_balances(db: Session, organization_id: str, primary: str) -> dict[str, Any]:
    """Outstanding payee balances per currency.

    ``gross``: sum of positive per-(payee, currency) ledger balances.
    ``reserved``: pending payouts in batches awaiting approval or approved.
    ``available``: per payee, ``max(balance - reserved, 0)``, summed.
    """
    balances = db.execute(
        select(LedgerEntry.payee_id, LedgerEntry.currency, func.sum(LedgerEntry.amount))
        .where(LedgerEntry.organization_id == organization_id)
        .group_by(LedgerEntry.payee_id, LedgerEntry.currency)
    ).all()
    reserved_rows = db.execute(
        select(Payout.payee_id, Payout.currency, func.sum(Payout.amount))
        .join(PayoutBatch, PayoutBatch.id == Payout.batch_id)
        .where(
            Payout.organization_id == organization_id,
            PayoutBatch.organization_id == organization_id,
            PayoutBatch.status.in_(RESERVING_BATCH_STATUSES),
            Payout.status == "pending",
        )
        .group_by(Payout.payee_id, Payout.currency)
    ).all()
    reserved_by_payee = {(p, c): Decimal(a or 0) for p, c, a in reserved_rows}

    per_currency: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"gross": ZERO, "reserved": ZERO, "available": ZERO, "payees": 0}
    )
    for payee_id, currency, balance in balances:
        balance = Decimal(balance or 0)
        if balance <= 0:
            continue
        reserved = reserved_by_payee.get((payee_id, currency), ZERO)
        bucket = per_currency[currency]
        bucket["gross"] += balance
        bucket["reserved"] += min(reserved, balance)
        bucket["available"] += max(balance - reserved, ZERO)
        bucket["payees"] += 1

    def _fmt(currency: str, bucket: dict[str, Any]) -> dict[str, Any]:
        return {
            "currency": currency,
            "gross_balance": money(bucket["gross"]),
            "reserved_in_payouts": money(bucket["reserved"]),
            "available": money(bucket["available"]),
            "payee_count": bucket["payees"],
        }

    empty = {"gross": ZERO, "reserved": ZERO, "available": ZERO, "payees": 0}
    return {
        **_fmt(primary, per_currency.get(primary, empty)),
        "other_currencies": [
            _fmt(cur, bucket) for cur, bucket in sorted(per_currency.items()) if cur != primary
        ],
    }


def _recent_activity(db: Session, organization_id: str) -> list[dict[str, Any]]:
    rows = db.execute(
        select(AuditLog, User.full_name)
        .outerjoin(User, User.id == AuditLog.actor_user_id)
        .where(
            AuditLog.organization_id == organization_id,
            AuditLog.entity_type.in_(CATALOG_ENTITY_TYPES),
        )
        .order_by(AuditLog.created_at.desc())
        .limit(10)
    ).all()
    return [
        {
            "id": log.id,
            "action": log.action,
            "entity_type": log.entity_type,
            "entity_id": log.entity_id,
            "summary": log.summary,
            "actor_name": name,
            "created_at": log.created_at,
        }
        for log, name in rows
    ]


def _recent_statements(db: Session, organization_id: str) -> list[dict[str, Any]]:
    rows = db.scalars(
        select(RoyaltyStatement)
        .where(RoyaltyStatement.organization_id == organization_id)
        .order_by(RoyaltyStatement.created_at.desc())
        .limit(5)
    ).all()
    return [
        {
            "id": s.id,
            "source_name": s.source_name,
            "source_category": s.source_category,
            "period_start": s.period_start,
            "period_end": s.period_end,
            "currency": s.currency,
            "status": s.status,
            "total_rows": s.total_rows,
            "valid_rows": s.valid_rows,
            "matched_rows": s.matched_rows,
            "total_amount": money(s.total_amount),
            "created_at": s.created_at,
        }
        for s in rows
    ]


def _expiring_contracts(db: Session, organization_id: str, today: date) -> list[dict[str, Any]]:
    horizon = today + timedelta(days=EXPIRY_WINDOW_DAYS)
    rows = db.scalars(
        select(Contract)
        .where(
            Contract.organization_id == organization_id,
            Contract.status == "active",
            Contract.end_date.is_not(None),
            Contract.end_date >= today,
            Contract.end_date <= horizon,
        )
        .order_by(Contract.end_date, Contract.title)
    ).all()
    return [
        {
            "id": c.id,
            "title": c.title,
            "reference": c.reference,
            "contract_type": c.contract_type,
            "end_date": c.end_date,
            "days_remaining": (c.end_date - today).days,
            "auto_renew": c.auto_renew,
        }
        for c in rows
    ]


def summary(db: Session, organization_id: str, primary_currency: str) -> dict[str, Any]:
    today = utc_now().date()
    not_archived = lambda model: model.status != "archived"  # noqa: E731
    all_time = reported_totals_by_currency(db, organization_id)
    this_year = reported_totals_by_currency(
        db, organization_id, period_start=date(today.year, 1, 1), period_end=date(today.year, 12, 31)
    )
    return {
        "primary_currency": primary_currency,
        "as_of": utc_now(),
        "catalog": {
            "works": _count(db, Work, organization_id, not_archived(Work)),
            "recordings": _count(db, Recording, organization_id, not_archived(Recording)),
            "releases": _count(db, Release, organization_id, not_archived(Release)),
            "parties": _count(db, Party, organization_id, not_archived(Party)),
        },
        "active_contracts": _count(db, Contract, organization_id, Contract.status == "active"),
        "open_conflicts": _conflicts(db, organization_id),
        "unmatched_transactions": _unmatched(db, organization_id, primary_currency),
        "reported_royalties": {
            "all_time": _split_by_currency(all_time, primary_currency),
            "current_year": {
                "year": today.year,
                **_split_by_currency(this_year, primary_currency),
            },
        },
        "payable_balances": payable_balances(db, organization_id, primary_currency),
        "recent_catalog_activity": _recent_activity(db, organization_id),
        "recent_statements": _recent_statements(db, organization_id),
        "upcoming_contract_expirations": _expiring_contracts(db, organization_id, today),
    }


# --------------------------------------------------------------------------- time series


def _month_range(months: int, today: date) -> list[tuple[int, int]]:
    result = []
    year, month = today.year, today.month
    for _ in range(months):
        result.append((year, month))
        month -= 1
        if month == 0:
            month, year = 12, year - 1
    return list(reversed(result))


def _month_label(year: int, month: int) -> str:
    return f"{int(year):04d}-{int(month):02d}"


def royalties_over_time(
    db: Session, organization_id: str, *, months: int, currency: str, primary_currency: str
) -> dict[str, Any]:
    today = utc_now().date()
    keys = _month_range(months, today)
    start = date(keys[0][0], keys[0][1], 1)
    end = date(today.year, today.month, 1) + timedelta(days=32)
    end = date(end.year, end.month, 1) - timedelta(days=1)  # last day of current month

    year_col = extract("year", RoyaltyStatement.period_end)
    month_col = extract("month", RoyaltyStatement.period_end)
    rows = db.execute(
        _reported_lines(
            select(year_col, month_col, func.sum(StatementLine.amount)),
            organization_id,
            period_start=start,
            period_end=end,
            currency=currency,
        ).group_by(year_col, month_col)
    ).all()
    found = {(int(y), int(m)): Decimal(a or 0) for y, m, a in rows}
    series = [
        {"month": _month_label(y, m), "amount": money(found.get((y, m), ZERO))} for y, m in keys
    ]
    other = reported_totals_by_currency(db, organization_id, period_start=start, period_end=end)
    return {
        "currency": currency,
        "primary_currency": primary_currency,
        "months": months,
        "period_start": start,
        "period_end": end,
        "total": money(sum(found.values(), ZERO)),
        "series": series,
        "other_currencies": [
            {"currency": c, "amount": money(a)} for c, a in sorted(other.items()) if c != currency
        ],
    }


# --------------------------------------------------------------------------- breakdowns


def _breakdown_envelope(
    db: Session,
    organization_id: str,
    *,
    currency: str,
    primary_currency: str,
    period_start: date | None,
    period_end: date | None,
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    totals = reported_totals_by_currency(
        db, organization_id, period_start=period_start, period_end=period_end
    )
    return {
        "currency": currency,
        "primary_currency": primary_currency,
        "period_start": period_start,
        "period_end": period_end,
        "total": money(totals.get(currency, ZERO)),
        "items": items,
        "other_currencies": [
            {"currency": c, "amount": money(a)} for c, a in sorted(totals.items()) if c != currency
        ],
    }


def revenue_by_source(db: Session, organization_id: str, *, currency: str, primary_currency: str,
                      period_start: date | None = None, period_end: date | None = None) -> dict:
    validate_period(period_start, period_end)
    total = func.sum(StatementLine.amount)
    rows = db.execute(
        _reported_lines(
            select(
                RoyaltyStatement.source_category,
                RoyaltyStatement.source_name,
                total,
                func.count(),
            ),
            organization_id,
            period_start=period_start,
            period_end=period_end,
            currency=currency,
        )
        .group_by(RoyaltyStatement.source_category, RoyaltyStatement.source_name)
        .order_by(total.desc(), RoyaltyStatement.source_name)
    ).all()
    items = [
        {"source_category": cat, "source_name": name, "amount": money(amount), "line_count": int(n)}
        for cat, name, amount, n in rows
    ]
    return _breakdown_envelope(db, organization_id, currency=currency,
                               primary_currency=primary_currency, period_start=period_start,
                               period_end=period_end, items=items)


def revenue_by_territory(db: Session, organization_id: str, *, currency: str,
                         primary_currency: str, period_start: date | None = None,
                         period_end: date | None = None) -> dict:
    validate_period(period_start, period_end)
    territory = func.coalesce(func.nullif(StatementLine.territory, ""), "Unknown")
    total = func.sum(StatementLine.amount)
    rows = db.execute(
        _reported_lines(
            select(territory, total, func.count()),
            organization_id,
            period_start=period_start,
            period_end=period_end,
            currency=currency,
        )
        .group_by(territory)
        .order_by(total.desc(), territory)
    ).all()
    items = [
        {"territory": t, "amount": money(amount), "line_count": int(n)} for t, amount, n in rows
    ]
    return _breakdown_envelope(db, organization_id, currency=currency,
                               primary_currency=primary_currency, period_start=period_start,
                               period_end=period_end, items=items)


def top_works(db: Session, organization_id: str, *, currency: str, primary_currency: str,
              limit: int = 10, period_start: date | None = None,
              period_end: date | None = None) -> dict:
    """Lines matched to a work count for it directly; lines matched only to
    a recording count for the recording's work when exactly one work is linked."""
    validate_period(period_start, period_end)
    single_link = (
        select(
            RecordingWork.recording_id.label("recording_id"),
            func.min(RecordingWork.work_id).label("work_id"),
        )
        .where(RecordingWork.organization_id == organization_id)
        .group_by(RecordingWork.recording_id)
        .having(func.count() == 1)
        .subquery()
    )
    work_id = func.coalesce(StatementLine.work_id, single_link.c.work_id)
    attributed = (
        _reported_lines(
            select(
                work_id.label("work_id"),
                StatementLine.amount.label("amount"),
            ).select_from(StatementLine).outerjoin(
                single_link,
                and_(
                    StatementLine.work_id.is_(None),
                    single_link.c.recording_id == StatementLine.recording_id,
                ),
            ),
            organization_id,
            period_start=period_start,
            period_end=period_end,
            currency=currency,
        )
        .where(work_id.is_not(None))
        .subquery()
    )
    total = func.sum(attributed.c.amount)
    rows = db.execute(
        select(Work.id, Work.title, Work.iswc, total, func.count())
        .join(Work, and_(Work.id == attributed.c.work_id, Work.organization_id == organization_id))
        .group_by(Work.id, Work.title, Work.iswc)
        .order_by(total.desc(), Work.title)
        .limit(limit)
    ).all()
    items = [
        {"work_id": wid, "title": title, "iswc": iswc, "amount": money(amount), "line_count": int(n)}
        for wid, title, iswc, amount, n in rows
    ]
    return _breakdown_envelope(db, organization_id, currency=currency,
                               primary_currency=primary_currency, period_start=period_start,
                               period_end=period_end, items=items)


def top_recordings(db: Session, organization_id: str, *, currency: str, primary_currency: str,
                   limit: int = 10, period_start: date | None = None,
                   period_end: date | None = None) -> dict:
    validate_period(period_start, period_end)
    total = func.sum(StatementLine.amount)
    rows = db.execute(
        _reported_lines(
            select(
                Recording.id,
                Recording.title,
                Recording.isrc,
                Recording.display_artist,
                total,
                func.count(),
            ).select_from(StatementLine).join(
                Recording,
                and_(
                    Recording.id == StatementLine.recording_id,
                    Recording.organization_id == organization_id,
                ),
            ),
            organization_id,
            period_start=period_start,
            period_end=period_end,
            currency=currency,
        )
        .group_by(Recording.id, Recording.title, Recording.isrc, Recording.display_artist)
        .order_by(total.desc(), Recording.title)
        .limit(limit)
    ).all()
    items = [
        {
            "recording_id": rid,
            "title": title,
            "isrc": isrc,
            "display_artist": artist,
            "amount": money(amount),
            "line_count": int(n),
        }
        for rid, title, isrc, artist, amount, n in rows
    ]
    return _breakdown_envelope(db, organization_id, currency=currency,
                               primary_currency=primary_currency, period_start=period_start,
                               period_end=period_end, items=items)


# --------------------------------------------------------------------------- rights & catalog


def ownership_distribution(db: Session, organization_id: str, limit: int = 10) -> dict:
    """Active ownership shares. ``weighted_asset_count`` is the sum of
    share_percent / 100 (a 50% share of one asset counts as 0.5)."""
    share_sum = func.sum(OwnershipShare.share_percent)
    party_rows = db.execute(
        select(Party.id, Party.name, func.count(), share_sum)
        .join(Party, and_(Party.id == OwnershipShare.party_id,
                          Party.organization_id == organization_id))
        .where(OwnershipShare.organization_id == organization_id,
               OwnershipShare.status == "active")
        .group_by(Party.id, Party.name)
        .order_by(share_sum.desc(), Party.name)
        .limit(limit)
    ).all()
    rights_rows = db.execute(
        select(OwnershipShare.rights_type, OwnershipShare.is_controlled, func.count())
        .where(OwnershipShare.organization_id == organization_id,
               OwnershipShare.status == "active")
        .group_by(OwnershipShare.rights_type, OwnershipShare.is_controlled)
    ).all()
    by_rights: dict[str, dict[str, int]] = defaultdict(lambda: {"controlled": 0, "non_controlled": 0})
    for rights_type, controlled, count in rights_rows:
        by_rights[rights_type]["controlled" if controlled else "non_controlled"] += int(count)
    return {
        "total_active_shares": sum(c["controlled"] + c["non_controlled"] for c in by_rights.values()),
        "by_party": [
            {
                "party_id": pid,
                "party_name": name,
                "share_count": int(n),
                "total_share_percent": money(total),
                "weighted_asset_count": money(Decimal(total or 0) / 100),
            }
            for pid, name, n, total in party_rows
        ],
        "by_rights_type": [
            {"rights_type": rt, **counts} for rt, counts in sorted(by_rights.items())
        ],
    }


def catalog_growth(db: Session, organization_id: str, months: int) -> dict:
    """Works/recordings/releases created per month (excluding archived items,
    so the running totals end at the current catalog size)."""
    today = utc_now().date()
    keys = _month_range(months, today)
    start = datetime(keys[0][0], keys[0][1], 1)
    series = {key: {} for key in keys}
    baseline: dict[str, int] = {}
    for name, model in (("works", Work), ("recordings", Recording), ("releases", Release)):
        base = [model.organization_id == organization_id, model.status != "archived"]
        baseline[name] = int(
            db.scalar(select(func.count()).select_from(model).where(*base, model.created_at < start))
            or 0
        )
        y, m = extract("year", model.created_at), extract("month", model.created_at)
        rows = db.execute(
            select(y, m, func.count()).where(*base, model.created_at >= start).group_by(y, m)
        ).all()
        found = {(int(yy), int(mm)): int(n) for yy, mm, n in rows}
        for key in keys:
            series[key][name] = found.get(key, 0)

    running = dict(baseline)
    points = []
    for key in keys:
        point: dict[str, Any] = {"month": _month_label(*key)}
        for name in ("works", "recordings", "releases"):
            running[name] += series[key][name]
            point[name] = series[key][name]
            point[f"{name}_total"] = running[name]
        points.append(point)
    return {"months": months, "baseline": baseline, "series": points}
