"""Unit tests for the pure royalty allocation engine (no database)."""

from datetime import date
from decimal import Decimal as D

import pytest

from app.services.royalty_engine import (
    LineInput,
    ShareInput,
    TermInput,
    allocate_line,
    inputs_fingerprint,
    largest_remainder,
)


def share(id, party, pct, *, rights="master", controlled=True, internal=False, territories=("WORLD",),
          excluded=(), start=None, end=None, status="active", contract=None, work=None, recording="rec-1"):
    return ShareInput(
        id=id, party_id=party, party_name=party.title(), party_is_internal=internal, role="label",
        rights_type=rights, share_percent=D(pct), territories=tuple(territories),
        excluded_territories=tuple(excluded), effective_from=start, effective_to=end,
        is_controlled=controlled, status=status, contract_id=contract,
        work_id=work, recording_id=None if work else recording,
    )


def line(amount, *, territory="US", rights=None, recording="rec-1", work=None, linked=(),
         when=date(2026, 3, 31), gross=None, matched="matched"):
    return LineInput(id="line-1", amount=D(amount), gross_amount=D(gross) if gross else None,
                     currency="USD", territory=territory, rights_type=rights, line_date=when,
                     work_id=work, recording_id=recording, linked_work_ids=tuple(linked),
                     match_status=matched)


def run(ln, shares, terms=(), basis="controlled_pro_rata", category="streaming", default=None):
    return allocate_line(ln, shares=list(shares), terms=list(terms), statement_default_rights=default,
                         source_category=category, basis=basis)


def total(allocs):
    return sum((a.amount for a in allocs), D("0"))


def by_type(allocs, kind):
    return [a for a in allocs if a.allocation_type == kind]


# --------------------------------------------------------------------------- rounding


def test_largest_remainder_sums_exactly_for_thirds():
    parts = largest_remainder(D("100.00000000"), [("a", D("1")), ("b", D("1")), ("c", D("1"))])
    assert sum(parts.values()) == D("100")
    assert sorted(parts.values()) == [D("33.33333333"), D("33.33333333"), D("33.33333334")]
    # Deterministic tie-break: the extra unit goes to the lowest key.
    assert parts["a"] == D("33.33333334")


def test_largest_remainder_handles_negative_and_tiny_amounts():
    parts = largest_remainder(D("-0.00000001"), [("a", D("50")), ("b", D("50"))])
    assert sum(parts.values()) == D("-0.00000001")
    parts = largest_remainder(D("0.00000007"), [("a", D("1")), ("b", D("2")), ("c", D("4"))])
    assert parts == {"a": D("0.00000001"), "b": D("0.00000002"), "c": D("0.00000004")}


@pytest.mark.parametrize("amount", ["0.01", "1", "999999.99999999", "123.45678901"[:12], "-50.5"])
def test_allocations_always_sum_to_line_amount(amount):
    shares = [share("s1", "alice", "33.333333"), share("s2", "bob", "33.333333"),
              share("s3", "carol", "33.333334")]
    allocs = run(line(amount), shares)
    assert total(allocs) == D(amount)


# --------------------------------------------------------------------------- split allocation


def test_controlled_pro_rata_split():
    shares = [share("s1", "alice", "60"), share("s2", "bob", "40"),
              share("s3", "other", "100", controlled=False, territories=("JP",))]
    allocs = run(line("100"), shares)
    payable = {a.party_id: a.amount for a in by_type(allocs, "payable")}
    assert payable == {"alice": D("60.00000000"), "bob": D("40.00000000")}


def test_controlled_pro_rata_ignores_non_controlled_and_rescales():
    shares = [share("s1", "alice", "25"), share("s2", "bob", "25"),
              share("s3", "other", "50", controlled=False)]
    allocs = run(line("10"), shares)
    payable = {a.party_id: a.amount for a in by_type(allocs, "payable")}
    assert payable == {"alice": D("5"), "bob": D("5")}
    assert total(allocs) == D("10")


