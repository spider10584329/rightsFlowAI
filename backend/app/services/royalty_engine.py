"""Pure royalty allocation engine.

Given one statement line and the ownership/contract data that applies to it,
produce allocations that sum *exactly* to the line amount. No database access
happens here, which makes calculations reproducible and unit-testable.

Allocation model (documented in docs/ROYALTY_ENGINE.md):

1. Resolve the asset and rights type. Work rights (performance, mechanical,
   print) need a work; master/neighbouring rights need a recording.
2. Select ownership shares that are active, cover the line's territory and
   are effective on the line date. Lines touching disputed ownership are held
   (unallocated) for human review.
3. Split the amount across shares:
   - ``controlled_pro_rata`` (default): the statement amount is income for the
     shares the organization controls; it is divided among controlled shares
     in proportion to their percentages.
   - ``gross_share``: the amount represents 100% of the asset's income; each
     share receives amount × share% / 100. Non-controlled portions and any
     unowned remainder stay unallocated.
4. Apply the contract royalty rate (most specific matching term) to each
   share's portion. ``payable`` = portion × rate; the remainder is
   ``retained`` by the organization. Without a contract term the full portion
   is payable. Internal parties' portions are retained.
5. Rounding: amounts are kept at 8 decimal places. Portions are computed with
   the largest-remainder method (ties broken by share id) so their sum equals
   the input exactly; the payable/retained split is exact by construction.
"""

import hashlib
import json
from collections.abc import Iterable
from dataclasses import asdict, dataclass, field
from datetime import date
from decimal import ROUND_DOWN, ROUND_HALF_EVEN, Decimal

from app.services.reference import (
    DEFAULT_RIGHTS_BY_SOURCE,
    RECORDING_RIGHTS_TYPES,
    WORK_RIGHTS_TYPES,
    territory_covers,
)

CALCULATION_VERSION = "2026.10.2"  # .2: hold lines without an applicable contract term (audit F-H1)
QUANT = Decimal("0.00000001")
HUNDRED = Decimal("100")
WORK_ONLY_RIGHTS = {"performance", "mechanical", "print"}
RECORDING_ONLY_RIGHTS = {"master", "neighbouring"}


@dataclass(frozen=True)
class ShareInput:
    id: str
    party_id: str
    party_name: str
    party_is_internal: bool
    role: str
    rights_type: str
    share_percent: Decimal
    territories: tuple[str, ...]
    excluded_territories: tuple[str, ...]
    effective_from: date | None
    effective_to: date | None
    is_controlled: bool
    status: str
    contract_id: str | None
    work_id: str | None
    recording_id: str | None


@dataclass(frozen=True)
class TermInput:
    id: str
    contract_id: str
    payee_party_id: str | None
    rights_type: str | None
    source_category: str | None
    territories: tuple[str, ...] | None
    rate_percent: Decimal
    basis: str
    # The contract's effective window; terms only apply to lines dated inside it.
    valid_from: date | None = None
    valid_to: date | None = None


@dataclass(frozen=True)
class LineInput:
    id: str
    amount: Decimal
    gross_amount: Decimal | None
    currency: str
    territory: str | None
    rights_type: str | None
    line_date: date
    work_id: str | None
    recording_id: str | None
    linked_work_ids: tuple[str, ...] = ()
    match_status: str = "matched"


@dataclass
class AllocationOut:
    line_id: str
    allocation_type: str  # payable | retained | unallocated
    amount: Decimal
    base_amount: Decimal
    currency: str
    reason: str | None = None
    ownership_share_id: str | None = None
    contract_term_id: str | None = None
    party_id: str | None = None
    work_id: str | None = None
    recording_id: str | None = None
    rights_type: str | None = None
    territory: str | None = None
    share_percent: Decimal | None = None
    rate_percent: Decimal | None = None
    explanation: dict = field(default_factory=dict)


def q8(value: Decimal) -> Decimal:
    return value.quantize(QUANT, rounding=ROUND_HALF_EVEN)


