"""Normalization and validation for music industry identifiers.

- ISRC  (ISO 3901): CC-XXX-YY-NNNNN, 12 chars, no check digit.
- ISWC  (ISO 15707): T-DDD.DDD.DDD-C, mod-10 weighted check digit.
- UPC/EAN (GTIN-12/13/14): GS1 mod-10 check digit.
- IPI name number: 9-11 digits (format check only; check digits are not
  verified because societies issue legacy numbers that fail naive checks).
- ISNI (ISO 27729): 16 chars, ISO 7064 MOD 11-2 check character.
"""

import re

_ISRC_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}\d{7}$")
_ISWC_RE = re.compile(r"^T\d{10}$")


def _compact(value: str | None) -> str:
    return re.sub(r"[\s\-.]", "", value or "").upper()


def normalize_isrc(value: str | None) -> str | None:
    compact = _compact(value)
    return compact or None


def is_valid_isrc(value: str | None) -> bool:
    compact = normalize_isrc(value)
    return bool(compact and _ISRC_RE.match(compact))


def normalize_iswc(value: str | None) -> str | None:
    compact = _compact(value)
    return compact or None


def is_valid_iswc(value: str | None) -> bool:
    compact = normalize_iswc(value)
    if not compact or not _ISWC_RE.match(compact):
        return False
    digits = [int(d) for d in compact[1:10]]
    total = 1 + sum(d * (i + 1) for i, d in enumerate(digits))
    check = (10 - total % 10) % 10
    return check == int(compact[10])


def format_iswc(value: str | None) -> str | None:
    compact = normalize_iswc(value)
    if not compact or not is_valid_iswc(compact):
        return compact
    return f"T-{compact[1:4]}.{compact[4:7]}.{compact[7:10]}-{compact[10]}"


def normalize_upc(value: str | None) -> str | None:
    compact = re.sub(r"\D", "", value or "")
    return compact or None


def is_valid_upc(value: str | None) -> bool:
    """Validate a GTIN-12 (UPC-A), GTIN-13 (EAN) or GTIN-14."""
    digits = normalize_upc(value)
    if not digits or len(digits) not in (12, 13, 14):
        return False
    body, check = digits[:-1], int(digits[-1])
    total = 0
    for i, ch in enumerate(reversed(body)):
        total += int(ch) * (3 if i % 2 == 0 else 1)
    return (10 - total % 10) % 10 == check


def normalize_ipi(value: str | None) -> str | None:
    digits = re.sub(r"\D", "", value or "")
    if not digits:
        return None
    return digits.zfill(11) if len(digits) <= 11 else digits


def is_valid_ipi(value: str | None) -> bool:
    digits = re.sub(r"\D", "", value or "")
    return 9 <= len(digits) <= 11


def normalize_isni(value: str | None) -> str | None:
    compact = _compact(value)
    return compact or None


def is_valid_isni(value: str | None) -> bool:
    compact = normalize_isni(value)
    if not compact or not re.match(r"^\d{15}[\dX]$", compact):
        return False
    total = 0
    for ch in compact[:15]:
        total = (total + int(ch)) * 2
    check = (12 - total % 11) % 11
    expected = "X" if check == 10 else str(check)
    return compact[15] == expected


VALIDATORS = {
    "isrc": is_valid_isrc,
    "iswc": is_valid_iswc,
    "upc": is_valid_upc,
    "ipi": is_valid_ipi,
    "isni": is_valid_isni,
}
