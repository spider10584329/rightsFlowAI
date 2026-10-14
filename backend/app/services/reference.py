"""Reference data: territories, rights types, roles and source categories."""

from collections.abc import Iterable
from decimal import Decimal

WORLD = "WORLD"

# ISO 3166-1 alpha-2 codes.
TERRITORIES: dict[str, str] = {
    "AD": "Andorra", "AE": "United Arab Emirates", "AF": "Afghanistan", "AG": "Antigua and Barbuda",
    "AL": "Albania", "AM": "Armenia", "AO": "Angola", "AR": "Argentina", "AT": "Austria",
    "AU": "Australia", "AZ": "Azerbaijan", "BA": "Bosnia and Herzegovina", "BB": "Barbados",
    "BD": "Bangladesh", "BE": "Belgium", "BF": "Burkina Faso", "BG": "Bulgaria", "BH": "Bahrain",
    "BJ": "Benin", "BM": "Bermuda", "BN": "Brunei", "BO": "Bolivia", "BR": "Brazil", "BS": "Bahamas",
    "BW": "Botswana", "BY": "Belarus", "BZ": "Belize", "CA": "Canada", "CD": "DR Congo",
    "CH": "Switzerland", "CI": "Côte d'Ivoire", "CL": "Chile", "CM": "Cameroon", "CN": "China",
    "CO": "Colombia", "CR": "Costa Rica", "CU": "Cuba", "CV": "Cabo Verde", "CY": "Cyprus",
    "CZ": "Czechia", "DE": "Germany", "DK": "Denmark", "DM": "Dominica", "DO": "Dominican Republic",
    "DZ": "Algeria", "EC": "Ecuador", "EE": "Estonia", "EG": "Egypt", "ES": "Spain", "ET": "Ethiopia",
    "FI": "Finland", "FJ": "Fiji", "FR": "France", "GA": "Gabon", "GB": "United Kingdom",
    "GE": "Georgia", "GH": "Ghana", "GM": "Gambia", "GR": "Greece", "GT": "Guatemala", "GY": "Guyana",
    "HK": "Hong Kong", "HN": "Honduras", "HR": "Croatia", "HT": "Haiti", "HU": "Hungary",
    "ID": "Indonesia", "IE": "Ireland", "IL": "Israel", "IN": "India", "IQ": "Iraq", "IS": "Iceland",
    "IT": "Italy", "JM": "Jamaica", "JO": "Jordan", "JP": "Japan", "KE": "Kenya", "KG": "Kyrgyzstan",
    "KH": "Cambodia", "KR": "South Korea", "KW": "Kuwait", "KZ": "Kazakhstan", "LA": "Laos",
    "LB": "Lebanon", "LI": "Liechtenstein", "LK": "Sri Lanka", "LT": "Lithuania", "LU": "Luxembourg",
    "LV": "Latvia", "MA": "Morocco", "MC": "Monaco", "MD": "Moldova", "ME": "Montenegro",
    "MG": "Madagascar", "MK": "North Macedonia", "ML": "Mali", "MN": "Mongolia", "MO": "Macao",
    "MT": "Malta", "MU": "Mauritius", "MV": "Maldives", "MW": "Malawi", "MX": "Mexico",
    "MY": "Malaysia", "MZ": "Mozambique", "NA": "Namibia", "NE": "Niger", "NG": "Nigeria",
    "NI": "Nicaragua", "NL": "Netherlands", "NO": "Norway", "NP": "Nepal", "NZ": "New Zealand",
    "OM": "Oman", "PA": "Panama", "PE": "Peru", "PG": "Papua New Guinea", "PH": "Philippines",
    "PK": "Pakistan", "PL": "Poland", "PR": "Puerto Rico", "PT": "Portugal", "PY": "Paraguay",
    "QA": "Qatar", "RO": "Romania", "RS": "Serbia", "RU": "Russia", "RW": "Rwanda",
    "SA": "Saudi Arabia", "SC": "Seychelles", "SE": "Sweden", "SG": "Singapore", "SI": "Slovenia",
    "SK": "Slovakia", "SN": "Senegal", "SR": "Suriname", "SV": "El Salvador", "TH": "Thailand",
    "TJ": "Tajikistan", "TN": "Tunisia", "TR": "Türkiye", "TT": "Trinidad and Tobago",
    "TW": "Taiwan", "TZ": "Tanzania", "UA": "Ukraine", "UG": "Uganda", "US": "United States",
    "UY": "Uruguay", "UZ": "Uzbekistan", "VE": "Venezuela", "VN": "Vietnam", "ZA": "South Africa",
    "ZM": "Zambia", "ZW": "Zimbabwe",
}