def largest_remainder(total: Decimal, weights: list[tuple[str, Decimal]]) -> dict[str, Decimal]:
    """Split ``total`` proportionally to ``weights`` at 8 dp so the parts sum
    exactly to ``total`` (which must already have <= 8 dp). Works for
    negative totals (refunds/adjustments)."""
    if not weights:
        return {}
    weight_sum = sum(w for _, w in weights)
    if weight_sum <= 0:
        raise ValueError("Weights must be positive")
    sign = Decimal(-1) if total < 0 else Decimal(1)
    magnitude = abs(total)
    raw = {key: magnitude * w / weight_sum for key, w in weights}
    floored = {key: v.quantize(QUANT, rounding=ROUND_DOWN) for key, v in raw.items()}
    remaining_units = int(((magnitude - sum(floored.values())) / QUANT).to_integral_value())
    order = sorted(raw, key=lambda k: (-(raw[k] - floored[k]), k))
    for key in order[:remaining_units]:
        floored[key] += QUANT
    return {key: sign * value for key, value in floored.items()}


def resolve_rights_type(line: LineInput, statement_default: str | None, source_category: str) -> str:
    return line.rights_type or statement_default or DEFAULT_RIGHTS_BY_SOURCE.get(source_category, "master")


def _unallocated(line: LineInput, reason: str, message: str, **extra) -> list[AllocationOut]:
    return [
        AllocationOut(
            line_id=line.id,
            allocation_type="unallocated",
            amount=line.amount,
            base_amount=line.amount,
            currency=line.currency,
            reason=reason,
            work_id=extra.get("work_id", line.work_id),
            recording_id=extra.get("recording_id", line.recording_id),
            rights_type=extra.get("rights_type"),
            territory=line.territory,
            explanation={"message": message, **{k: v for k, v in extra.items() if k == "details"}},
        )
    ]


def _effective(share: ShareInput, on: date) -> bool:
    if share.effective_from and on < share.effective_from:
        return False
    if share.effective_to and on > share.effective_to:
        return False
    return True


def select_term(terms: Iterable[TermInput], share: ShareInput, rights_type: str,
                source_category: str, territory: str | None,
                on_date: date | None = None) -> TermInput | None:
    """Most specific contract term for the share's party; ties by id."""
    candidates = []
    for term in terms:
        if term.contract_id != share.contract_id:
            continue
        if on_date and term.valid_from and on_date < term.valid_from:
            continue
        if on_date and term.valid_to and on_date > term.valid_to:
            continue
        if term.payee_party_id and term.payee_party_id != share.party_id:
            continue
        if term.rights_type and term.rights_type != rights_type:
            continue
        if term.source_category and term.source_category != source_category:
            continue
        if term.territories and not territory_covers(term.territories, None, territory):
            continue
        specificity = sum(
            1 for v in (term.payee_party_id, term.rights_type, term.source_category, term.territories) if v
        )
        candidates.append((-specificity, term.id, term))
    if not candidates:
        return None
    return sorted(candidates, key=lambda c: (c[0], c[1]))[0][2]


def resolve_term(terms: Iterable[TermInput], share: ShareInput, rights_type: str,
                 source_category: str, territory: str | None,
                 on_date: date | None = None) -> tuple[TermInput | None, bool]:
    """Like :func:`select_term`, but also reports ambiguity: two equally
    specific matching terms with different rates/bases cannot be resolved
    automatically (picking one by id would silently pay the wrong rate)."""
    best = select_term(terms, share, rights_type, source_category, territory, on_date)
    if best is None:
        return None, False
    best_spec = _specificity(best)
    for term in terms:
        if term.id == best.id or term.contract_id != share.contract_id:
            continue
        if select_term([term], share, rights_type, source_category, territory, on_date) is None:
            continue
        if _specificity(term) == best_spec and (term.rate_percent, term.basis) != (best.rate_percent, best.basis):
            return best, True
    return best, False


def _specificity(term: TermInput) -> int:
    return sum(1 for v in (term.payee_party_id, term.rights_type, term.source_category, term.territories) if v)


