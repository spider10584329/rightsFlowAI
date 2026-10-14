"""Reference data (territories, rights types, roles, currencies, ...).
Static lists shared by every organization; any authenticated user may read."""

from fastapi import APIRouter, Depends

from app.core.dependencies import get_current_user
from app.models.contract import CONTRACT_TYPES
from app.schemas.catalog import (
    PARTY_ROLES,
    PARTY_TYPES,
    RECORDING_CONTRIBUTOR_ROLES,
    RELEASE_TYPES,
    WORK_CONTRIBUTOR_ROLES,
    ReferenceItem,
)
from app.services import reference

router = APIRouter(
    prefix="/reference",
    tags=["Reference"],
    dependencies=[Depends(get_current_user)],
)


def _label(code: str) -> str:
    return code.replace("_", " ").capitalize()


def _items(codes) -> list[dict[str, str]]:
    return [{"code": code, "name": _label(code)} for code in codes]


def territories() -> list[dict[str, str]]:
    items = [{"code": reference.WORLD, "name": "Worldwide"}]
    items += [{"code": code, "name": name}
              for code, name in sorted(reference.TERRITORIES.items(), key=lambda kv: kv[1])]
    return items


def all_reference_data() -> dict[str, object]:
    return {
        "territories": territories(),
        "territory_aliases": dict(reference.TERRITORY_ALIASES),
        "rights_types": [{"code": c, "name": n} for c, n in reference.RIGHTS_TYPES.items()],
        "work_rights_types": list(reference.WORK_RIGHTS_TYPES),
        "recording_rights_types": list(reference.RECORDING_RIGHTS_TYPES),
        "source_categories": [{"code": c, "name": n}
                              for c, n in reference.SOURCE_CATEGORIES.items()],
        "currencies": [{"code": c, "name": c} for c in reference.CURRENCIES],
        "party_roles": _items(PARTY_ROLES),
        "party_types": _items(PARTY_TYPES),
        "contributor_roles": {
            "work": _items(WORK_CONTRIBUTOR_ROLES),
            "recording": _items(RECORDING_CONTRIBUTOR_ROLES),
        },
        "release_types": _items(RELEASE_TYPES),
        "contract_types": _items(CONTRACT_TYPES),
    }


@router.get("")
def get_all_reference_data() -> dict[str, object]:
    """Every reference list in one response (for client-side caching)."""
    return all_reference_data()


@router.get("/territories", response_model=list[ReferenceItem])
def get_territories():
    """ISO 3166-1 alpha-2 territories, preceded by ``WORLD``."""
    return territories()


@router.get("/rights-types", response_model=list[ReferenceItem])
def get_rights_types():
    return [{"code": c, "name": n} for c, n in reference.RIGHTS_TYPES.items()]


@router.get("/source-categories", response_model=list[ReferenceItem])
def get_source_categories():
    return [{"code": c, "name": n} for c, n in reference.SOURCE_CATEGORIES.items()]


@router.get("/currencies", response_model=list[ReferenceItem])
def get_currencies():
    return [{"code": c, "name": c} for c in reference.CURRENCIES]


@router.get("/party-roles", response_model=list[ReferenceItem])
def get_party_roles():
    return _items(PARTY_ROLES)


@router.get("/contributor-roles", response_model=dict[str, list[ReferenceItem]])
def get_contributor_roles():
    return {"work": _items(WORK_CONTRIBUTOR_ROLES),
            "recording": _items(RECORDING_CONTRIBUTOR_ROLES)}


@router.get("/release-types", response_model=list[ReferenceItem])
def get_release_types():
    return _items(RELEASE_TYPES)


@router.get("/contract-types", response_model=list[ReferenceItem])
def get_contract_types():
    return _items(CONTRACT_TYPES)
