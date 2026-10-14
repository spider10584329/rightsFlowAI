"""Rights ownership business rules.

Core ideas
----------
* An :class:`OwnershipShare` is one party's percentage of one rights type of one
  asset, for a territory scope and an effective date range.
* Totals are never a single global number. For each rights type the timeline is
  split at every effective boundary; inside each segment the total is computed
  per concrete country (``reference.expand``) and countries with an identical
  total / share set / rule are grouped back into a compact territory label.
  Adjacent segments with identical results are merged. A country is evaluated
  only when at least one claim in that segment covers it.
* Expected totals come from :class:`SplitRule` rows (most specific wins:
  rights_type + country > rights_type + WORLD > rights_type + NULL > default
  100% / 0.01 tolerance / under-allocation flagged / warn).
* ``analyze`` is a pure function used by dry-run validation, write-time rule
  enforcement and conflict detection, so all three always agree.
* Conflicts are persisted by a deterministic fingerprint and are never
  auto-resolved: a conflict that is no longer detected keeps its status and is
  flagged ``still_detected = false`` until a manager acts on it.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from fastapi import Request
from sqlalchemy import and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationFailedError
from app.core.permissions import OrgContext
from app.db.mixins import new_uuid, utc_now
from app.models.catalog import Party, Recording, Work
from app.models.contract import Contract
from app.models.organization import Organization
from app.models.platform import StoredFile
from app.models.rights import OwnershipShare, RightsConflict, SplitRule, SplitSheet
from app.services.audit import diff, record_audit, snapshot
from app.services.notifications import notify_org
from app.services.reference import (
    RECORDING_RIGHTS_TYPES,
    TERRITORIES,
    WORK_RIGHTS_TYPES,
    expand,
    is_valid_territory,
    territory_covers,
)

ZERO = Decimal("0.000000")
CLAIM_STATUSES = ("active", "disputed")
UNRESOLVED_STATUSES = ("open", "acknowledged")
ALL_COUNTRIES = frozenset(TERRITORIES)
SEVERITY_RANK = {"low": 1, "medium": 2, "high": 3, "critical": 4}
PRIMARY_RIGHTS = {"work": ("performance", "mechanical"), "recording": ("master",)}
# Fields of a verified share that may only change through supersession.
MATERIAL_FIELDS = (
    "party_id",
    "role",
    "share_percent",
    "territories",
    "excluded_territories",
    "effective_from",
    "effective_to",
    "is_controlled",
)
SHARE_EDITABLE_FIELDS = (*MATERIAL_FIELDS, "contract_id", "notes")


def rights_types_for(asset_type: str) -> tuple[str, ...]:
    return WORK_RIGHTS_TYPES if asset_type == "work" else RECORDING_RIGHTS_TYPES


# =========================================================================== formatting


def fmt_pct(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return f"{text}%"


PCT_QUANTUM = Decimal("0.000001")


def q6(value: Any) -> Decimal:
    """Percent at the storage scale (DECIMAL(9,6))."""
    return Decimal(str(value)).quantize(PCT_QUANTUM)


def dec_str(value: Decimal) -> str:
    return format(q6(value), "f")


def compact_territories(countries: Iterable[str]) -> tuple[list[str], list[str], str]:
    """(territories, excluded_territories, label) for a set of country codes."""
    countries = frozenset(countries)
    if countries == ALL_COUNTRIES:
        return ["WORLD"], [], "WORLD"
    if len(countries) > len(ALL_COUNTRIES) // 2:
        missing = sorted(ALL_COUNTRIES - countries)
        return ["WORLD"], missing, "WORLD excluding " + ", ".join(missing)
    codes = sorted(countries)
    label = ", ".join(codes[:25])
    if len(codes) > 25:
        label += f" and {len(codes) - 25} more"
    return codes, [], label


def short_label(label: str, count: int) -> str:
    return label if len(label) <= 60 else f"{count} territories"


def period_label(start: date | None, end: date | None) -> str:
    if start is None and end is None:
        return "all dates"
    if start is None:
        return f"until {end.isoformat()}"  # type: ignore[union-attr]
    if end is None:
        return f"from {start.isoformat()}"
    return f"{start.isoformat()} to {end.isoformat()}"


def _iso(value: date | None) -> str | None:
    return value.isoformat() if value else None


# =========================================================================== rules


@dataclass(frozen=True)
class EffectiveRule:
    expected_total: Decimal
    tolerance: Decimal
    allow_under_allocation: bool
    enforcement: str
    rule_id: str | None
    scope: str


DEFAULT_RULE = EffectiveRule(
    Decimal("100.000000"), Decimal("0.010000"), False, "warn", None, "default rule"
)


class RuleBook:
    """Resolves the most specific split rule per (rights_type, country)."""

    def __init__(self, rules: Iterable[Any] = ()) -> None:
        self._rules: dict[tuple[str, str | None], EffectiveRule] = {}
        for rule in rules:
            scope = f"split rule {rule.asset_type}/{rule.rights_type}/{rule.territory or 'all territories'}"
            self._rules[(rule.rights_type, rule.territory or None)] = EffectiveRule(
                q6(rule.expected_total),
                q6(rule.tolerance),
                bool(rule.allow_under_allocation),
                rule.enforcement,
                getattr(rule, "id", None),
                scope,
            )

    def for_country(self, rights_type: str, country: str | None) -> EffectiveRule:
        return (
            (self._rules.get((rights_type, country)) if country else None)
            or self._rules.get((rights_type, "WORLD"))
            or self._rules.get((rights_type, None))
            or DEFAULT_RULE
        )


def load_rules(db: Session, org_id: str, asset_type: str) -> RuleBook:
    rows = db.scalars(
        select(SplitRule).where(
            SplitRule.organization_id == org_id, SplitRule.asset_type == asset_type
        )
    ).all()
    return RuleBook(rows)


# =========================================================================== analysis model


@dataclass
class ShareView:
    """Storage-independent view of a share (persisted or proposed)."""

    id: str
    party_id: str
    party_name: str
    party_status: str
    role: str
    rights_type: str
    share_percent: Decimal
    territories: list[str]
    excluded: list[str]
    effective_from: date | None
    effective_to: date | None
    is_controlled: bool
    status: str = "active"
    verification_status: str = "unverified"
    countries: frozenset[str] = field(init=False)

    def __post_init__(self) -> None:
        self.share_percent = q6(self.share_percent)
        self.territories = list(self.territories or [])
        self.excluded = list(self.excluded or [])
        self.countries = frozenset(expand(self.territories, self.excluded))

    @property
    def dates_valid(self) -> bool:
        return not (self.effective_from and self.effective_to and self.effective_to < self.effective_from)

    def describe(self) -> str:
        return f"{self.party_name} ({self.role}, {fmt_pct(self.share_percent)}) [{self.id[:8]}]"

    def brief(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "party_id": self.party_id,
            "party_name": self.party_name,
            "role": self.role,
            "share_percent": dec_str(self.share_percent),
            "territories": self.territories,
            "excluded_territories": self.excluded,
            "effective_from": _iso(self.effective_from),
            "effective_to": _iso(self.effective_to),
            "is_controlled": self.is_controlled,
        }

    def active_on(self, day: date) -> bool:
        return (self.effective_from is None or self.effective_from <= day) and (
            self.effective_to is None or self.effective_to >= day
        )


def view_of(share: OwnershipShare) -> ShareView:
    party = share.party
    return ShareView(
        id=share.id,
        party_id=share.party_id,
        party_name=party.name if party else share.party_id,
        party_status=party.status if party else "active",
        role=share.role,
        rights_type=share.rights_type,
        share_percent=Decimal(share.share_percent),
        territories=share.territories or [],
        excluded=share.excluded_territories or [],
        effective_from=share.effective_from,
        effective_to=share.effective_to,
        is_controlled=share.is_controlled,
        status=share.status,
        verification_status=share.verification_status,
    )


@dataclass
class Finding:
    type: str
    severity: str
    rights_type: str | None
    title: str
    explanation: str
    details: dict[str, Any]
    share_ids: list[str]
    fingerprint: str
    blocking: bool = False
    enforcement: str | None = None
    # (type, rights_type, countries, start, end) for over/under comparisons.
    key: tuple | None = None
    deviation: Decimal | None = None
    countries: frozenset[str] | None = None
    period: tuple[date | None, date | None] | None = None

    def issue(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "severity": self.severity,
            "blocking": self.blocking,
            "enforcement": self.enforcement,
            "rights_type": self.rights_type,
            "title": self.title,
            "message": self.explanation,
            "share_ids": self.share_ids,
            "details": self.details,
        }


@dataclass
class Analysis:
    findings: list[Finding]
    totals: list[dict[str, Any]]

    def validation(self, rights_types: Iterable[str] | None = None) -> dict[str, Any]:
        wanted = set(rights_types) if rights_types is not None else None
        findings = [f for f in self.findings if wanted is None or f.rights_type in wanted or f.rights_type is None]
        totals = [t for t in self.totals if wanted is None or t["rights_type"] in wanted]
        return {
            "valid": not findings,
            "blocked": any(f.blocking for f in findings),
            "issues": [f.issue() for f in findings],
            "totals": totals,
        }


def _fingerprint(*parts: Any) -> str:
    raw = "|".join("" if p is None else str(p) for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _segments(shares: Sequence[ShareView]) -> list[tuple[date | None, date | None]]:
    """Split the timeline at every effective boundary (inclusive ranges)."""
    points: set[date] = set()
    for share in shares:
        if share.effective_from:
            points.add(share.effective_from)
        if share.effective_to and share.effective_to < date.max:
            points.add(share.effective_to + timedelta(days=1))
    ordered = sorted(points)
    starts: list[date | None] = [None, *ordered]
    segments = []
    for index, start in enumerate(starts):
        if index < len(ordered):
            if ordered[index] == date.min:
                continue  # nothing can precede date.min (audit AF-12)
            end = ordered[index] - timedelta(days=1)
        else:
            end = None
        segments.append((start, end))
    return segments


def _covers_segment(share: ShareView, start: date | None, end: date | None) -> bool:
    if share.effective_from is not None and (start is None or share.effective_from > start):
        return False
    if share.effective_to is not None and (end is None or share.effective_to < end):
        return False
    return True


def _period_overlap(a: ShareView, b: ShareView) -> tuple[bool, date | None, date | None]:
    froms = [d for d in (a.effective_from, b.effective_from) if d]
    tos = [d for d in (a.effective_to, b.effective_to) if d]
    start = max(froms) if froms else None
    end = min(tos) if tos else None
    if start and end and end < start:
        return False, None, None
    return True, start, end


def country_groups(
    shares: Sequence[ShareView], rules: RuleBook, rights_type: str
) -> dict[tuple, set[str]]:
    """Group covered countries by (total, controlled, share ids, rule)."""
    totals: dict[str, Decimal] = defaultdict(lambda: ZERO)
    controlled: dict[str, Decimal] = defaultdict(lambda: ZERO)
    ids: dict[str, set[str]] = defaultdict(set)
    for share in shares:
        for country in share.countries:
            totals[country] += share.share_percent
            if share.is_controlled:
                controlled[country] += share.share_percent
            ids[country].add(share.id)
    groups: dict[tuple, set[str]] = defaultdict(set)
    for country, total in totals.items():
        rule = rules.for_country(rights_type, country)
        groups[(total, controlled[country], frozenset(ids[country]), rule)].add(country)
    return groups


def allocation_status(total: Decimal, rule: EffectiveRule) -> str:
    if total > rule.expected_total + rule.tolerance:
        return "over"
    if total < rule.expected_total - rule.tolerance:
        return "under_allowed" if rule.allow_under_allocation else "under"
    return "ok"


def _totals_for(
    rights_type: str,
    shares: list[ShareView],
    rules: RuleBook,
    asset_key: str,
    totals_out: list[dict[str, Any]],
    findings_out: list[Finding],
) -> None:
    by_id = {s.id: s for s in shares}
    open_runs: dict[tuple, dict[str, Any]] = {}
    finished: list[tuple[tuple, dict[str, Any]]] = []
    for start, end in _segments(shares):
        active = [s for s in shares if _covers_segment(s, start, end)]
        current: dict[tuple, dict[str, Any]] = {}
        if active:
            for gkey, countries in country_groups(active, rules, rights_type).items():
                key = (*gkey, frozenset(countries))
                run = open_runs.pop(key, None) or {"start": start}
                run["end"] = end
                current[key] = run
        finished.extend(open_runs.items())
        open_runs = current
    finished.extend(open_runs.items())
    finished.sort(key=lambda item: (item[1]["start"] or date.min, sorted(item[0][4])[:1]))

    for (total, controlled, share_ids, rule, countries), run in finished:
        start, end = run["start"], run["end"]
        territories, excluded, label = compact_territories(countries)
        status = allocation_status(total, rule)
        ids_sorted = sorted(share_ids)
        totals_out.append(
            {
                "rights_type": rights_type,
                "effective_from": start,
                "effective_to": end,
                "territories": territories,
                "excluded_territories": excluded,
                "territory_label": label,
                "country_count": len(countries),
                "total": total,
                "controlled_total": controlled,
                "expected_total": rule.expected_total,
                "tolerance": rule.tolerance,
                "status": status,
                "share_ids": ids_sorted,
            }
        )
        if status not in ("over", "under"):
            continue
        contributing = sorted((by_id[i] for i in share_ids), key=lambda s: (-s.share_percent, s.party_name))
        conflict_type = "over_allocation" if status == "over" else "under_allocation"
        deviation = abs(total - rule.expected_total)
        blocking = rule.enforcement == "block"
        if status == "over":
            severity = "critical" if (deviation >= 1 or blocking) else "high"
            headline = f"{rights_type.capitalize()} over-allocated at {fmt_pct(total)}"
            gap = f"The excess is {fmt_pct(deviation)}."
            verb = "above"
        else:
            severity = "medium"
            headline = f"{rights_type.capitalize()} under-allocated at {fmt_pct(total)}"
            gap = f"The shortfall is {fmt_pct(deviation)}."
            verb = "below"
        period = period_label(start, end)
        title = f"{headline} in {short_label(label, len(countries))} ({period})"
        explanation = (
            f"Active {rights_type} shares add up to {fmt_pct(total)} in {label} for {period}, "
            f"{verb} the expected {fmt_pct(rule.expected_total)} "
            f"(tolerance ±{fmt_pct(rule.tolerance)}, {rule.scope}, enforcement: {rule.enforcement}). "
            f"Shares counted: {'; '.join(s.describe() for s in contributing)}. {gap}"
        )
        findings_out.append(
            Finding(
                type=conflict_type,
                severity=severity,
                rights_type=rights_type,
                title=title[:255],
                explanation=explanation,
                details={
                    "territories": territories,
                    "excluded_territories": excluded,
                    "country_count": len(countries),
                    "effective_from": _iso(start),
                    "effective_to": _iso(end),
                    "total": dec_str(total),
                    "controlled_total": dec_str(controlled),
                    "expected_total": dec_str(rule.expected_total),
                    "tolerance": dec_str(rule.tolerance),
                    "deviation": dec_str(deviation),
                    "rule_id": rule.rule_id,
                    "rule_scope": rule.scope,
                    "enforcement": rule.enforcement,
                    "shares": [s.brief() for s in contributing],
                },
                share_ids=ids_sorted,
                fingerprint=_fingerprint(
                    conflict_type, asset_key, rights_type, ",".join(ids_sorted),
                    ",".join(sorted(countries)), _iso(start), _iso(end),
                ),
                blocking=blocking,
                enforcement=rule.enforcement,
                key=(conflict_type, rights_type, frozenset(countries), start, end),
                deviation=deviation,
                countries=frozenset(countries),
                period=(start, end),
            )
        )


def _dup_key(share: ShareView) -> tuple:
    return (
        share.party_id,
        share.role,
        tuple(sorted(share.territories)),
        tuple(sorted(share.excluded)),
        share.effective_from,
        share.effective_to,
        share.share_percent,
    )


def _duplicates_and_overlaps(
    rights_type: str, shares: list[ShareView], rules: RuleBook, asset_key: str, out: list[Finding]
) -> None:
    groups: dict[tuple, list[ShareView]] = defaultdict(list)
    for share in shares:
        groups[_dup_key(share)].append(share)
    for members in groups.values():
        if len(members) < 2:
            continue
        ids = sorted(s.id for s in members)
        first = members[0]
        _, _, scope = compact_territories(first.countries)
        period = period_label(first.effective_from, first.effective_to)
        out.append(
            Finding(
                type="duplicate_entry",
                severity="medium",
                rights_type=rights_type,
                title=(
                    f"Duplicate {rights_type} share for {first.party_name} "
                    f"({first.role}, {fmt_pct(first.share_percent)}) ×{len(members)}"
                )[:255],
                explanation=(
                    f"{len(members)} {rights_type} shares are identical: {first.party_name} as "
                    f"{first.role} with {fmt_pct(first.share_percent)} in {scope} for {period}. "
                    f"Share ids: {', '.join(ids)}. Together they count "
                    f"{fmt_pct(first.share_percent * len(members))} instead of "
                    f"{fmt_pct(first.share_percent)}; archive the duplicates."
                ),
                details={"shares": [s.brief() for s in members], "count": len(members)},
                share_ids=ids,
                fingerprint=_fingerprint("duplicate_entry", asset_key, rights_type, ",".join(ids)),
            )
        )

    ordered = sorted(shares, key=lambda s: s.id)
    for i, a in enumerate(ordered):
        for b in ordered[i + 1:]:
            if _dup_key(a) == _dup_key(b) or a.role != b.role:
                continue
            overlap_countries = a.countries & b.countries
            if not overlap_countries:
                continue
            overlaps, start, end = _period_overlap(a, b)
            if not overlaps:
                continue
            combined = a.share_percent + b.share_percent
            territories, excluded, label = compact_territories(overlap_countries)
            period = period_label(start, end)
            if a.party_id == b.party_id:
                title = (
                    f"{a.party_name} holds two overlapping {rights_type} shares as {a.role}"
                )
                explanation = (
                    f"{a.party_name} appears twice as {a.role} for {rights_type}: "
                    f"{a.describe()} and {b.describe()}. Their scopes overlap in {label} for "
                    f"{period}, where the party is credited {fmt_pct(combined)} in total. "
                    "Merge or supersede one of the entries."
                )
            else:
                rule = rules.for_country(rights_type, min(overlap_countries))
                if combined <= rule.expected_total + rule.tolerance:
                    continue
                title = (
                    f"Overlapping {a.role} claims on {rights_type}: "
                    f"{a.party_name} vs {b.party_name}"
                )
                explanation = (
                    f"{a.party_name} and {b.party_name} both claim the {a.role} {rights_type} "
                    f"share in {label} for {period}: {a.describe()} and {b.describe()}. "
                    f"Combined they claim {fmt_pct(combined)}, more than the expected "
                    f"{fmt_pct(rule.expected_total)} ({rule.scope})."
                )
            ids = sorted([a.id, b.id])
            out.append(
                Finding(
                    type="overlapping_claims",
                    severity="high",
                    rights_type=rights_type,
                    title=title[:255],
                    explanation=explanation,
                    details={
                        "territories": territories,
                        "excluded_territories": excluded,
                        "effective_from": _iso(start),
                        "effective_to": _iso(end),
                        "combined_percent": dec_str(combined),
                        "same_party": a.party_id == b.party_id,
                        "shares": [a.brief(), b.brief()],
                    },
                    share_ids=ids,
                    fingerprint=_fingerprint(
                        "overlapping_claims", asset_key, rights_type, ",".join(ids),
                        ",".join(sorted(overlap_countries)), _iso(start), _iso(end),
                    ),
                    countries=frozenset(overlap_countries),
                    period=(start, end),
                )
            )


def _invalid_metadata(asset_type: str, share: ShareView, asset_key: str) -> Finding | None:
    problems: list[tuple[str, str, str]] = []  # (code, severity, text)
    bad_codes = [t for t in share.territories if not is_valid_territory(t)]
    if not share.territories:
        problems.append(("no_territories", "low", "it lists no territories"))
    if bad_codes:
        problems.append(("invalid_territory", "low", f"unknown territory codes {', '.join(map(str, bad_codes))}"))
    bad_excluded = [t for t in share.excluded if t not in TERRITORIES]
    if bad_excluded:
        problems.append(("invalid_excluded_territory", "low",
                         f"unknown excluded territory codes {', '.join(map(str, bad_excluded))}"))
    if share.territories and not share.countries and not bad_codes:
        problems.append(("empty_scope", "low", "its exclusions remove every territory"))
    if not share.dates_valid:
        problems.append(("invalid_dates", "medium",
                         f"effective_to {share.effective_to} is before effective_from {share.effective_from}"))
    if share.rights_type not in rights_types_for(asset_type):
        problems.append(("rights_type_mismatch", "medium",
                         f"rights type {share.rights_type} does not apply to a {asset_type}"))
    if share.party_status == "archived":
        problems.append(("party_archived", "medium", f"party {share.party_name} is archived"))
    if share.status == "disputed" or share.verification_status == "disputed":
        problems.append(("disputed", "medium", "the claim is disputed"))
    if not problems:
        return None
    codes = sorted(code for code, _, _ in problems)
    severity = max((sev for _, sev, _ in problems), key=SEVERITY_RANK.__getitem__)
    return Finding(
        type="invalid_metadata",
        severity=severity,
        rights_type=share.rights_type,
        title=f"Invalid {share.rights_type} share for {share.party_name}: {', '.join(codes)}"[:255],
        explanation=(
            f"Share {share.describe()} on {share.rights_type} needs attention: "
            + "; ".join(text for _, _, text in problems) + "."
        ),
        details={"problems": codes, "share": share.brief()},
        share_ids=[share.id],
        fingerprint=_fingerprint("invalid_metadata", asset_key, share.id, ",".join(codes)),
    )


def analyze(
    asset_type: str,
    asset_key: str,
    shares: Sequence[ShareView],
    rules: RuleBook,
    *,
    asset_status: str | None = None,
    asset_title: str | None = None,
) -> Analysis:
    """Pure analysis of a share set for one asset. ``shares`` should contain
    claims (status active/disputed); others are ignored."""
    findings: list[Finding] = []
    totals: list[dict[str, Any]] = []
    claims = [s for s in shares if s.status in CLAIM_STATUSES]
    for share in claims:
        problem = _invalid_metadata(asset_type, share, asset_key)
        if problem:
            findings.append(problem)
    by_type: dict[str, list[ShareView]] = defaultdict(list)
    for share in claims:
        by_type[share.rights_type].append(share)
    for rights_type in sorted(by_type):
        usable = [s for s in by_type[rights_type] if s.dates_valid and s.countries]
        _totals_for(rights_type, usable, rules, asset_key, totals, findings)
        _duplicates_and_overlaps(rights_type, usable, rules, asset_key, findings)
    if asset_status == "active":
        for rights_type in PRIMARY_RIGHTS[asset_type]:
            if any(s.rights_type == rights_type and s.status == "active" for s in claims):
                continue
            name = f"{asset_type} '{asset_title}'" if asset_title else asset_type
            findings.append(
                Finding(
                    type="missing_ownership",
                    severity="medium",
                    rights_type=rights_type,
                    title=f"No {rights_type} ownership recorded for {name}"[:255],
                    explanation=(
                        f"The active {name} has no active {rights_type} shares, so income for "
                        f"{rights_type} cannot be allocated. Add the {rights_type} splits."
                    ),
                    details={"primary_rights_types": list(PRIMARY_RIGHTS[asset_type])},
                    share_ids=[],
                    fingerprint=_fingerprint("missing_ownership", asset_key, rights_type),
                )
            )
    order = {"over_allocation": 0, "under_allocation": 1, "overlapping_claims": 2,
             "duplicate_entry": 3, "missing_ownership": 4, "invalid_metadata": 5}
    findings.sort(key=lambda f: (f.rights_type or "", order.get(f.type, 9)))
    return Analysis(findings=findings, totals=totals)


# =========================================================================== lookups


def get_asset(db: Session, org_id: str, asset_type: str, asset_id: str, *, lock: bool = False) -> Work | Recording:
    """``lock=True`` takes a row lock on the asset. Every share write locks its
    asset first, so the blocking split-rule check sees all concurrent writes
    to the same asset (audit D-05)."""
    model = Work if asset_type == "work" else Recording
    stmt = select(model).where(model.id == asset_id, model.organization_id == org_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    asset = db.scalar(stmt)
    if asset is None:
        raise NotFoundError(f"{asset_type.capitalize()} not found")
    return asset


def get_party(db: Session, org_id: str, party_id: str) -> Party:
    party = db.scalar(select(Party).where(Party.id == party_id, Party.organization_id == org_id))
    if party is None:
        raise NotFoundError("Party not found", details={"party_id": party_id})
    return party


def _parties(db: Session, org_id: str, party_ids: Iterable[str]) -> dict[str, Party]:
    wanted = set(party_ids)
    if not wanted:
        return {}
    found = {
        p.id: p
        for p in db.scalars(
            select(Party).where(Party.organization_id == org_id, Party.id.in_(wanted))
        ).all()
    }
    missing = wanted - set(found)
    if missing:
        raise NotFoundError("Party not found", details={"party_ids": sorted(missing)})
    return found


def _check_contract(db: Session, org_id: str, contract_id: str | None) -> None:
    if not contract_id:
        return
    exists = db.scalar(
        select(Contract.id).where(Contract.id == contract_id, Contract.organization_id == org_id)
    )
    if exists is None:
        raise NotFoundError("Contract not found", details={"contract_id": contract_id})


def get_share(db: Session, org_id: str, share_id: str) -> OwnershipShare:
    share = db.scalar(
        select(OwnershipShare).where(
            OwnershipShare.id == share_id, OwnershipShare.organization_id == org_id
        )
    )
    if share is None:
        raise NotFoundError("Ownership share not found")
    return share


def get_share_for_write(db: Session, org_id: str, share_id: str) -> OwnershipShare:
    """Load a share, lock its asset, then re-read the share so status checks
    run against the latest committed state."""
    share = get_share(db, org_id, share_id)
    asset_type, asset_id = asset_of(share)
    get_asset(db, org_id, asset_type, asset_id, lock=True)  # type: ignore[arg-type]
    db.refresh(share)
    return share


def asset_of(share: OwnershipShare | RightsConflict) -> tuple[str | None, str | None]:
    if share.work_id:
        return "work", share.work_id
    if share.recording_id:
        return "recording", share.recording_id
    return None, None


def _assert_rights_type(asset_type: str, rights_type: str) -> None:
    if rights_type not in rights_types_for(asset_type):
        raise ValidationFailedError(
            f"Rights type '{rights_type}' is not valid for a {asset_type}; "
            f"allowed: {', '.join(rights_types_for(asset_type))}",
            code="invalid_rights_type",
        )


def _asset_filter(asset_type: str, asset_id: str):
    column = OwnershipShare.work_id if asset_type == "work" else OwnershipShare.recording_id
    return column == asset_id


def asset_claims(db: Session, org_id: str, asset_type: str, asset_id: str) -> list[OwnershipShare]:
    db.flush()
    return list(
        db.scalars(
            select(OwnershipShare)
            .where(
                OwnershipShare.organization_id == org_id,
                _asset_filter(asset_type, asset_id),
                OwnershipShare.status.in_(CLAIM_STATUSES),
            )
            .order_by(OwnershipShare.created_at, OwnershipShare.id)
        )
        .unique()
        .all()
    )


def analyze_asset(
    db: Session, org_id: str, asset_type: str, asset: Work | Recording,
    rules: RuleBook | None = None,
) -> Analysis:
    rules = rules or load_rules(db, org_id, asset_type)
    views = [view_of(s) for s in asset_claims(db, org_id, asset_type, asset.id)]
    return analyze(
        asset_type, f"{asset_type}:{asset.id}", views, rules,
        asset_status=asset.status, asset_title=asset.title,
    )


# =========================================================================== serialization


def share_payload(share: OwnershipShare) -> dict[str, Any]:
    asset_type, _ = asset_of(share)
    return {
        "id": share.id,
        "organization_id": share.organization_id,
        "asset_type": asset_type,
        "work_id": share.work_id,
        "recording_id": share.recording_id,
        "party_id": share.party_id,
        "party_name": share.party.name if share.party else None,
        "role": share.role,
        "rights_type": share.rights_type,
        "share_percent": q6(share.share_percent),
        "territories": share.territories or [],
        "excluded_territories": share.excluded_territories or None,
        "effective_from": share.effective_from,
        "effective_to": share.effective_to,
        "is_controlled": share.is_controlled,
        "source": share.source,
        "contract_id": share.contract_id,
        "split_sheet_id": share.split_sheet_id,
        "status": share.status,
        "verification_status": share.verification_status,
        "verified_by_id": share.verified_by_id,
        "verified_at": share.verified_at,
        "supersedes_id": share.supersedes_id,
        "notes": share.notes,
        "created_by_id": share.created_by_id,
        "created_at": share.created_at,
        "updated_at": share.updated_at,
    }


def still_detected(conflict: RightsConflict) -> bool:
    return bool((conflict.details or {}).get("still_detected", True))


def conflict_payload(conflict: RightsConflict) -> dict[str, Any]:
    asset_type, _ = asset_of(conflict)
    return {
        "id": conflict.id,
        "organization_id": conflict.organization_id,
        "conflict_type": conflict.conflict_type,
        "severity": conflict.severity,
        "status": conflict.status,
        "asset_type": asset_type,
        "work_id": conflict.work_id,
        "recording_id": conflict.recording_id,
        "rights_type": conflict.rights_type,
        "title": conflict.title,
        "explanation": conflict.explanation,
        "details": conflict.details,
        "fingerprint": conflict.fingerprint,
        "last_detected_at": conflict.last_detected_at,
        "still_detected": still_detected(conflict),
        "resolved_by_id": conflict.resolved_by_id,
        "resolved_at": conflict.resolved_at,
        "resolution_notes": conflict.resolution_notes,
        "created_at": conflict.created_at,
        "updated_at": conflict.updated_at,
    }


def conflict_brief(conflict: RightsConflict) -> dict[str, Any]:
    return {
        "id": conflict.id,
        "conflict_type": conflict.conflict_type,
        "severity": conflict.severity,
        "status": conflict.status,
        "title": conflict.title,
    }


# =========================================================================== conflict detection


@dataclass
class DetectionResult:
    detected: list[RightsConflict]
    new: list[RightsConflict]
    no_longer_detected: list[RightsConflict]
    scanned_assets: int
    scanned_at: datetime


def _persist(
    db: Session,
    org_id: str,
    per_asset: list[tuple[str, str, Analysis]],
    *,
    stale_scope: Any,
    actor_user_id: str | None,
    request: Request | None,
) -> DetectionResult:
    scan_time = utc_now().replace(microsecond=0)
    stamp = scan_time.isoformat()
    findings: dict[str, tuple[str, str, Finding]] = {}
    for asset_type, asset_id, analysis in per_asset:
        for finding in analysis.findings:
            findings.setdefault(finding.fingerprint, (asset_type, asset_id, finding))

    # Serialize concurrent detections for the same assets (row locks taken in a
    # stable order) so two writers can't both insert the same fingerprint.
    for model, kind in ((Work, "work"), (Recording, "recording")):
        ids = sorted({asset_id for asset_type, asset_id, _ in per_asset if asset_type == kind})
        for start in range(0, len(ids), 500):
            db.execute(select(model.id).where(model.id.in_(ids[start:start + 500]))
                       .order_by(model.id).with_for_update())

    existing: dict[str, RightsConflict] = {}
    fingerprints = list(findings)
    for start in range(0, len(fingerprints), 500):
        chunk = fingerprints[start:start + 500]
        for row in db.scalars(
            select(RightsConflict).where(
                RightsConflict.organization_id == org_id, RightsConflict.fingerprint.in_(chunk)
            )
        ).all():
            existing[row.fingerprint] = row

    detected: list[RightsConflict] = []
    new: list[RightsConflict] = []
    for fingerprint, (asset_type, asset_id, finding) in findings.items():
        details = {
            **finding.details,
            "share_ids": finding.share_ids,
            "blocking": finding.blocking,
            "still_detected": True,
            "last_checked_at": stamp,
        }
        conflict = existing.get(fingerprint)
        if conflict is None:
            conflict = RightsConflict(
                id=new_uuid(),
                organization_id=org_id,
                conflict_type=finding.type,
                severity=finding.severity,
                status="open",
                work_id=asset_id if asset_type == "work" else None,
                recording_id=asset_id if asset_type == "recording" else None,
                rights_type=finding.rights_type,
                title=finding.title,
                explanation=finding.explanation,
                details={**details, "first_detected_at": stamp},
                fingerprint=fingerprint,
                last_detected_at=scan_time,
            )
            db.add(conflict)
            new.append(conflict)
            if finding.severity in ("high", "critical"):
                from app.services.automation.events import emit_event_if_enabled

                emit_event_if_enabled(db, organization_id=org_id, event_type="rights_conflict.opened",
                           payload={"conflict_id": conflict.id, "severity": finding.severity,
                                    "conflict_type": finding.type},
                           dedupe_key=f"rights_conflict.opened:{conflict.id}")
            record_audit(
                db,
                action="rights_conflict.detected",
                actor_user_id=actor_user_id,
                organization_id=org_id,
                entity_type="rights_conflict",
                entity_id=conflict.id,
                summary=f"Detected {finding.type}: {finding.title}",
                request=request,
            )
        else:
            # Refresh the description; never touch the human-managed status.
            conflict.severity = finding.severity
            conflict.title = finding.title
            conflict.explanation = finding.explanation
            conflict.details = {
                **details,
                "first_detected_at": (conflict.details or {}).get("first_detected_at"),
            }
            conflict.last_detected_at = scan_time
        detected.append(conflict)

    stale_stmt = select(RightsConflict).where(RightsConflict.organization_id == org_id)
    if stale_scope is not None:
        stale_stmt = stale_stmt.where(stale_scope)
    no_longer: list[RightsConflict] = []
    for conflict in db.scalars(stale_stmt).all():
        if conflict.fingerprint in findings:
            continue
        details = dict(conflict.details or {})
        if details.get("still_detected", True) and conflict.status in UNRESOLVED_STATUSES:
            no_longer.append(conflict)
        details["still_detected"] = False
        details["last_checked_at"] = stamp
        conflict.details = details

    alarming = [c for c in new if SEVERITY_RANK[c.severity] >= SEVERITY_RANK["high"]]
    if alarming:
        top = max(alarming, key=lambda c: SEVERITY_RANK[c.severity])
        if len(alarming) == 1:
            title, body = f"Rights conflict: {top.title}", top.explanation
        else:
            title = f"{len(alarming)} new rights conflicts need review"
            body = "\n".join(f"- [{c.severity}] {c.title}" for c in alarming[:20])
        notify_org(
            db,
            organization_id=org_id,
            type="rights_conflict",
            title=title,
            body=body,
            link=f"/rights/conflicts/{top.id}" if len(alarming) == 1 else "/rights/conflicts",
            minimum_role="manager",
            severity="critical" if top.severity == "critical" else "warning",
        )
    db.flush()
    return DetectionResult(detected, new, no_longer, len(per_asset), scan_time)


def detect_for_asset(
    db: Session, org_id: str, asset_type: str, asset: Work | Recording,
    analysis: Analysis | None = None, *, actor_user_id: str | None = None,
    request: Request | None = None,
) -> DetectionResult:
    analysis = analysis or analyze_asset(db, org_id, asset_type, asset)
    column = RightsConflict.work_id if asset_type == "work" else RightsConflict.recording_id
    return _persist(
        db, org_id, [(asset_type, asset.id, analysis)],
        stale_scope=column == asset.id, actor_user_id=actor_user_id, request=request,
    )


def scan_organization(
    db: Session, org_id: str, *, actor_user_id: str | None = None, request: Request | None = None
) -> DetectionResult:
    db.flush()
    claims = db.scalars(
        select(OwnershipShare).where(
            OwnershipShare.organization_id == org_id,
            OwnershipShare.status.in_(CLAIM_STATUSES),
        )
    ).unique().all()
    grouped: dict[tuple[str, str], list[ShareView]] = defaultdict(list)
    for share in claims:
        asset_type, asset_id = asset_of(share)
        grouped[(asset_type, asset_id)].append(view_of(share))  # type: ignore[index]

    per_asset: list[tuple[str, str, Analysis]] = []
    for asset_type, model in (("work", Work), ("recording", Recording)):
        ids_with_shares = {aid for (atype, aid) in grouped if atype == asset_type}
        assets = db.scalars(
            select(model).where(
                model.organization_id == org_id,
                or_(model.status == "active", model.id.in_(ids_with_shares or {""})),
            )
        ).unique().all()
        rules = load_rules(db, org_id, asset_type)
        for asset in assets:
            per_asset.append(
                (
                    asset_type,
                    asset.id,
                    analyze(
                        asset_type, f"{asset_type}:{asset.id}", grouped.get((asset_type, asset.id), []),
                        rules, asset_status=asset.status, asset_title=asset.title,
                    ),
                )
            )
    return _persist(db, org_id, per_asset, stale_scope=None,
                    actor_user_id=actor_user_id, request=request)


def detect_conflicts(
    db: Session, org_id: str, work_id: str | None = None, recording_id: str | None = None,
    *, actor_user_id: str | None = None, request: Request | None = None,
) -> list[RightsConflict]:
    """Detect conflicts for one asset (or the whole organization when no
    asset is given), create/refresh RightsConflict rows and return the rows
    detected in this run. Does not commit."""
    if work_id:
        asset = get_asset(db, org_id, "work", work_id)
        return detect_for_asset(db, org_id, "work", asset, actor_user_id=actor_user_id,
                                request=request).detected
    if recording_id:
        asset = get_asset(db, org_id, "recording", recording_id)
        return detect_for_asset(db, org_id, "recording", asset, actor_user_id=actor_user_id,
                                request=request).detected
    return scan_organization(db, org_id, actor_user_id=actor_user_id, request=request).detected


# =========================================================================== write helpers


@dataclass
class MutationOutcome:
    analysis: Analysis
    detection: DetectionResult


def _blocking_state(analysis: Analysis, rights_types: set[str]) -> dict[tuple, Decimal]:
    return {
        f.key: f.deviation  # type: ignore[misc]
        for f in analysis.findings
        if f.blocking and f.key is not None and f.rights_type in rights_types
    }


def _enforce(db: Session, before: dict[tuple, Decimal], after: Analysis, rights_types: set[str]) -> None:
    """Reject writes that introduce (or worsen) a violation of a blocking rule.

    Incremental single-share edits pass the pre-write blocking state as
    ``before`` so data that already violates a rule can be repaired step by
    step (a change must not make any blocking violation worse). Full
    replacements pass ``{}``: the resulting set must satisfy every blocking
    rule."""
    violations = [
        f for f in after.findings
        if f.blocking and f.key is not None and f.rights_type in rights_types
        and (f.key not in before or (f.deviation or ZERO) > before[f.key])
    ]
    if violations:
        db.rollback()
        raise ValidationFailedError(
            "This change violates a blocking split rule: " + violations[0].explanation,
            code="split_rule_violation",
            details={"issues": [v.issue() for v in violations]},
        )


def _finish_write(
    db: Session, ctx: OrgContext, asset_type: str, asset: Work | Recording,
    before: dict[tuple, Decimal], rights_types: set[str], request: Request | None,
) -> MutationOutcome:
    after = analyze_asset(db, ctx.organization_id, asset_type, asset)
    _enforce(db, before, after, rights_types)
    detection = detect_for_asset(
        db, ctx.organization_id, asset_type, asset, after,
        actor_user_id=ctx.user.id, request=request,
    )
    db.commit()
    return MutationOutcome(after, detection)


def mutation_payload(share: OwnershipShare, outcome: MutationOutcome) -> dict[str, Any]:
    return {
        "share": share_payload(share),
        "validation": outcome.analysis.validation(),
        "conflicts": [conflict_brief(c) for c in outcome.detection.detected],
    }


def _audit_share(db: Session, ctx: OrgContext, action: str, share: OwnershipShare,
                 summary: str, changes: dict | None, request: Request | None) -> None:
    record_audit(
        db,
        action=f"ownership_share.{action}",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="ownership_share",
        entity_id=share.id,
        summary=summary,
        changes=changes,
        request=request,
    )


def _describe_share(share: OwnershipShare, party: Party | None = None) -> str:
    name = party.name if party else (share.party.name if share.party else share.party_id)
    return f"{name} {share.role} {fmt_pct(Decimal(share.share_percent))} {share.rights_type}"


# =========================================================================== shares


def create_share(db: Session, ctx: OrgContext, data: Any, request: Request | None) -> dict[str, Any]:
    org_id = ctx.organization_id
    asset_type = "work" if data.work_id else "recording"
    asset = get_asset(db, org_id, asset_type, data.work_id or data.recording_id, lock=True)
    _assert_rights_type(asset_type, data.rights_type)
    party = get_party(db, org_id, data.party_id)
    if party.status == "archived":
        raise ValidationFailedError("Cannot assign a share to an archived party", code="party_archived")
    _check_contract(db, org_id, data.contract_id)

    before = _blocking_state(analyze_asset(db, org_id, asset_type, asset), {data.rights_type})
    share = OwnershipShare(
        id=new_uuid(),
        organization_id=org_id,
        work_id=asset.id if asset_type == "work" else None,
        recording_id=asset.id if asset_type == "recording" else None,
        party_id=party.id,
        role=data.role,
        rights_type=data.rights_type,
        share_percent=data.share_percent,
        territories=data.territories,
        excluded_territories=data.excluded_territories,
        effective_from=data.effective_from,
        effective_to=data.effective_to,
        is_controlled=data.is_controlled,
        source=data.source,
        contract_id=data.contract_id,
        notes=data.notes,
        status="active",
        verification_status="unverified",
        created_by_id=ctx.user.id,
    )
    db.add(share)
    db.flush()
    _audit_share(db, ctx, "created", share, f"Added {_describe_share(share, party)} on {asset.title}",
                 snapshot(share), request)
    outcome = _finish_write(db, ctx, asset_type, asset, before, {data.rights_type}, request)
    return mutation_payload(share, outcome)


def _merged_scope(share: OwnershipShare, changes: dict[str, Any]) -> None:
    start = changes.get("effective_from", share.effective_from)
    end = changes.get("effective_to", share.effective_to)
    if start and end and end < start:
        raise ValidationFailedError("effective_to must be on or after effective_from")


def _clean_changes(db: Session, org_id: str, data: Any) -> dict[str, Any]:
    raw = data.model_dump(exclude_unset=True)
    changes: dict[str, Any] = {}
    for key in SHARE_EDITABLE_FIELDS:
        if key not in raw:
            continue
        value = raw[key]
        if value is None and key in ("party_id", "role", "share_percent", "territories", "is_controlled"):
            continue
        changes[key] = value
    if "party_id" in changes:
        party = get_party(db, org_id, changes["party_id"])
        if party.status == "archived":
            raise ValidationFailedError("Cannot assign a share to an archived party", code="party_archived")
    if changes.get("contract_id"):
        _check_contract(db, org_id, changes["contract_id"])
    return changes


def update_share(db: Session, ctx: OrgContext, share_id: str, data: Any,
                 request: Request | None) -> dict[str, Any]:
    org_id = ctx.organization_id
    share = get_share_for_write(db, org_id, share_id)
    if share.status not in CLAIM_STATUSES:
        raise ConflictError(f"A {share.status} share cannot be edited")
    changes = _clean_changes(db, org_id, data)
    if share.verification_status == "verified":
        material = [
            k for k in changes if k in MATERIAL_FIELDS and changes[k] != getattr(share, k)
        ]
        if material:
            raise ConflictError(
                "This share is verified; changes to "
                + ", ".join(material)
                + " require a superseding share (POST /rights/shares/{id}/supersede)",
                code="share_verified",
            )
    _merged_scope(share, changes)
    asset_type, asset_id = asset_of(share)
    asset = get_asset(db, org_id, asset_type, asset_id)  # type: ignore[arg-type]
    before = _blocking_state(analyze_asset(db, org_id, asset_type, asset), {share.rights_type})
    old = snapshot(share)
    for key, value in changes.items():
        setattr(share, key, value)
    db.flush()
    db.refresh(share)
    delta = diff(old, snapshot(share))
    if delta:
        _audit_share(db, ctx, "updated", share, f"Updated {_describe_share(share)} on {asset.title}",
                     delta, request)
    outcome = _finish_write(db, ctx, asset_type, asset, before, {share.rights_type}, request)
    return mutation_payload(share, outcome)


def archive_share(db: Session, ctx: OrgContext, share_id: str, request: Request | None) -> dict[str, Any]:
    org_id = ctx.organization_id
    share = get_share_for_write(db, org_id, share_id)
    if share.status in ("archived", "superseded"):
        raise ConflictError(f"Share is already {share.status}")
    asset_type, asset_id = asset_of(share)
    asset = get_asset(db, org_id, asset_type, asset_id)  # type: ignore[arg-type]
    before = _blocking_state(analyze_asset(db, org_id, asset_type, asset), {share.rights_type})
    previous = share.status
    share.status = "archived"
    db.flush()
    _audit_share(db, ctx, "archived", share, f"Archived {_describe_share(share)} on {asset.title}",
                 {"status": {"from": previous, "to": "archived"}}, request)
    outcome = _finish_write(db, ctx, asset_type, asset, before, {share.rights_type}, request)
    return mutation_payload(share, outcome)


def supersede_share(db: Session, ctx: OrgContext, share_id: str, data: Any,
                    request: Request | None) -> dict[str, Any]:
    org_id = ctx.organization_id
    old = get_share_for_write(db, org_id, share_id)
    if old.status not in CLAIM_STATUSES:
        raise ConflictError(f"A {old.status} share cannot be superseded")
    changes = _clean_changes(db, org_id, data)
    _merged_scope(old, changes)
    asset_type, asset_id = asset_of(old)
    asset = get_asset(db, org_id, asset_type, asset_id)  # type: ignore[arg-type]
    before = _blocking_state(analyze_asset(db, org_id, asset_type, asset), {old.rights_type})

    values = {key: getattr(old, key) for key in SHARE_EDITABLE_FIELDS}
    values.update(changes)
    new = OwnershipShare(
        id=new_uuid(),
        organization_id=org_id,
        work_id=old.work_id,
        recording_id=old.recording_id,
        rights_type=old.rights_type,
        source=old.source,
        split_sheet_id=old.split_sheet_id,
        status="active",
        verification_status="unverified",
        supersedes_id=old.id,
        created_by_id=ctx.user.id,
        **values,
    )
    previous_status = old.status
    old.status = "superseded"
    db.add(new)
    db.flush()
    reason = f" Reason: {data.reason}" if getattr(data, "reason", None) else ""
    _audit_share(db, ctx, "superseded", old, f"Superseded by {new.id}.{reason}",
                 {"status": {"from": previous_status, "to": "superseded"}, "superseded_by": new.id}, request)
    _audit_share(db, ctx, "created", new,
                 f"Created {_describe_share(new)} superseding {old.id}.{reason}",
                 diff(snapshot(old, list(SHARE_EDITABLE_FIELDS)), snapshot(new, list(SHARE_EDITABLE_FIELDS))),
                 request)
    outcome = _finish_write(db, ctx, asset_type, asset, before, {old.rights_type}, request)
    return mutation_payload(new, outcome)


def verify_share(db: Session, ctx: OrgContext, share_id: str, notes: str | None,
                 request: Request | None) -> dict[str, Any]:
    org_id = ctx.organization_id
    share = get_share_for_write(db, org_id, share_id)
    if share.status not in CLAIM_STATUSES:
        raise ConflictError(f"A {share.status} share cannot be verified")
    if share.verification_status == "verified" and share.status == "active":
        raise ConflictError("Share is already verified")
    asset_type, asset_id = asset_of(share)
    asset = get_asset(db, org_id, asset_type, asset_id)  # type: ignore[arg-type]
    before_state = {"status": share.status, "verification_status": share.verification_status}
    share.status = "active"
    share.verification_status = "verified"
    share.verified_by_id = ctx.user.id
    share.verified_at = utc_now()
    db.flush()
    _audit_share(
        db, ctx, "verified", share,
        f"Verified {_describe_share(share)}" + (f". Notes: {notes}" if notes else ""),
        {k: {"from": v, "to": getattr(share, k)} for k, v in before_state.items()
         if v != getattr(share, k)},
        request,
    )
    outcome = _finish_write(db, ctx, asset_type, asset, {}, set(), request)
    return mutation_payload(share, outcome)


def dispute_share(db: Session, ctx: OrgContext, share_id: str, reason: str,
                  request: Request | None) -> dict[str, Any]:
    org_id = ctx.organization_id
    share = get_share_for_write(db, org_id, share_id)
    if share.status != "active":
        raise ConflictError(f"A {share.status} share cannot be disputed")
    asset_type, asset_id = asset_of(share)
    asset = get_asset(db, org_id, asset_type, asset_id)  # type: ignore[arg-type]
    previous = share.verification_status
    share.status = "disputed"
    share.verification_status = "disputed"
    stamp = utc_now().date().isoformat()
    share.notes = ((share.notes + "\n") if share.notes else "") + f"[{stamp}] Disputed: {reason}"
    db.flush()
    _audit_share(
        db, ctx, "disputed", share, f"Disputed {_describe_share(share)}: {reason}",
        {"status": {"from": "active", "to": "disputed"},
         "verification_status": {"from": previous, "to": "disputed"}},
        request,
    )
    outcome = _finish_write(db, ctx, asset_type, asset, {}, set(), request)
    return mutation_payload(share, outcome)


def _apply_share_set(
    db: Session,
    ctx: OrgContext,
    asset_type: str,
    asset: Work | Recording,
    rights_type: str,
    entries: list[dict[str, Any]],
    *,
    mode: str,
    source: str,
    split_sheet_id: str | None,
    reason: str | None,
    request: Request | None,
) -> tuple[list[OwnershipShare], int, int]:
    """Add (or replace the active set with) ``entries`` for one rights type.
    Parties/contracts must already be verified. Does not commit."""
    org_id = ctx.organization_id
    superseded = archived = 0
    old_shares: list[OwnershipShare] = []
    if mode == "replace":
        old_shares = [
            s for s in asset_claims(db, org_id, asset_type, asset.id) if s.rights_type == rights_type
        ]
    unmatched = list(old_shares)
    created: list[OwnershipShare] = []
    suffix = f" Reason: {reason}" if reason else ""
    for entry in entries:
        predecessor = next(
            (s for s in unmatched if s.party_id == entry["party_id"] and s.role == entry["role"]), None
        )
        if predecessor is not None:
            unmatched.remove(predecessor)
        share = OwnershipShare(
            id=new_uuid(),
            organization_id=org_id,
            work_id=asset.id if asset_type == "work" else None,
            recording_id=asset.id if asset_type == "recording" else None,
            party_id=entry["party_id"],
            role=entry["role"],
            rights_type=rights_type,
            share_percent=entry["share_percent"],
            territories=entry.get("territories") or ["WORLD"],
            excluded_territories=entry.get("excluded_territories") or None,
            effective_from=entry.get("effective_from"),
            effective_to=entry.get("effective_to"),
            is_controlled=entry.get("is_controlled", True),
            contract_id=entry.get("contract_id"),
            notes=entry.get("notes"),
            source=source,
            split_sheet_id=split_sheet_id,
            status="active",
            verification_status="unverified",
            supersedes_id=predecessor.id if predecessor else None,
            created_by_id=ctx.user.id,
        )
        db.add(share)
        created.append(share)
        if predecessor is not None:
            previous = predecessor.status
            predecessor.status = "superseded"
            superseded += 1
            _audit_share(db, ctx, "superseded", predecessor,
                         f"Superseded by {share.id} (split replacement).{suffix}",
                         {"status": {"from": previous, "to": "superseded"}, "superseded_by": share.id},
                         request)
    for share in unmatched:
        previous = share.status
        share.status = "archived"
        archived += 1
        _audit_share(db, ctx, "archived", share, f"Archived by split replacement.{suffix}",
                     {"status": {"from": previous, "to": "archived"}}, request)
    db.flush()
    for share in created:
        _audit_share(db, ctx, "created", share,
                     f"Added {_describe_share(share)} on {asset.title} ({source}).{suffix}",
                     snapshot(share), request)
    return created, superseded, archived


def _entries_from(items: Iterable[Any]) -> list[dict[str, Any]]:
    return [item.model_dump() for item in items]


def replace_splits(db: Session, ctx: OrgContext, asset_type: str, asset_id: str, data: Any,
                   request: Request | None) -> dict[str, Any]:
    org_id = ctx.organization_id
    asset = get_asset(db, org_id, asset_type, asset_id, lock=True)
    _assert_rights_type(asset_type, data.rights_type)
    entries = _entries_from(data.shares)
    parties = _parties(db, org_id, (e["party_id"] for e in entries))
    archived_parties = sorted(p.name for p in parties.values() if p.status == "archived")
    if archived_parties:
        raise ValidationFailedError(
            "Cannot assign shares to archived parties: " + ", ".join(archived_parties),
            code="party_archived",
        )
    for entry in entries:
        _check_contract(db, org_id, entry.get("contract_id"))
    # A full replacement is validated strictly as a whole: any blocking
    # violation in the resulting set rejects it, even if it existed before.
    before: dict[tuple, Decimal] = {}
    created, superseded, archived = _apply_share_set(
        db, ctx, asset_type, asset, data.rights_type, entries,
        mode="replace", source="manual", split_sheet_id=None, reason=data.reason, request=request,
    )
    outcome = _finish_write(db, ctx, asset_type, asset, before, {data.rights_type}, request)
    return {
        "shares": [share_payload(s) for s in created],
        "superseded": superseded,
        "archived": archived,
        "validation": outcome.analysis.validation(),
        "conflicts": [conflict_brief(c) for c in outcome.detection.detected],
    }


def validate_proposal(db: Session, org_id: str, data: Any) -> dict[str, Any]:
    """Dry-run validation of a proposed share set. Never writes."""
    asset = None
    if data.asset_id:
        asset = get_asset(db, org_id, data.asset_type, data.asset_id)
    for proposed in data.shares:
        _assert_rights_type(data.asset_type, proposed.rights_type)
    parties = _parties(db, org_id, (p.party_id for p in data.shares))
    for proposed in data.shares:
        _check_contract(db, org_id, proposed.contract_id)
    views = [
        ShareView(
            id=f"proposed-{index + 1}",
            party_id=p.party_id,
            party_name=parties[p.party_id].name,
            party_status=parties[p.party_id].status,
            role=p.role,
            rights_type=p.rights_type,
            share_percent=p.share_percent,
            territories=p.territories,
            excluded=p.excluded_territories or [],
            effective_from=p.effective_from,
            effective_to=p.effective_to,
            is_controlled=p.is_controlled,
        )
        for index, p in enumerate(data.shares)
    ]
    proposed_types = {p.rights_type for p in data.shares}
    if asset is not None and data.include_existing:
        views.extend(
            view_of(s) for s in asset_claims(db, org_id, data.asset_type, asset.id)
            if s.rights_type in proposed_types
        )
    rules = load_rules(db, org_id, data.asset_type)
    key = f"proposal:{data.asset_type}:{asset.id if asset else 'new'}"
    analysis = analyze(data.asset_type, key, views, rules)
    return analysis.validation()


# =========================================================================== ownership summary


def ownership_summary(db: Session, org_id: str, asset_type: str, asset_id: str,
                      on_date: date, territory: str | None) -> dict[str, Any]:
    asset = get_asset(db, org_id, asset_type, asset_id)
    rules = load_rules(db, org_id, asset_type)
    views = [view_of(s) for s in asset_claims(db, org_id, asset_type, asset.id)]
    analysis = analyze(asset_type, f"{asset_type}:{asset.id}", views, rules,
                       asset_status=asset.status, asset_title=asset.title)
    rights = []
    for rights_type in rights_types_for(asset_type):
        effective = [
            v for v in views
            if v.rights_type == rights_type and v.dates_valid and v.countries and v.active_on(on_date)
        ]
        if territory:
            effective = [v for v in effective if territory_covers(v.territories, v.excluded, territory)]
        effective_ids = {v.id for v in effective}
        totals = []
        if territory:
            if effective:
                total = sum((v.share_percent for v in effective), ZERO)
                controlled = sum((v.share_percent for v in effective if v.is_controlled), ZERO)
                rule = rules.for_country(rights_type, territory)
                totals.append({
                    "territories": [territory], "excluded_territories": [], "territory_label": territory,
                    "total": total, "controlled_percent": controlled,
                    "non_controlled_percent": total - controlled,
                    "expected_total": rule.expected_total, "status": allocation_status(total, rule),
                })
        else:
            for (total, controlled, _ids, rule), countries in sorted(
                country_groups(effective, rules, rights_type).items(),
                key=lambda item: -len(item[1]),
            ):
                terr, excl, label = compact_territories(countries)
                totals.append({
                    "territories": terr, "excluded_territories": excl, "territory_label": label,
                    "total": total, "controlled_percent": controlled,
                    "non_controlled_percent": total - controlled,
                    "expected_total": rule.expected_total, "status": allocation_status(total, rule),
                })
        issues = []
        for finding in analysis.findings:
            if finding.rights_type != rights_type:
                continue
            if finding.period is not None:
                start, end = finding.period
                if (start and start > on_date) or (end and end < on_date):
                    continue
            if territory and finding.countries is not None and territory not in finding.countries:
                continue
            if finding.type not in ("over_allocation", "under_allocation", "missing_ownership") and not (
                set(finding.share_ids) & effective_ids
            ):
                continue
            issues.append(finding.issue())
        single = totals[0] if len(totals) == 1 else None
        rights.append({
            "rights_type": rights_type,
            "total": single["total"] if single else (ZERO if not totals else None),
            "controlled_percent": single["controlled_percent"] if single else (ZERO if not totals else None),
            "non_controlled_percent": single["non_controlled_percent"] if single else (ZERO if not totals else None),
            "totals": totals,
            "shares": [
                {
                    "share_id": v.id, "party_id": v.party_id, "party_name": v.party_name,
                    "role": v.role, "share_percent": v.share_percent, "territories": v.territories,
                    "excluded_territories": v.excluded or None, "effective_from": v.effective_from,
                    "effective_to": v.effective_to, "is_controlled": v.is_controlled,
                    "status": v.status, "verification_status": v.verification_status,
                }
                for v in effective
            ],
            "issues": issues,
        })
    column = RightsConflict.work_id if asset_type == "work" else RightsConflict.recording_id
    open_conflicts = db.scalars(
        select(RightsConflict).where(
            RightsConflict.organization_id == org_id, column == asset.id,
            RightsConflict.status.in_(UNRESOLVED_STATUSES),
        ).order_by(RightsConflict.created_at)
    ).all()
    return {
        "asset_type": asset_type,
        "asset_id": asset.id,
        "asset_title": asset.title,
        "on_date": on_date,
        "territory": territory,
        "rights": rights,
        "open_conflicts": [conflict_brief(c) for c in open_conflicts],
    }


# =========================================================================== split rules


def get_rule(db: Session, org_id: str, rule_id: str) -> SplitRule:
    rule = db.scalar(select(SplitRule).where(SplitRule.id == rule_id, SplitRule.organization_id == org_id))
    if rule is None:
        raise NotFoundError("Split rule not found")
    return rule


def create_rule(db: Session, ctx: OrgContext, data: Any, request: Request | None) -> SplitRule:
    _assert_rights_type(data.asset_type, data.rights_type)
    org_id = ctx.organization_id
    # The unique key can't cover territory=NULL (NULLs never collide), so
    # concurrent creates are serialized on the organization row (audit D-10).
    db.execute(select(Organization.id).where(Organization.id == org_id).with_for_update())
    territory_clause = (
        SplitRule.territory.is_(None) if data.territory is None else SplitRule.territory == data.territory
    )
    exists = db.scalar(
        select(SplitRule.id).where(
            SplitRule.organization_id == org_id,
            SplitRule.asset_type == data.asset_type,
            SplitRule.rights_type == data.rights_type,
            territory_clause,
        )
    )
    if exists:
        raise ConflictError("A split rule already exists for this asset type, rights type and territory")
    rule = SplitRule(id=new_uuid(), organization_id=org_id, **data.model_dump())
    db.add(rule)
    record_audit(
        db, action="split_rule.created", actor_user_id=ctx.user.id, organization_id=org_id,
        entity_type="split_rule", entity_id=rule.id,
        summary=f"Created split rule {data.asset_type}/{data.rights_type}/{data.territory or 'all'}",
        changes={k: {"from": None, "to": v} for k, v in data.model_dump().items()},
        request=request,
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ConflictError("A split rule already exists for this scope") from exc
    db.refresh(rule)
    return rule


def update_rule(db: Session, ctx: OrgContext, rule_id: str, data: Any, request: Request | None) -> SplitRule:
    rule = get_rule(db, ctx.organization_id, rule_id)
    before = snapshot(rule)
    for key, value in data.model_dump(exclude_unset=True).items():
        if value is None and key != "description":
            continue
        setattr(rule, key, value)
    db.flush()
    db.refresh(rule)
    changes = diff(before, snapshot(rule))
    if changes:
        record_audit(
            db, action="split_rule.updated", actor_user_id=ctx.user.id,
            organization_id=ctx.organization_id, entity_type="split_rule", entity_id=rule.id,
            summary=f"Updated split rule {rule.asset_type}/{rule.rights_type}/{rule.territory or 'all'}",
            changes=changes, request=request,
        )
    db.commit()
    return rule


def delete_rule(db: Session, ctx: OrgContext, rule_id: str, request: Request | None) -> None:
    rule = get_rule(db, ctx.organization_id, rule_id)
    record_audit(
        db, action="split_rule.deleted", actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id, entity_type="split_rule", entity_id=rule.id,
        summary=f"Deleted split rule {rule.asset_type}/{rule.rights_type}/{rule.territory or 'all'}",
        changes={"before": snapshot(rule)}, request=request,
    )
    db.delete(rule)
    db.commit()


# =========================================================================== split sheets


def get_sheet(db: Session, org_id: str, sheet_id: str) -> SplitSheet:
    sheet = db.scalar(select(SplitSheet).where(SplitSheet.id == sheet_id, SplitSheet.organization_id == org_id))
    if sheet is None:
        raise NotFoundError("Split sheet not found")
    return sheet


def _sheet_entries(db: Session, org_id: str, entries: list[Any]) -> list[dict[str, Any]]:
    _parties(db, org_id, (e.party_id for e in entries))
    seen: set[tuple[str, str]] = set()
    total = ZERO
    for entry in entries:
        key = (entry.party_id, entry.role)
        if key in seen:
            raise ValidationFailedError("Each party/role may appear only once on a split sheet",
                                        details={"party_id": entry.party_id, "role": entry.role})
        seen.add(key)
        total += entry.share_percent
    if total > Decimal("100"):
        raise ValidationFailedError(
            f"Split sheet entries total {fmt_pct(total)}, which exceeds 100%",
            code="split_sheet_over_allocated", details={"total": dec_str(total)},
        )
    return [
        {"party_id": e.party_id, "role": e.role, "share_percent": dec_str(e.share_percent)}
        for e in entries
    ]


def _check_document(db: Session, org_id: str, document_id: str | None) -> None:
    if not document_id:
        return
    exists = db.scalar(
        select(StoredFile.id).where(
            StoredFile.id == document_id, StoredFile.organization_id == org_id,
            StoredFile.is_deleted.is_(False),
        )
    )
    if exists is None:
        raise NotFoundError("File not found", details={"document_id": document_id})


def sheet_payload(db: Session, sheet: SplitSheet) -> dict[str, Any]:
    entries = sheet.entries or []
    names = dict(
        db.execute(
            select(Party.id, Party.name).where(
                Party.organization_id == sheet.organization_id,
                Party.id.in_({e["party_id"] for e in entries} or {""}),
            )
        ).all()
    )
    work_title = db.scalar(select(Work.title).where(Work.id == sheet.work_id))
    return {
        "id": sheet.id,
        "organization_id": sheet.organization_id,
        "work_id": sheet.work_id,
        "work_title": work_title,
        "title": sheet.title,
        "agreed_date": sheet.agreed_date,
        "status": sheet.status,
        "entries": [
            {"party_id": e["party_id"], "party_name": names.get(e["party_id"]), "role": e["role"],
             "share_percent": q6(e["share_percent"])}
            for e in entries
        ],
        "entries_total": q6(sum((Decimal(str(e["share_percent"])) for e in entries), ZERO)),
        "document_id": sheet.document_id,
        "notes": sheet.notes,
        "created_by_id": sheet.created_by_id,
        "created_at": sheet.created_at,
        "updated_at": sheet.updated_at,
    }


def create_sheet(db: Session, ctx: OrgContext, data: Any, request: Request | None) -> SplitSheet:
    org_id = ctx.organization_id
    work = get_asset(db, org_id, "work", data.work_id)
    entries = _sheet_entries(db, org_id, data.entries)
    _check_document(db, org_id, data.document_id)
    sheet = SplitSheet(
        id=new_uuid(), organization_id=org_id, work_id=work.id, title=data.title,
        agreed_date=data.agreed_date, status=data.status, entries=entries,
        document_id=data.document_id, notes=data.notes, created_by_id=ctx.user.id,
    )
    db.add(sheet)
    record_audit(
        db, action="split_sheet.created", actor_user_id=ctx.user.id, organization_id=org_id,
        entity_type="split_sheet", entity_id=sheet.id,
        summary=f"Created split sheet '{data.title}' for {work.title}", request=request,
    )
    db.commit()
    db.refresh(sheet)
    return sheet


def update_sheet(db: Session, ctx: OrgContext, sheet_id: str, data: Any, request: Request | None) -> SplitSheet:
    org_id = ctx.organization_id
    sheet = get_sheet(db, org_id, sheet_id)
    before = snapshot(sheet)
    raw = data.model_dump(exclude_unset=True)
    if "entries" in raw and data.entries is not None:
        sheet.entries = _sheet_entries(db, org_id, data.entries)
    if "document_id" in raw:
        _check_document(db, org_id, data.document_id)
        sheet.document_id = data.document_id
    for key in ("title", "status"):
        if raw.get(key) is not None:
            setattr(sheet, key, raw[key].strip() if key == "title" else raw[key])
    for key in ("agreed_date", "notes"):
        if key in raw:
            setattr(sheet, key, raw[key])
    db.flush()
    db.refresh(sheet)
    changes = diff(before, snapshot(sheet))
    if changes:
        record_audit(
            db, action="split_sheet.updated", actor_user_id=ctx.user.id, organization_id=org_id,
            entity_type="split_sheet", entity_id=sheet.id, summary=f"Updated split sheet '{sheet.title}'",
            changes=changes, request=request,
        )
    db.commit()
    return sheet


def delete_sheet(db: Session, ctx: OrgContext, sheet_id: str, request: Request | None) -> None:
    sheet = get_sheet(db, ctx.organization_id, sheet_id)
    record_audit(
        db, action="split_sheet.deleted", actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id, entity_type="split_sheet", entity_id=sheet.id,
        summary=f"Deleted split sheet '{sheet.title}'", changes={"before": snapshot(sheet)},
        request=request,
    )
    db.delete(sheet)
    db.commit()


def apply_sheet(db: Session, ctx: OrgContext, sheet_id: str, data: Any, request: Request | None) -> dict[str, Any]:
    org_id = ctx.organization_id
    sheet = get_sheet(db, org_id, sheet_id)
    if sheet.status == "disputed":
        raise ConflictError("A disputed split sheet cannot be applied")
    work = get_asset(db, org_id, "work", sheet.work_id, lock=True)
    parties = _parties(db, org_id, (e["party_id"] for e in sheet.entries or []))
    archived_parties = sorted(p.name for p in parties.values() if p.status == "archived")
    if archived_parties:
        raise ValidationFailedError(
            "Split sheet references archived parties: " + ", ".join(archived_parties),
            code="party_archived",
        )
    controlled = set(data.controlled_party_ids) if data.controlled_party_ids is not None else None
    if controlled:
        unknown = controlled - set(parties)
        if unknown:
            raise ValidationFailedError("controlled_party_ids must reference parties on the sheet",
                                        details={"party_ids": sorted(unknown)})
    rights_types = list(dict.fromkeys(data.rights_types))
    before = (
        {} if data.mode == "replace"
        else _blocking_state(analyze_asset(db, org_id, "work", work), set(rights_types))
    )
    entries = [
        {
            "party_id": e["party_id"], "role": e["role"],
            "share_percent": Decimal(str(e["share_percent"])),
            "territories": data.territories, "excluded_territories": data.excluded_territories,
            "effective_from": data.effective_from, "effective_to": data.effective_to,
            "is_controlled": True if controlled is None else e["party_id"] in controlled,
        }
        for e in sheet.entries or []
    ]
    created: list[OwnershipShare] = []
    superseded = archived = 0
    for rights_type in rights_types:
        rows, sup, arc = _apply_share_set(
            db, ctx, "work", work, rights_type, entries, mode=data.mode, source="split_sheet",
            split_sheet_id=sheet.id, reason=f"applied split sheet '{sheet.title}'", request=request,
        )
        created.extend(rows)
        superseded += sup
        archived += arc
    record_audit(
        db, action="split_sheet.applied", actor_user_id=ctx.user.id, organization_id=org_id,
        entity_type="split_sheet", entity_id=sheet.id,
        summary=f"Applied split sheet '{sheet.title}' to {', '.join(rights_types)} ({data.mode})",
        changes={"created_share_ids": [s.id for s in created]}, request=request,
    )
    outcome = _finish_write(db, ctx, "work", work, before, set(rights_types), request)
    return {
        "split_sheet_id": sheet.id,
        "shares": [share_payload(s) for s in created],
        "superseded": superseded,
        "archived": archived,
        "validation": outcome.analysis.validation(),
        "conflicts": [conflict_brief(c) for c in outcome.detection.detected],
    }


# =========================================================================== conflict workflow


def get_conflict(db: Session, org_id: str, conflict_id: str) -> RightsConflict:
    conflict = db.scalar(
        select(RightsConflict).where(
            RightsConflict.id == conflict_id, RightsConflict.organization_id == org_id
        )
    )
    if conflict is None:
        raise NotFoundError("Rights conflict not found")
    return conflict


# action -> (allowed source statuses, target status, notes required)
CONFLICT_TRANSITIONS = {
    "acknowledge": (("open",), "acknowledged", False),
    "resolve": (("open", "acknowledged"), "resolved", True),
    "dismiss": (("open", "acknowledged"), "dismissed", True),
    "reopen": (("acknowledged", "resolved", "dismissed"), "open", False),
}
CONFLICT_PAST_TENSE = {
    "acknowledge": "acknowledged", "resolve": "resolved", "dismiss": "dismissed", "reopen": "reopened",
}


def transition_conflict(db: Session, ctx: OrgContext, conflict_id: str, action: str,
                        notes: str | None, request: Request | None) -> RightsConflict:
    conflict = get_conflict(db, ctx.organization_id, conflict_id)
    allowed, target, needs_notes = CONFLICT_TRANSITIONS[action]
    notes = (notes or "").strip() or None
    if needs_notes and not notes:
        raise ValidationFailedError(f"resolution notes are required to {action} a conflict",
                                    code="notes_required")
    if conflict.status not in allowed:
        raise ConflictError(f"Cannot {action} a conflict that is {conflict.status}")
    previous = conflict.status
    conflict.status = target
    if target in ("resolved", "dismissed"):
        conflict.resolved_by_id = ctx.user.id
        conflict.resolved_at = utc_now()
        conflict.resolution_notes = notes
    elif target == "open":
        conflict.resolved_by_id = None
        conflict.resolved_at = None
        if notes:
            conflict.resolution_notes = notes
    elif notes:
        conflict.resolution_notes = notes
    record_audit(
        db, action=f"rights_conflict.{CONFLICT_PAST_TENSE[action]}",
        actor_user_id=ctx.user.id, organization_id=ctx.organization_id,
        entity_type="rights_conflict", entity_id=conflict.id,
        summary=f"{action.capitalize()} conflict: {conflict.title}" + (f". Notes: {notes}" if notes else ""),
        changes={"status": {"from": previous, "to": target}}, request=request,
    )
    db.commit()
    db.refresh(conflict)
    return conflict


# =========================================================================== summary


def rights_summary(db: Session, org_id: str) -> dict[str, Any]:
    by_status = dict(
        db.execute(
            select(OwnershipShare.status, func.count())
            .where(OwnershipShare.organization_id == org_id)
            .group_by(OwnershipShare.status)
        ).all()
    )
    active = int(by_status.get("active", 0))
    verified = db.scalar(
        select(func.count()).select_from(OwnershipShare).where(
            OwnershipShare.organization_id == org_id,
            OwnershipShare.status == "active",
            OwnershipShare.verification_status == "verified",
        )
    ) or 0
    percent = (Decimal(verified) * 100 / Decimal(active)).quantize(Decimal("0.01")) if active else Decimal("0.00")
    conflicts = db.execute(
        select(RightsConflict.status, RightsConflict.severity, func.count())
        .where(RightsConflict.organization_id == org_id)
        .group_by(RightsConflict.status, RightsConflict.severity)
    ).all()
    by_severity = {s: 0 for s in SEVERITY_RANK}
    conflict_status: dict[str, int] = defaultdict(int)
    for status, severity, count in conflicts:
        conflict_status[status] += count
        if status in UNRESOLVED_STATUSES:
            by_severity[severity] = by_severity.get(severity, 0) + count

    def missing(model, column, primary):
        conditions = [
            ~select(OwnershipShare.id)
            .where(
                OwnershipShare.organization_id == org_id,
                column == model.id,
                OwnershipShare.status == "active",
                OwnershipShare.rights_type == rights_type,
            )
            .exists()
            for rights_type in primary
        ]
        return db.scalar(
            select(func.count()).select_from(model).where(
                model.organization_id == org_id, model.status == "active", or_(*conditions)
            )
        ) or 0

    works_missing = missing(Work, OwnershipShare.work_id, PRIMARY_RIGHTS["work"])
    recordings_missing = missing(Recording, OwnershipShare.recording_id, PRIMARY_RIGHTS["recording"])
    return {
        "shares_total": sum(int(v) for v in by_status.values()),
        "shares_by_status": {k: int(v) for k, v in by_status.items()},
        "active_shares": active,
        "verified_active_shares": int(verified),
        "verified_percent": percent,
        "unresolved_conflicts": sum(by_severity.values()),
        "unresolved_conflicts_by_severity": by_severity,
        "conflicts_by_status": dict(conflict_status),
        "works_missing_ownership": int(works_missing),
        "recordings_missing_ownership": int(recordings_missing),
        "assets_missing_ownership": int(works_missing) + int(recordings_missing),
    }


def territory_filter(code: str):
    """SQL condition: share scope covers ``code`` (MariaDB JSON functions)."""
    literal = f'"{code}"'
    if code == "WORLD":
        return func.json_contains(OwnershipShare.territories, literal) == 1
    not_excluded = func.coalesce(func.json_contains(OwnershipShare.excluded_territories, literal), 0) == 0
    return and_(
        or_(
            func.json_contains(OwnershipShare.territories, literal) == 1,
            func.json_contains(OwnershipShare.territories, '"WORLD"') == 1,
        ),
        not_excluded,
    )