def test_gross_share_keeps_unowned_and_non_controlled_unallocated():
    shares = [share("s1", "alice", "50"), share("s2", "other", "30", controlled=False)]
    allocs = run(line("100"), shares, basis="gross_share")
    assert {a.reason: a.amount for a in by_type(allocs, "unallocated")} == {
        "non_controlled_share": D("30"), "unassigned_share": D("20")}
    assert by_type(allocs, "payable")[0].amount == D("50")
    assert total(allocs) == D("100")


def test_internal_party_portion_is_retained():
    shares = [share("s1", "us", "50", internal=True), share("s2", "artist", "50")]
    allocs = run(line("80"), shares)
    assert by_type(allocs, "retained")[0].amount == D("40")
    assert by_type(allocs, "payable")[0].amount == D("40")


# --------------------------------------------------------------------------- contract rates


def test_contract_rate_splits_payable_and_retained():
    shares = [share("s1", "artist", "100", contract="c1")]
    terms = [TermInput(id="t1", contract_id="c1", payee_party_id=None, rights_type=None,
                       source_category=None, territories=None, rate_percent=D("18"), basis="net")]
    allocs = run(line("12.34"), shares, terms)
    assert by_type(allocs, "payable")[0].amount == D("2.22120000")
    assert by_type(allocs, "retained")[0].amount == D("10.11880000")
    assert total(allocs) == D("12.34")


def test_most_specific_term_wins():
    shares = [share("s1", "artist", "100", contract="c1")]
    terms = [
        TermInput("t-general", "c1", None, None, None, None, D("15"), "net"),
        TermInput("t-streaming", "c1", "artist", "master", "streaming", None, D("25"), "net"),
        TermInput("t-other-party", "c1", "someone", "master", "streaming", None, D("90"), "net"),
    ]
    allocs = run(line("100"), shares, terms)
    payable = by_type(allocs, "payable")[0]
    assert payable.contract_term_id == "t-streaming" and payable.amount == D("25")


def test_gross_basis_term_uses_gross_amount():
    shares = [share("s1", "artist", "100", contract="c1")]
    terms = [TermInput("t1", "c1", None, None, None, None, D("10"), "gross")]
    allocs = run(line("70", gross="100"), shares, terms)
    assert by_type(allocs, "payable")[0].amount == D("10")
    assert by_type(allocs, "retained")[0].amount == D("60")


# --------------------------------------------------------------------------- held / unallocated


def test_missing_ownership_is_unallocated():
    allocs = run(line("5"), [])
    assert len(allocs) == 1 and allocs[0].reason == "missing_ownership" and allocs[0].amount == D("5")


def test_unmatched_line_is_unallocated():
    allocs = run(line("5", matched="unmatched", recording=None), [])
    assert allocs[0].reason == "unmatched_line"


def test_disputed_ownership_holds_income():
    shares = [share("s1", "alice", "50"), share("s2", "bob", "50", status="disputed")]
    allocs = run(line("10"), shares)
    assert [a.reason for a in allocs] == ["disputed_ownership"]


def test_over_allocated_ownership_holds_income():
    shares = [share("s1", "alice", "70"), share("s2", "bob", "50")]
    allocs = run(line("10"), shares)
    assert [a.reason for a in allocs] == ["over_allocated_ownership"]


def test_territory_and_effective_dates_are_respected():
    shares = [
        share("s-us", "us-pub", "100", territories=("US",)),
        share("s-world", "world-pub", "100", territories=("WORLD",), excluded=("US",)),
        share("s-old", "old-pub", "100", territories=("DE",), end=date(2025, 12, 31)),
    ]
    assert by_type(run(line("10", territory="US"), shares), "payable")[0].party_id == "us-pub"
    assert by_type(run(line("10", territory="FR"), shares), "payable")[0].party_id == "world-pub"
    # DE: s-old expired, s-world covers DE.
    assert by_type(run(line("10", territory="DE"), shares), "payable")[0].party_id == "world-pub"
    # Unknown territory only matches unrestricted WORLD shares -> none here.
    assert run(line("10", territory=None), shares)[0].reason == "missing_ownership"