TERRITORY_ALIASES = {"UK": "GB", "USA": "US", "WW": WORLD, "WORLDWIDE": WORLD, "ROW": WORLD}

RIGHTS_TYPES = {
    "performance": "Public performance (work)",
    "mechanical": "Mechanical reproduction (work)",
    "sync": "Synchronization",
    "print": "Print / lyrics (work)",
    "master": "Master recording",
    "neighbouring": "Neighbouring rights (recording)",
}
WORK_RIGHTS_TYPES = ("performance", "mechanical", "sync", "print")
RECORDING_RIGHTS_TYPES = ("master", "neighbouring", "sync")

SOURCE_CATEGORIES = {
    "streaming": "Streaming platforms",
    "distributor": "Digital distributors",
    "publishing_admin": "Publishing administrators",
    "pro": "Performance rights organizations",
    "mechanical": "Mechanical royalty sources",
    "licensing": "Licensing revenue",
    "manual_adjustment": "Manual adjustments",
}

# Rights type assumed for statement lines when neither the line nor the
# statement specifies one.
DEFAULT_RIGHTS_BY_SOURCE = {
    "streaming": "master",
    "distributor": "master",
    "publishing_admin": "mechanical",
    "pro": "performance",
    "mechanical": "mechanical",
    "licensing": "sync",
    "manual_adjustment": "master",
}

CURRENCIES = (
    "USD", "EUR", "GBP", "CAD", "AUD", "JPY", "SEK", "NOK", "DKK", "CHF", "NZD", "BRL",
    "MXN", "ZAR", "INR", "KRW", "SGD", "HKD", "PLN", "CZK",
)


# ISO 4217 minor units that differ from the usual 2 (amounts are paid in
# whole yen / won; dinars have 3 decimals).
_MINOR_UNITS = {
    **dict.fromkeys(("JPY", "KRW", "CLP", "ISK", "VND", "UGX", "XAF", "XOF", "PYG", "KMF",
                     "GNF", "RWF", "VUV", "XPF", "BIF", "DJF"), 0),
    **dict.fromkeys(("BHD", "KWD", "OMR", "JOD", "TND", "IQD", "LYD"), 3),
}


def currency_minor_unit(currency: str) -> Decimal:
    """Smallest payable amount in ``currency`` as a Decimal quantum (0.01, 1, 0.001)."""
    return Decimal(1).scaleb(-_MINOR_UNITS.get(currency.upper(), 2))


def normalize_territory(value: str | None) -> str | None:
    if value is None:
        return None
    code = value.strip().upper()
    if not code:
        return None
    code = TERRITORY_ALIASES.get(code, code)
    if code == WORLD or code in TERRITORIES:
        return code
    return None


def is_valid_territory(code: str) -> bool:
    return code == WORLD or code in TERRITORIES


def expand(territories: Iterable[str], excluded: Iterable[str] | None = None) -> set[str]:
    """Concrete country codes covered by a territory list."""
    codes = set(territories)
    covered = set(TERRITORIES) if WORLD in codes else {c for c in codes if c in TERRITORIES}
    return covered - set(excluded or [])


def territory_covers(territories: Iterable[str], excluded: Iterable[str] | None,
                     territory: str | None) -> bool:
    """Does a share's territory scope apply to a transaction territory?

    Transactions without a (recognized) territory only match WORLD-wide shares.
    """
    codes = set(territories)
    excluded_set = set(excluded or [])
    if territory is None or territory == WORLD:
        return WORLD in codes and not excluded_set
    if territory in excluded_set:
        return False
    return WORLD in codes or territory in codes


def territories_overlap(a: Iterable[str], a_excl: Iterable[str] | None,
                        b: Iterable[str], b_excl: Iterable[str] | None) -> set[str]:
    return expand(a, a_excl) & expand(b, b_excl)