def allocate_line(
    line: LineInput,
    *,
    shares: list[ShareInput],
    terms: list[TermInput],
    statement_default_rights: str | None,
    source_category: str,
    basis: str,
) -> list[AllocationOut]:
    if line.match_status != "matched":
        return _unallocated(line, "unmatched_line", "Line is not matched to a catalog asset.")
    if line.amount == 0:
        return []

    rights_type = resolve_rights_type(line, statement_default_rights, source_category)

    # 1. Resolve the asset that carries this right.
    work_id: str | None = None
    recording_id: str | None = None
    if rights_type in WORK_ONLY_RIGHTS:
        if line.work_id:
            work_id = line.work_id
        elif line.recording_id:
            if len(line.linked_work_ids) == 1:
                work_id = line.linked_work_ids[0]
            elif not line.linked_work_ids:
                return _unallocated(line, "no_linked_work",
                                    f"{rights_type} income needs a work, but the matched recording "
                                    "is not linked to any work.", rights_type=rights_type)
            else:
                return _unallocated(line, "multiple_linked_works",
                                    f"{rights_type} income cannot be split automatically: the "
                                    "recording embodies several works.", rights_type=rights_type)
    elif rights_type in RECORDING_ONLY_RIGHTS:
        if not line.recording_id:
            return _unallocated(line, "recording_required",
                                f"{rights_type} income needs a recording match.",
                                rights_type=rights_type)
        recording_id = line.recording_id
    else:  # sync: recording if present, else work
        recording_id = line.recording_id
        work_id = None if recording_id else line.work_id

    def applies(share: ShareInput) -> bool:
        if share.rights_type != rights_type:
            return False
        if work_id and share.work_id != work_id:
            return False
        if recording_id and share.recording_id != recording_id:
            return False
        if share.status not in ("active", "disputed"):
            return False
        return _effective(share, line.line_date) and territory_covers(
            share.territories, share.excluded_territories, line.territory
        )

    applicable = sorted((s for s in shares if applies(s)), key=lambda s: s.id)
    asset = {"work_id": work_id, "recording_id": recording_id, "rights_type": rights_type}

    if not applicable:
        return _unallocated(line, "missing_ownership",
                            f"No active {rights_type} ownership covers territory "
                            f"{line.territory or 'unknown'} on {line.line_date.isoformat()}.", **asset)
    if any(s.status == "disputed" for s in applicable):
        return _unallocated(line, "disputed_ownership",
                            "Ownership for this asset is disputed; income is held until a human "
                            "resolves the dispute.", **asset)
    total_owned = sum(s.share_percent for s in applicable)
    if total_owned > HUNDRED:
        return _unallocated(line, "over_allocated_ownership",
                            f"Applicable shares total {total_owned}% (>100%). Income is held until "
                            "the conflict is resolved.", **asset)

    # 2. Split across shares.
    portions: dict[str, Decimal]
    leftovers: list[AllocationOut] = []
    if basis == "gross_share":
        raw_parts = [(s.id, s.share_percent) for s in applicable]
        unowned = HUNDRED - total_owned
        if unowned > 0:
            raw_parts.append(("__unowned__", unowned))
        portions = largest_remainder(line.amount, raw_parts)
        unowned_amount = portions.pop("__unowned__", Decimal("0"))
        if unowned_amount:
            leftovers.append(AllocationOut(
                line_id=line.id, allocation_type="unallocated", amount=unowned_amount,
                base_amount=unowned_amount, currency=line.currency, reason="unassigned_share",
                territory=line.territory, explanation={
                    "message": f"{unowned}% of this asset has no registered owner."}, **asset))
        selected = applicable
    else:
        selected = [s for s in applicable if s.is_controlled]
        if not selected:
            return _unallocated(line, "no_controlled_shares",
                                "The organization controls none of the applicable shares.", **asset)
        portions = largest_remainder(line.amount, [(s.id, s.share_percent) for s in selected])

    controlled_total = sum(s.share_percent for s in selected if s.is_controlled)
    results: list[AllocationOut] = []
    for share in selected:
        portion = portions[share.id]
        common = dict(
            line_id=line.id, currency=line.currency, ownership_share_id=share.id,
            party_id=share.party_id, territory=line.territory, share_percent=share.share_percent,
            base_amount=portion, **asset,
        )
        explanation = {
            "party": share.party_name,
            "share_percent": str(share.share_percent),
            "basis": basis,
            "portion": str(portion),
        }
        if basis == "controlled_pro_rata":
            explanation["controlled_total_percent"] = str(controlled_total)
        if basis == "gross_share" and not share.is_controlled:
            results.append(AllocationOut(allocation_type="unallocated", amount=portion,
                                         reason="non_controlled_share", explanation={
                                             **explanation, "message": "Share is not controlled "
                                             "by the organization; income may be owed elsewhere."},
                                         **common))
            continue
        if share.party_is_internal:
            results.append(AllocationOut(allocation_type="retained", amount=portion,
                                         reason="internal_party", explanation={
                                             **explanation, "message": "Internal party; retained."},
                                         **common))
            continue

        term, ambiguous = (resolve_term(terms, share, rights_type, source_category, line.territory,
                                        line.line_date) if share.contract_id else (None, False))
        if share.contract_id and term is None:
            # The share is governed by a contract, but no term applies on this
            # date/source/rights type (or the contract is not in effect). Paying
            # 100% would overpay; hold for review instead.
            results.append(AllocationOut(allocation_type="unallocated", amount=portion,
                                         reason="no_applicable_contract_term", explanation={
                                             **explanation, "message": "The share is linked to a contract "
                                             "but no royalty term applies to this line (date outside the "
                                             "contract, contract not in effect, or no matching term)."},
                                         **common))
            continue
        if ambiguous:
            results.append(AllocationOut(allocation_type="unallocated", amount=portion,
                                         reason="ambiguous_contract_terms", explanation={
                                             **explanation, "message": "Two equally specific contract terms "
                                             "with different rates apply; make one more specific."},
                                         **common))
            continue
        rate = term.rate_percent if term else HUNDRED
        rate_base = portion
        if term and term.basis == "gross" and line.gross_amount is not None and line.amount != 0:
            if (line.gross_amount < 0) != (line.amount < 0) and line.gross_amount != 0:
                # A refund whose gross is positive (or vice versa) would pay a
                # royalty on money that was returned.
                results.append(AllocationOut(allocation_type="unallocated", amount=portion,
                                             reason="gross_net_sign_mismatch", explanation={
                                                 **explanation, "message": "Gross and net amounts have "
                                                 "opposite signs; held for review."}, **common))
                continue
            rate_base = line.gross_amount * portion / line.amount
            explanation["gross_basis_amount"] = str(q8(rate_base))
        payable = q8(rate_base * rate / HUNDRED)
        retained = portion - payable
        if abs(payable) > abs(portion):
            explanation["payable_exceeds_portion"] = True
        explanation.update({
            "rate_percent": str(rate),
            "contract_term_id": term.id if term else None,
            "rate_source": "contract_term" if term else "no_contract_term_full_share",
            "payable": str(payable),
        })
        results.append(AllocationOut(allocation_type="payable", amount=payable,
                                     contract_term_id=term.id if term else None,
                                     rate_percent=rate, explanation=explanation, **common))
        if retained != 0:
            results.append(AllocationOut(allocation_type="retained", amount=retained,
                                         reason="contract_retention",
                                         contract_term_id=term.id if term else None,
                                         rate_percent=rate, explanation={
                                             **explanation, "message": "Portion retained under "
                                             "the contract royalty rate."}, **common))
    results.extend(leftovers)
    return results


def inputs_fingerprint(*, basis: str, source_category: str, default_rights: str | None,
                       lines: list[LineInput], shares: list[ShareInput],
                       terms: list[TermInput]) -> str:
    """Stable hash of every input that influences a calculation."""

    def clean(obj) -> dict:
        data = asdict(obj)
        return {k: (str(v) if isinstance(v, (Decimal, date)) else v) for k, v in data.items()}

    payload = {
        "version": CALCULATION_VERSION,
        "basis": basis,
        "source_category": source_category,
        "default_rights": default_rights,
        "lines": [clean(x) for x in sorted(lines, key=lambda x: x.id)],
        "shares": [clean(x) for x in sorted(shares, key=lambda x: x.id)],
        "terms": [clean(x) for x in sorted(terms, key=lambda x: x.id)],
    }
    encoded = json.dumps(payload, sort_keys=True, default=list, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


__all__ = [
    "CALCULATION_VERSION",
    "AllocationOut",
    "LineInput",
    "ShareInput",
    "TermInput",
    "allocate_line",
    "inputs_fingerprint",
    "largest_remainder",
    "q8",
    "RECORDING_RIGHTS_TYPES",
    "WORK_RIGHTS_TYPES",
]