def test_work_rights_resolve_through_linked_work():
    shares = [share("s1", "writer", "100", rights="performance", work="work-1")]
    allocs = run(line("9", linked=("work-1",)), shares, category="pro")
    assert by_type(allocs, "payable")[0].work_id == "work-1"
    assert run(line("9", linked=()), shares, category="pro")[0].reason == "no_linked_work"
    assert run(line("9", linked=("w1", "w2")), shares, category="pro")[0].reason == "multiple_linked_works"


def test_negative_adjustment_allocates_proportionally():
    shares = [share("s1", "alice", "50"), share("s2", "bob", "50")]
    allocs = run(line("-3.00000001"), shares)
    assert total(allocs) == D("-3.00000001")
    assert all(a.amount < 0 for a in allocs)


def test_zero_amount_produces_no_allocations():
    assert run(line("0"), [share("s1", "alice", "100")]) == []


def test_fingerprint_changes_when_inputs_change():
    base_shares = [share("s1", "alice", "100")]
    lines = [line("10")]
    a = inputs_fingerprint(basis="controlled_pro_rata", source_category="streaming", default_rights=None,
                           lines=lines, shares=base_shares, terms=[])
    b = inputs_fingerprint(basis="controlled_pro_rata", source_category="streaming", default_rights=None,
                           lines=lines, shares=base_shares, terms=[])
    c = inputs_fingerprint(basis="controlled_pro_rata", source_category="streaming", default_rights=None,
                           lines=lines, shares=[share("s1", "alice", "99")], terms=[])
    assert a == b != c


# --------------------------------------------------------------------------- audit regressions


def test_contract_share_without_applicable_term_is_held_not_paid_in_full():
    """F-H1: outside the contract window (or draft contract → no terms) the
    share must not fall back to a 100% royalty."""
    shares = [share("s1", "artist", "100", contract="c1")]
    terms = [TermInput("t1", "c1", None, None, None, None, D("20"), "net", valid_from=date(2026, 1, 1))]
    inside = run(line("100", when=date(2026, 6, 30)), shares, terms)
    assert by_type(inside, "payable")[0].amount == D("20")
    before = run(line("100", when=date(2025, 11, 30)), shares, terms)
    assert [a.reason for a in before] == ["no_applicable_contract_term"] and total(before) == D("100")
    draft = run(line("100"), shares, [])  # draft contracts contribute no terms
    assert [a.reason for a in draft] == ["no_applicable_contract_term"]


def test_equally_specific_conflicting_terms_are_held():
    """F-L2: never pick a rate silently by id order."""
    shares = [share("s1", "artist", "100", contract="c1")]
    terms = [TermInput("aaaa", "c1", None, "master", None, None, D("15"), "net"),
             TermInput("bbbb", "c1", None, None, "streaming", None, D("25"), "net")]
    assert [a.reason for a in run(line("10"), shares, terms)] == ["ambiguous_contract_terms"]
    # Identical rates are not ambiguous.
    same = [TermInput("aaaa", "c1", None, "master", None, None, D("15"), "net"),
            TermInput("bbbb", "c1", None, None, "streaming", None, D("15"), "net")]
    assert by_type(run(line("10"), shares, same), "payable")[0].amount == D("1.5")


def test_gross_basis_sign_mismatch_is_held_and_overpay_flagged():
    """F-M6: a refund with positive gross must not pay a royalty."""
    shares = [share("s1", "artist", "100", contract="c1")]
    terms = [TermInput("t1", "c1", None, None, None, None, D("80"), "gross")]
    refund = run(line("-10", gross="12"), shares, terms)
    assert [a.reason for a in refund] == ["gross_net_sign_mismatch"] and total(refund) == D("-10")
    over = run(line("70", gross="100"), shares, terms)
    payable = by_type(over, "payable")[0]
    assert payable.amount == D("80") and payable.explanation["payable_exceeds_portion"] is True
    assert total(over) == D("70")
