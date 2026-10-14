"""Deterministic royalty anomaly detection over imported statement lines.

No AI is involved here: every anomaly is computed from ``StatementLine`` data
with explicit, explainable rules. The optional AI summary in
``features.summarize_anomalies`` only ever receives this module's output.

Rules
-----
negative_amount            line amount < 0
zero_quantity_with_amount  quantity == 0 but amount != 0
rate_outlier               per-unit rate (amount / quantity) far from the median of
                           its (store, usage_type) group, using the modified
                           z-score with the median absolute deviation (MAD)
period_swing               a recording's / work's period income is > 3x or < 1/3
                           of its trailing average (needs >= 3 prior periods)
duplicate_line             same isrc / territory / usage / amount / date within
                           one statement
currency_mismatch          line currency differs from the statement currency
"""

from collections import defaultdict
from datetime import date
from decimal import Decimal
from statistics import median
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import NotFoundError
from app.models.royalty import RoyaltyStatement, StatementLine

MIN_GROUP_SIZE = 5
Z_THRESHOLD = Decimal("3.5")
Z_HIGH = Decimal("7")
MAD_SCALE = Decimal("0.6745")
SWING_HIGH = Decimal("3")
SWING_LOW = Decimal("1") / Decimal("3")
TRAILING_PERIODS = 6
MIN_PRIOR_PERIODS = 3
MAX_LINE_IDS = 50
MAX_ANOMALIES = 1000
_SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}
_RATE_Q = Decimal("0.00000001")


def _s(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return format(value, "f")


def _months_back(anchor: date, months: int) -> date:
    total = anchor.year * 12 + (anchor.month - 1) - months
    return date(total // 12, total % 12 + 1, 1)


def _period_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _median(values: list[Decimal]) -> Decimal:
    return Decimal(median(values))


def detect_anomalies(
    db: Session,
    organization_id: str,
    *,
    statement_id: str | None = None,
    months: int = 12,
    max_lines: int = 100_000,
) -> dict[str, Any]:
    today = date.today()
    target: RoyaltyStatement | None = None
    if statement_id:
        target = db.scalar(
            select(RoyaltyStatement).where(
                RoyaltyStatement.id == statement_id,
                RoyaltyStatement.organization_id == organization_id,
            )
        )
        if target is None:
            raise NotFoundError("Statement not found")
        cutoff = _months_back(target.period_end, months)
    else:
        cutoff = _months_back(today, months)

    history_stmts = db.scalars(
        select(RoyaltyStatement).where(
            RoyaltyStatement.organization_id == organization_id,
            RoyaltyStatement.status != "failed",
            RoyaltyStatement.period_end >= cutoff,
        )
    ).all()
    statements = {s.id: s for s in history_stmts}
    if target is not None:
        statements[target.id] = target
        if target.period_end:
            # History never looks past the statement being analyzed.
            statements = {
                k: s for k, s in statements.items()
                if s.id == target.id or s.period_end <= target.period_end
            }
    target_ids = [target.id] if target is not None else list(statements)

    lines: list[Any] = []
    if target_ids:
        lines = list(
            db.execute(
                select(
                    StatementLine.id,
                    StatementLine.statement_id,
                    StatementLine.isrc,
                    StatementLine.territory,
                    StatementLine.usage_type,
                    StatementLine.store,
                    StatementLine.quantity,
                    StatementLine.amount,
                    StatementLine.currency,
                    StatementLine.transaction_date,
                    StatementLine.recording_id,
                    StatementLine.work_id,
                )
                .where(
                    StatementLine.organization_id == organization_id,
                    StatementLine.statement_id.in_(target_ids),
                    StatementLine.match_status != "ignored",
                )
                .order_by(StatementLine.statement_id, StatementLine.row_number)
                .limit(max_lines + 1)
            ).all()
        )
    truncated = len(lines) > max_lines
    lines = lines[:max_lines]

    anomalies: list[dict[str, Any]] = []
    anomalies += _line_rules(lines, statements)
    anomalies += _rate_outliers(lines)
    anomalies += _duplicates(lines)
    anomalies += _period_swings(db, organization_id, statements, target, lines)

    anomalies.sort(key=lambda a: (_SEVERITY_ORDER[a["severity"]], a["type"]))
    counts: dict[str, int] = defaultdict(int)
    for item in anomalies:
        counts[item["type"]] += 1
    if len(anomalies) > MAX_ANOMALIES:
        anomalies = anomalies[:MAX_ANOMALIES]
        truncated = True
    return {
        "statement_id": target.id if target else None,
        "months": months,
        "scanned_statements": len(target_ids),
        "scanned_lines": len(lines),
        "truncated": truncated,
        "counts_by_type": dict(counts),
        "anomalies": anomalies,
    }


def _anomaly(type_: str, severity: str, line: Any | None, explanation: str,
             metrics: dict[str, str | None], **extra: Any) -> dict[str, Any]:
    data = {
        "type": type_,
        "severity": severity,
        "statement_id": line.statement_id if line is not None else None,
        "line_ids": [line.id] if line is not None else [],
        "recording_id": line.recording_id if line is not None else None,
        "work_id": line.work_id if line is not None else None,
        "isrc": line.isrc if line is not None else None,
        "metrics": metrics,
        "explanation": explanation,
    }
    data.update(extra)
    return data


def _line_rules(lines: list[Any], statements: dict[str, RoyaltyStatement]) -> list[dict]:
    found = []
    for line in lines:
        if line.amount is not None and line.amount < 0:
            found.append(_anomaly(
                "negative_amount", "medium", line,
                "Line amount is negative. This may be a legitimate correction or chargeback, "
                "but should be confirmed with the source.",
                {"amount": _s(line.amount), "quantity": _s(line.quantity)},
            ))
        if line.quantity is not None and line.quantity == 0 and line.amount not in (None, 0):
            found.append(_anomaly(
                "zero_quantity_with_amount", "low", line,
                "Line reports zero units but a non-zero amount.",
                {"amount": _s(line.amount), "quantity": _s(line.quantity)},
            ))
        statement = statements.get(line.statement_id)
        if (statement is not None and line.currency
                and line.currency.upper() != statement.currency.upper()):
            found.append(_anomaly(
                "currency_mismatch", "high", line,
                f"Line currency {line.currency} differs from the statement currency "
                f"{statement.currency}; amounts may be summed incorrectly.",
                {"line_currency": line.currency, "statement_currency": statement.currency,
                 "amount": _s(line.amount)},
            ))
    return found


def _rate_outliers(lines: list[Any]) -> list[dict]:
    groups: dict[tuple, list[tuple[Any, Decimal]]] = defaultdict(list)
    for line in lines:
        if line.amount is None or line.quantity is None or line.quantity <= 0:
            continue
        rate = Decimal(line.amount) / Decimal(line.quantity)
        key = ((line.store or "").strip().lower(), (line.usage_type or "").strip().lower())
        groups[key].append((line, rate))

    found = []
    for (store, usage), items in groups.items():
        if len(items) < MIN_GROUP_SIZE:
            continue
        rates = [r for _, r in items]
        med = _median(rates)
        mad = _median([abs(r - med) for r in rates])
        for line, rate in items:
            deviation = abs(rate - med)
            z: Decimal | None = None
            if mad > 0:
                z = MAD_SCALE * deviation / mad
                is_outlier = z > Z_THRESHOLD
                severity = "high" if z > Z_HIGH else "medium"
            else:
                # All typical rates identical: flag anything > 50% away from them.
                is_outlier = med != 0 and deviation / abs(med) > Decimal("0.5")
                severity = "medium"
            if not is_outlier:
                continue
            found.append(_anomaly(
                "rate_outlier", severity, line,
                f"Per-unit rate {rate.quantize(_RATE_Q)} is far from the median "
                f"{med.quantize(_RATE_Q)} for store '{store or 'unknown'}' / usage "
                f"'{usage or 'unknown'}' ({len(items)} lines compared).",
                {
                    "rate": _s(rate.quantize(_RATE_Q)),
                    "group_median_rate": _s(med.quantize(_RATE_Q)),
                    "group_mad": _s(mad.quantize(_RATE_Q)),
                    "modified_z_score": _s(z.quantize(Decimal("0.01"))) if z is not None else None,
                    "group_size": str(len(items)),
                    "store": store or None,
                    "usage_type": usage or None,
                },
            ))
    return found


def _duplicates(lines: list[Any]) -> list[dict]:
    groups: dict[tuple, list[Any]] = defaultdict(list)
    for line in lines:
        if not line.isrc or line.amount is None:
            continue
        key = (
            line.statement_id,
            line.isrc.upper(),
            (line.territory or "").upper(),
            (line.usage_type or "").lower(),
            Decimal(line.amount),
            line.transaction_date,
        )
        groups[key].append(line)
    found = []
    for key, group in groups.items():
        if len(group) < 2:
            continue
        first = group[0]
        item = _anomaly(
            "duplicate_line", "medium", first,
            f"{len(group)} lines in the same statement share ISRC, territory, usage type, "
            "amount and transaction date. They may be double-reported.",
            {
                "occurrences": str(len(group)),
                "amount": _s(first.amount),
                "territory": first.territory,
                "usage_type": first.usage_type,
                "transaction_date": first.transaction_date.isoformat()
                if first.transaction_date else None,
            },
        )
        item["line_ids"] = [line.id for line in group][:MAX_LINE_IDS]
        found.append(item)
    return found


def _period_swings(
    db: Session,
    organization_id: str,
    statements: dict[str, RoyaltyStatement],
    target: RoyaltyStatement | None,
    target_lines: list[Any],
) -> list[dict]:
    if not statements:
        return []
    rows = db.execute(
        select(
            StatementLine.recording_id,
            StatementLine.work_id,
            StatementLine.statement_id,
            StatementLine.currency,
            func.sum(StatementLine.amount),
        )
        .where(
            StatementLine.organization_id == organization_id,
            StatementLine.statement_id.in_(list(statements)),
            StatementLine.match_status != "ignored",
            StatementLine.amount.is_not(None),
            (StatementLine.recording_id.is_not(None)) | (StatementLine.work_id.is_not(None)),
        )
        .group_by(
            StatementLine.recording_id, StatementLine.work_id, StatementLine.statement_id,
            StatementLine.currency,
        )
    ).all()

    # (entity_type, entity_id, currency) -> period -> total
    series: dict[tuple[str, str, str], dict[str, Decimal]] = defaultdict(
        lambda: defaultdict(lambda: Decimal("0"))
    )
    for recording_id, work_id, stmt_id, currency, total in rows:
        statement = statements[stmt_id]
        entity = ("recording", recording_id) if recording_id else ("work", work_id)
        cur = (currency or statement.currency).upper()
        series[(entity[0], entity[1], cur)][_period_key(statement.period_end)] += Decimal(total)

    period_of_statement = {sid: _period_key(s.period_end) for sid, s in statements.items()}
    target_period = _period_key(target.period_end) if target is not None else None

    lines_by_entity_period: dict[tuple[str, str, str], list[str]] = defaultdict(list)
    for line in target_lines:
        entity = ("recording", line.recording_id) if line.recording_id else (
            ("work", line.work_id) if line.work_id else None
        )
        if entity is None:
            continue
        lines_by_entity_period[(entity[0], entity[1], period_of_statement[line.statement_id])].append(
            line.id
        )

    found = []
    for (entity_type, entity_id, currency), by_period in series.items():
        periods = sorted(by_period)
        for idx, period in enumerate(periods):
            if target_period is not None and period != target_period:
                continue
            prior = periods[max(0, idx - TRAILING_PERIODS):idx]
            if len(prior) < MIN_PRIOR_PERIODS:
                continue
            avg = sum((by_period[p] for p in prior), Decimal("0")) / Decimal(len(prior))
            if avg <= 0:
                continue
            current = by_period[period]
            ratio = current / avg
            if SWING_LOW <= ratio <= SWING_HIGH:
                continue
            severity = "high" if ratio > 10 or ratio < Decimal("0.1") else "medium"
            direction = "spike" if ratio > SWING_HIGH else "drop"
            line_ids = lines_by_entity_period.get((entity_type, entity_id, period), [])
            found.append({
                "type": "period_swing",
                "severity": severity,
                "statement_id": target.id if target is not None else None,
                "line_ids": line_ids[:MAX_LINE_IDS],
                "recording_id": entity_id if entity_type == "recording" else None,
                "work_id": entity_id if entity_type == "work" else None,
                "isrc": None,
                "metrics": {
                    "period": period,
                    "period_amount": _s(current),
                    "trailing_average": _s(avg.quantize(_RATE_Q)),
                    "ratio": _s(ratio.quantize(Decimal("0.0001"))),
                    "prior_periods": str(len(prior)),
                    "currency": currency,
                },
                "explanation": (
                    f"Income {direction} for this {entity_type} in {period}: "
                    f"{_s(current)} {currency} vs trailing average "
                    f"{_s(avg.quantize(Decimal('0.01')))} over {len(prior)} prior periods."
                ),
            })
    return found
