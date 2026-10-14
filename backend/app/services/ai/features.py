"""AI-powered rights intelligence features.

Every AI call goes through ``run_structured`` (configuration, plan
entitlement, monthly limit, schema validation and usage/cost tracking) and is
grounded in records fetched from the organization's own data. Record content
and user text are fenced as untrusted data. After each call, ids the model
cites are checked against the set of ids that were actually supplied and any
others are dropped. Nothing here changes catalog data directly: proposed
metadata changes become pending ``AISuggestion`` rows that a human approves.

Deterministic features (status, usage, completeness, duplicates candidates,
anomalies, report figures) never call the AI and keep working without a
provider.
"""

import json
import re
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from fastapi import Request
from pydantic import BaseModel
from sqlalchemy import and_, case, distinct, exists, func, or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.errors import (
    ConflictError,
    NotFoundError,
    ServiceUnavailableError,
    ValidationFailedError,
)
from app.db.mixins import utc_now
from app.models.billing import AISuggestion, AIUsageRecord
from app.models.catalog import (
    Party,
    Recording,
    RecordingWork,
    Release,
    ReleaseTrack,
    Work,
    WorkContributor,
)
from app.models.contract import Contract, ContractAsset, ContractParty
from app.models.rights import OwnershipShare, RightsConflict
from app.models.royalty import RoyaltyStatement, StatementLine
from app.schemas.ai import (
    CANONICAL_FIELDS,
    AnomalySummary,
    AssistantAnswer,
    CatalogSearchPlan,
    ConflictExplanation,
    DuplicateAssessment,
    MetadataCleanupProposal,
    ReportNarrative,
    StatementClassification,
)
from app.services import billing, identifiers
from app.services.ai.anomalies import detect_anomalies
from app.services.ai.provider import ai_is_configured, get_ai_provider
from app.services.ai.runner import ADVISORY_NOTICE, fence_untrusted, run_structured
from app.services.audit import diff, record_audit
from app.services.reference import SOURCE_CATEGORIES, TERRITORIES

FEATURE_ASSISTANT = "catalog_assistant"
FEATURE_SEARCH = "catalog_search"
FEATURE_METADATA = "metadata_cleanup"
FEATURE_DUPLICATE = "duplicate_explain"
FEATURE_CONFLICT = "conflict_explain"
FEATURE_ANOMALY = "anomaly_summary"
FEATURE_CLASSIFY = "statement_classify"
FEATURE_REPORT = "report_summary"
FEATURE_CONNECTION_CHECK = "connection_check"

# Provider failures that mean "AI does not work with the current settings", as opposed to
# a single request that couldn't be processed.
_BLOCKING_AI_ERRORS = {"ai_auth_failed", "ai_permission_denied", "ai_billing", "ai_configuration_error",
                       "ai_model_unavailable", "ai_unreachable"}
_ERROR_CODE_RE = re.compile(r"^\[([a-z_]+)\]\s*")

KIND_METADATA_CLEANUP = "metadata_cleanup"
FINAL_STATEMENT_STATUSES = ("processed", "calculated", "posted")

ENTITY_MODELS: dict[str, Any] = {
    "work": Work,
    "recording": Recording,
    "release": Release,
    "party": Party,
    "contract": Contract,
}

# Fields an approved metadata suggestion may change, per entity type.
CLEANUP_FIELDS: dict[str, tuple[str, ...]] = {
    "work": ("title", "alternate_titles", "iswc", "language", "genre"),
    "recording": ("title", "version_title", "isrc", "display_artist"),
    "party": ("name", "legal_name", "ipi_number", "isni", "country_code"),
}
_IDENTIFIER_FIELDS = {"iswc", "isrc", "ipi_number", "isni"}

assert set(SOURCE_CATEGORIES) == {
    "streaming", "distributor", "publishing_admin", "pro", "mechanical", "licensing",
    "manual_adjustment",
}, "StatementClassification.source_category is out of sync with reference data"


# --------------------------------------------------------------------------- helpers


def _json(data: Any) -> str:
    def default(value: Any) -> Any:
        if isinstance(value, Decimal):
            return format(value, "f")
        if isinstance(value, (date, datetime)):
            return value.isoformat()
        return str(value)

    return json.dumps(data, default=default, ensure_ascii=False, indent=1)


def _ai_meta(meta: dict) -> dict:
    return {
        "ai_generated": True,
        "advisory_notice": meta.get("advisory_notice", ADVISORY_NOTICE),
        "provider": meta.get("provider"),
        "model": meta.get("model"),
    }


def _like(term: str) -> str:
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _ilike(column: Any, term: str) -> Any:
    return column.ilike(_like(term), escape="\\")


def _blank(column: Any) -> Any:
    return or_(column.is_(None), column == "")


def _present(column: Any) -> Any:
    return and_(column.is_not(None), column != "")


def _month_start() -> datetime:
    return utc_now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _dec(value: Any) -> Decimal:
    return Decimal(value) if value is not None else Decimal("0")


def _pct(part: int, whole: int) -> str:
    if whole <= 0:
        return "0.0"
    return format((Decimal(part) * 100 / Decimal(whole)).quantize(Decimal("0.1")), "f")


def entity_title(entity_type: str, obj: Any) -> str:
    return obj.name if entity_type == "party" else obj.title


def load_entity(db: Session, organization_id: str, entity_type: str, entity_id: str) -> Any:
    model = ENTITY_MODELS.get(entity_type)
    if model is None:
        raise ValidationFailedError(f"Unsupported entity type: {entity_type}")
    obj = db.scalar(
        select(model).where(model.id == entity_id, model.organization_id == organization_id)
    )
    if obj is None:
        raise NotFoundError(f"{entity_type.capitalize()} not found")
    return obj


def describe_entity(entity_type: str, obj: Any) -> dict[str, Any]:
    """Compact factual description of one record (fed to the model as data)."""
    if entity_type == "work":
        return {
            "entity_type": "work", "id": obj.id, "title": obj.title,
            "alternate_titles": obj.alternate_titles or [], "iswc": obj.iswc,
            "internal_code": obj.internal_code, "language": obj.language, "genre": obj.genre,
            "creation_year": obj.creation_year, "status": obj.status,
            "writers": [
                {"party_id": c.party_id, "name": c.party.name if c.party else None, "role": c.role}
                for c in obj.contributors
            ],
        }
    if entity_type == "recording":
        return {
            "entity_type": "recording", "id": obj.id, "title": obj.title,
            "version_title": obj.version_title, "isrc": obj.isrc,
            "display_artist": obj.display_artist,
            "primary_artist": (
                {"party_id": obj.primary_artist.id, "name": obj.primary_artist.name}
                if obj.primary_artist else None
            ),
            "duration_seconds": obj.duration_seconds, "recording_date": obj.recording_date,
            "status": obj.status,
            "works": [
                {"work_id": link.work_id, "title": link.work.title if link.work else None}
                for link in obj.work_links
            ],
            "contributors": [
                {"party_id": c.party_id, "name": c.party.name if c.party else None, "role": c.role}
                for c in obj.contributors
            ],
        }
    if entity_type == "release":
        return {
            "entity_type": "release", "id": obj.id, "title": obj.title,
            "release_type": obj.release_type, "upc": obj.upc,
            "catalog_number": obj.catalog_number, "display_artist": obj.display_artist,
            "release_date": obj.release_date,
            "label": obj.label.name if obj.label else None, "status": obj.status,
            "track_count": len(obj.tracks),
        }
    if entity_type == "party":
        return {
            "entity_type": "party", "id": obj.id, "name": obj.name,
            "party_type": obj.party_type, "roles": obj.roles or [],
            "legal_name": obj.legal_name, "country_code": obj.country_code,
            "ipi_number": obj.ipi_number, "isni": obj.isni,
            "pro_affiliation": obj.pro_affiliation, "status": obj.status,
        }
    if entity_type == "contract":
        return {
            "entity_type": "contract", "id": obj.id, "title": obj.title,
            "reference": obj.reference, "contract_type": obj.contract_type,
            "status": obj.status, "start_date": obj.start_date, "end_date": obj.end_date,
            "territories": obj.territories, "rights_granted": obj.rights_granted,
            "parties": [
                {"party_id": p.party_id, "name": p.party.name if p.party else None, "role": p.role}
                for p in obj.parties
            ],
        }
    raise ValueError(entity_type)


# --------------------------------------------------------------------------- status & usage


def ai_status(db: Session, organization_id: str) -> dict[str, Any]:
    configured = ai_is_configured()
    provider_name = model_name = None
    if configured:
        try:
            provider = get_ai_provider()
            provider_name, model_name = provider.name, provider.model
        except Exception:  # pragma: no cover - misconfiguration surfaces on use
            provider_name, model_name = settings.ai_provider, settings.ai_model
    plan = billing.get_plan_for_org(db, organization_id)
    row = db.execute(
        select(
            func.count(AIUsageRecord.id),
            func.coalesce(func.sum(AIUsageRecord.input_tokens + AIUsageRecord.output_tokens), 0),
            func.coalesce(func.sum(AIUsageRecord.estimated_cost_usd), 0),
        ).where(
            AIUsageRecord.organization_id == organization_id,
            AIUsageRecord.created_at >= _month_start(),
        )
    ).one()
    limit = plan.limits.get("max_ai_requests_per_month")
    return {
        "configured": configured,
        "provider": provider_name,
        "model": model_name,
        "connectivity": _connectivity(db, organization_id) if configured else _UNVERIFIED,
        "plan_allows_ai": bool(plan.limits.get("ai_features", False)),
        "requests_this_month": int(row[0] or 0),
        "monthly_limit": int(limit) if limit is not None else None,
        "tokens_this_month": int(row[1] or 0),
        "estimated_cost_this_month": format(_dec(row[2]), "f"),
        "advisory_notice": ADVISORY_NOTICE,
    }


_UNVERIFIED = {"state": "unverified", "last_success_at": None, "last_error_code": None,
               "last_error_message": None, "last_error_at": None}


def _connectivity(db: Session, organization_id: str) -> dict[str, Any]:
    """Live state from this organization's own requests (no cross-tenant data)."""
    last_success = db.scalar(select(func.max(AIUsageRecord.created_at)).where(
        AIUsageRecord.organization_id == organization_id,
        AIUsageRecord.status.in_(("success", "invalid_output"))))
    last_error = db.execute(select(AIUsageRecord.error, AIUsageRecord.created_at).where(
        AIUsageRecord.organization_id == organization_id, AIUsageRecord.status == "error")
        .order_by(AIUsageRecord.created_at.desc()).limit(1)).first()
    code = message = error_at = None
    if last_error is not None:
        error_at = last_error[1]
        match = _ERROR_CODE_RE.match(last_error[0] or "")
        code = match.group(1) if match else None
        message = _ERROR_CODE_RE.sub("", last_error[0] or "") or None
    if error_at and (last_success is None or error_at > last_success) and code in _BLOCKING_AI_ERRORS:
        state = "failing"
    elif last_success is not None:
        state = "verified"
    else:
        state = "unverified"
    return {"state": state, "last_success_at": last_success, "last_error_code": code,
            "last_error_message": message, "last_error_at": error_at}


class _ConnectionCheck(BaseModel):
    ok: bool


def check_connection(db: Session, organization_id: str, user_id: str) -> dict[str, Any]:
    """One minimal real request (counts as one AI request) to verify the provider works."""
    run_structured(db, organization_id=organization_id, user_id=user_id, feature=FEATURE_CONNECTION_CHECK,
                   instructions="Connectivity check. Respond with ok set to true.",
                   output_model=_ConnectionCheck, max_tokens=256)
    return ai_status(db, organization_id)


def monthly_usage_by_feature(db: Session, organization_id: str) -> dict[str, Any]:
    start = _month_start()
    rows = db.execute(
        select(
            AIUsageRecord.feature,
            func.count(AIUsageRecord.id),
            func.sum(case((AIUsageRecord.status != "success", 1), else_=0)),
            func.coalesce(func.sum(AIUsageRecord.input_tokens), 0),
            func.coalesce(func.sum(AIUsageRecord.output_tokens), 0),
            func.coalesce(func.sum(AIUsageRecord.estimated_cost_usd), 0),
        )
        .where(
            AIUsageRecord.organization_id == organization_id,
            AIUsageRecord.created_at >= start,
        )
        .group_by(AIUsageRecord.feature)
        .order_by(AIUsageRecord.feature)
    ).all()
    by_feature = [
        {
            "feature": feature,
            "requests": int(count or 0),
            "errors": int(errors or 0),
            "input_tokens": int(tin or 0),
            "output_tokens": int(tout or 0),
            "estimated_cost_usd": format(_dec(cost), "f"),
        }
        for feature, count, errors, tin, tout, cost in rows
    ]
    return {
        "month_start": start,
        "month_by_feature": by_feature,
        "month_total_requests": sum(f["requests"] for f in by_feature),
        "month_total_cost_usd": format(sum((_dec(r[5]) for r in rows), Decimal("0")), "f"),
    }


# --------------------------------------------------------------------------- catalog assistant

_STOPWORDS = {
    "the", "and", "for", "are", "was", "were", "with", "that", "this", "what", "which", "who",
    "whom", "how", "many", "much", "does", "did", "have", "has", "had", "our", "your", "their",
    "from", "about", "into", "any", "all", "list", "show", "tell", "give", "find", "there",
    "song", "songs", "track", "tracks", "work", "works", "recording", "recordings", "release",
    "releases", "contract", "contracts", "party", "parties", "catalog", "catalogue", "please",
    "can", "you", "me", "is", "of", "in", "on", "to", "a", "an", "do", "we", "my", "it",
    "its", "be", "by", "or", "not", "no", "yes", "when", "where", "why", "who's", "whose",
    "them", "they", "these", "those", "some", "most", "least", "than", "then", "also",
}
_ISRC_TEXT_RE = re.compile(r"\b[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}\b")
_ISWC_TEXT_RE = re.compile(r"\bT-?\d{3}\.?\d{3}\.?\d{3}-?\d\b")
_UPC_TEXT_RE = re.compile(r"\b\d{12,14}\b")

CONTEXT_PER_TYPE = 8


def _keywords(text: str) -> list[str]:
    words = re.findall(r"[\w][\w'&.-]*", text.lower())
    seen: list[str] = []
    for word in words:
        word = word.strip(".-'")
        if len(word) < 3 or word in _STOPWORDS or word in seen:
            continue
        seen.append(word)
    return seen[:8]


def _identifiers_in(text: str) -> dict[str, set[str]]:
    upper = text.upper()
    found: dict[str, set[str]] = {"isrc": set(), "iswc": set(), "upc": set()}
    for match in _ISRC_TEXT_RE.findall(upper):
        found["isrc"].add(identifiers.normalize_isrc(match) or match)
    for match in _ISWC_TEXT_RE.findall(upper):
        value = identifiers.normalize_iswc(match) or match
        found["iswc"].update({value, identifiers.format_iswc(value) or value})
    for match in _UPC_TEXT_RE.findall(upper):
        found["upc"].add(match)
    return found


def _search_conditions(entity_type: str, terms: list[str], ids: dict[str, set[str]]) -> list:
    conds: list = []
    if entity_type == "work":
        for t in terms:
            conds += [_ilike(Work.title, t), Work.internal_code == t]
        if ids["iswc"]:
            conds.append(Work.iswc.in_(ids["iswc"]))
    elif entity_type == "recording":
        for t in terms:
            conds += [_ilike(Recording.title, t), _ilike(Recording.display_artist, t),
                      _ilike(Recording.version_title, t)]
        if ids["isrc"]:
            conds.append(Recording.isrc.in_(ids["isrc"]))
    elif entity_type == "release":
        for t in terms:
            conds += [_ilike(Release.title, t), _ilike(Release.display_artist, t),
                      Release.catalog_number == t]
        if ids["upc"]:
            conds.append(Release.upc.in_(ids["upc"]))
    elif entity_type == "party":
        for t in terms:
            conds += [_ilike(Party.name, t), _ilike(Party.legal_name, t),
                      Party.ipi_number == t, Party.isni == t.upper()]
    elif entity_type == "contract":
        for t in terms:
            conds += [_ilike(Contract.title, t), _ilike(Contract.reference, t)]
    return conds


def _org_summary(db: Session, organization_id: str) -> dict[str, Any]:
    def count(model: Any, *where: Any) -> int:
        return int(db.scalar(
            select(func.count()).select_from(model).where(
                model.organization_id == organization_id, *where
            )
        ) or 0)

    contract_status = dict(db.execute(
        select(Contract.status, func.count(Contract.id))
        .where(Contract.organization_id == organization_id)
        .group_by(Contract.status)
    ).all())
    return {
        "works": count(Work, Work.status != "archived"),
        "recordings": count(Recording, Recording.status != "archived"),
        "releases": count(Release, Release.status != "archived"),
        "parties": count(Party, Party.status != "archived"),
        "contracts_by_status": {k: int(v) for k, v in contract_status.items()},
        "open_rights_conflicts": count(RightsConflict, RightsConflict.status == "open"),
        "royalty_statements": count(RoyaltyStatement),
        "pending_ai_suggestions": count(AISuggestion, AISuggestion.status == "pending"),
    }


def retrieve_context(db: Session, organization_id: str, question: str
                     ) -> tuple[list[dict[str, Any]], dict[tuple[str, str], str]]:
    """Deterministic keyword/identifier retrieval. Returns (records, {(type, id): title})."""
    terms = _keywords(question)
    ids = _identifiers_in(question)
    records: list[dict[str, Any]] = []
    known: dict[tuple[str, str], str] = {}
    matched_any = False
    for entity_type, model in ENTITY_MODELS.items():
        conds = _search_conditions(entity_type, terms, ids)
        if not conds:
            continue
        rows = db.scalars(
            select(model).where(model.organization_id == organization_id, or_(*conds))
            .order_by(model.updated_at.desc()).limit(CONTEXT_PER_TYPE)
        ).unique().all()
        for obj in rows:
            matched_any = True
            records.append(describe_entity(entity_type, obj))
            known[(entity_type, obj.id)] = entity_title(entity_type, obj)
    if not matched_any:
        # Nothing matched: give the model the most recently updated records instead.
        for entity_type, model in ENTITY_MODELS.items():
            rows = db.scalars(
                select(model).where(model.organization_id == organization_id)
                .order_by(model.updated_at.desc()).limit(5)
            ).unique().all()
            for obj in rows:
                records.append(describe_entity(entity_type, obj))
                known[(entity_type, obj.id)] = entity_title(entity_type, obj)
    # Related parties named inside supplied records are citable too.
    for rec in records:
        for key in ("writers", "contributors", "parties"):
            for person in rec.get(key) or []:
                if person.get("party_id"):
                    known.setdefault(("party", person["party_id"]), person.get("name") or "")
        if rec.get("primary_artist"):
            pa = rec["primary_artist"]
            known.setdefault(("party", pa["party_id"]), pa.get("name") or "")
        for link in rec.get("works") or []:
            known.setdefault(("work", link["work_id"]), link.get("title") or "")
    return records, known


def run_assistant(db: Session, organization_id: str, user_id: str, question: str,
                  history: list[dict[str, str]]) -> dict[str, Any]:
    records, known = retrieve_context(db, organization_id, question)
    summary = _org_summary(db, organization_id)
    history_text = "\n".join(f"{turn['role']}: {turn['content']}" for turn in history[-10:])
    instructions = (
        "Answer the user's question about their music catalog using ONLY the organization "
        "summary and catalog records below. Cite supporting records in cited_records using the "
        "exact entity_type and id values that appear in the records; never cite anything else. "
        "If the records do not contain the information needed, set insufficient_data to true "
        "and explain what is missing instead of guessing.\n\n"
        f"Organization summary (system-computed counts):\n{_json(summary)}\n\n"
        f"{fence_untrusted('catalog_records', _json(records))}\n\n"
        + (f"{fence_untrusted('conversation_history', history_text)}\n\n" if history_text else "")
        + f"{fence_untrusted('user_question', question)}"
    )
    answer, meta = run_structured(
        db, organization_id=organization_id, user_id=user_id, feature=FEATURE_ASSISTANT,
        instructions=instructions, output_model=AssistantAnswer,
    )
    cited: list[dict[str, Any]] = []
    dropped = 0
    seen: set[tuple[str, str]] = set()
    for ref in answer.cited_records:
        key = (ref.entity_type, ref.id)
        if key not in known:
            dropped += 1
            continue
        if key in seen:
            continue
        seen.add(key)
        cited.append({"entity_type": ref.entity_type, "id": ref.id, "title": known[key]})
    return {
        **_ai_meta(meta),
        "answer": answer.answer,
        "cited_records": cited,
        "follow_up_questions": answer.follow_up_questions[:5],
        "insufficient_data": answer.insufficient_data,
        "dropped_citations": dropped,
        "context_records": len(records),
    }


# --------------------------------------------------------------------------- NL catalog search

SEARCH_MISSING_FIELDS: dict[str, tuple[str, ...]] = {
    "work": ("iswc", "writers", "shares", "language", "genre", "recordings"),
    "recording": ("isrc", "work", "primary_artist", "duration", "display_artist"),
    "release": ("upc", "release_date", "tracks", "label"),
    "party": ("ipi_number", "isni", "country_code", "email"),
    "contract": ("start_date", "end_date", "parties", "assets"),
}
SEARCH_STATUSES: dict[str, tuple[str, ...]] = {
    "work": ("active", "draft", "archived"),
    "recording": ("active", "draft", "archived"),
    "release": ("active", "draft", "archived"),
    "party": ("active", "draft", "archived"),
    "contract": ("draft", "pending_signature", "active", "expired", "terminated"),
}
SEARCH_TEXT_FILTERS: dict[str, tuple[str, ...]] = {
    "work": ("title_contains", "artist_contains", "writer_contains", "identifier"),
    "recording": ("title_contains", "artist_contains", "writer_contains", "identifier"),
    "release": ("title_contains", "artist_contains", "identifier"),
    "party": ("title_contains", "artist_contains", "writer_contains", "identifier"),
    "contract": ("title_contains", "artist_contains", "writer_contains", "identifier"),
}


def _clean_text(value: str | None, max_len: int = 255) -> str | None:
    if value is None:
        return None
    value = value.strip()[:max_len]
    return value or None


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


def validate_search_plan(plan: CatalogSearchPlan) -> tuple[dict[str, Any], list[str]]:
    """Reduce the AI plan to filters this endpoint supports for the entity type."""
    et = plan.entity_type
    ignored: list[str] = []
    cleaned: dict[str, Any] = {"entity_type": et}
    for key in ("title_contains", "artist_contains", "writer_contains", "identifier"):
        value = _clean_text(getattr(plan, key), 100)
        if value is None:
            cleaned[key] = None
            continue
        if key not in SEARCH_TEXT_FILTERS[et]:
            ignored.append(f"{key} is not supported for {et}")
            cleaned[key] = None
            continue
        cleaned[key] = value
    missing = []
    for field in plan.missing_fields:
        field = field.strip().lower()
        if field in SEARCH_MISSING_FIELDS[et]:
            if field not in missing:
                missing.append(field)
        else:
            ignored.append(f"missing field '{field[:40]}' is not supported for {et}")
    cleaned["missing_fields"] = missing
    if plan.status and plan.status not in SEARCH_STATUSES[et]:
        ignored.append(f"status '{plan.status}' does not apply to {et}")
        cleaned["status"] = None
    else:
        cleaned["status"] = plan.status
    for key in ("created_after", "created_before"):
        raw = getattr(plan, key)
        parsed = _parse_date(raw)
        if raw and parsed is None:
            ignored.append(f"{key} '{raw[:20]}' is not a valid date")
        cleaned[key] = parsed.isoformat() if parsed else None
    cleaned["explanation"] = plan.explanation[:500]
    return cleaned, ignored


def _party_name_ids(organization_id: str, term: str) -> Any:
    return select(Party.id).where(
        Party.organization_id == organization_id,
        or_(_ilike(Party.name, term), _ilike(Party.legal_name, term)),
    )


def _search_statement(organization_id: str, plan: dict[str, Any]) -> tuple[Any, Any]:
    et = plan["entity_type"]
    model = ENTITY_MODELS[et]
    conds: list = [model.organization_id == organization_id]
    title, artist, writer, ident = (
        plan["title_contains"], plan["artist_contains"], plan["writer_contains"],
        plan["identifier"],
    )
    missing = set(plan["missing_fields"])

    if et == "work":
        if title:
            conds.append(_ilike(Work.title, title))
        if writer:
            conds.append(Work.id.in_(
                select(WorkContributor.work_id).where(
                    WorkContributor.organization_id == organization_id,
                    WorkContributor.party_id.in_(_party_name_ids(organization_id, writer)),
                )
            ))
        if artist:
            conds.append(Work.id.in_(
                select(RecordingWork.work_id).join(
                    Recording, Recording.id == RecordingWork.recording_id
                ).where(
                    RecordingWork.organization_id == organization_id,
                    or_(_ilike(Recording.display_artist, artist),
                        Recording.primary_artist_id.in_(_party_name_ids(organization_id, artist))),
                )
            ))
        if ident:
            norm = identifiers.normalize_iswc(ident) or ident
            conds.append(or_(
                Work.iswc.in_({ident, norm, identifiers.format_iswc(norm) or norm}),
                Work.internal_code == ident,
            ))
        if "iswc" in missing:
            conds.append(_blank(Work.iswc))
        if "language" in missing:
            conds.append(_blank(Work.language))
        if "genre" in missing:
            conds.append(_blank(Work.genre))
        if "writers" in missing:
            conds.append(~exists(select(WorkContributor.id).where(
                WorkContributor.work_id == Work.id)))
        if "shares" in missing:
            conds.append(~exists(select(OwnershipShare.id).where(
                OwnershipShare.work_id == Work.id, OwnershipShare.status == "active")))
        if "recordings" in missing:
            conds.append(~exists(select(RecordingWork.id).where(
                RecordingWork.work_id == Work.id)))
    elif et == "recording":
        if title:
            conds.append(or_(_ilike(Recording.title, title),
                             _ilike(Recording.version_title, title)))
        if artist:
            conds.append(or_(
                _ilike(Recording.display_artist, artist),
                Recording.primary_artist_id.in_(_party_name_ids(organization_id, artist)),
            ))
        if writer:
            conds.append(Recording.id.in_(
                select(RecordingWork.recording_id).join(
                    WorkContributor, WorkContributor.work_id == RecordingWork.work_id
                ).where(
                    RecordingWork.organization_id == organization_id,
                    WorkContributor.party_id.in_(_party_name_ids(organization_id, writer)),
                )
            ))
        if ident:
            conds.append(or_(
                Recording.isrc.in_({ident, identifiers.normalize_isrc(ident) or ident}),
                Recording.internal_code == ident,
            ))
        if "isrc" in missing:
            conds.append(_blank(Recording.isrc))
        if "display_artist" in missing:
            conds.append(_blank(Recording.display_artist))
        if "primary_artist" in missing:
            conds.append(Recording.primary_artist_id.is_(None))
        if "duration" in missing:
            conds.append(or_(Recording.duration_seconds.is_(None),
                             Recording.duration_seconds <= 0))
        if "work" in missing:
            conds.append(~exists(select(RecordingWork.id).where(
                RecordingWork.recording_id == Recording.id)))
    elif et == "release":
        if title:
            conds.append(_ilike(Release.title, title))
        if artist:
            conds.append(_ilike(Release.display_artist, artist))
        if ident:
            conds.append(or_(
                Release.upc.in_({ident, identifiers.normalize_upc(ident) or ident}),
                Release.catalog_number == ident,
            ))
        if "upc" in missing:
            conds.append(_blank(Release.upc))
        if "release_date" in missing:
            conds.append(Release.release_date.is_(None))
        if "label" in missing:
            conds.append(Release.label_id.is_(None))
        if "tracks" in missing:
            conds.append(~exists(select(ReleaseTrack.id).where(
                ReleaseTrack.release_id == Release.id)))
    elif et == "party":
        for term in (title, artist, writer):
            if term:
                conds.append(or_(_ilike(Party.name, term), _ilike(Party.legal_name, term)))
        if ident:
            conds.append(or_(
                Party.ipi_number.in_({ident, identifiers.normalize_ipi(ident) or ident}),
                Party.isni == (identifiers.normalize_isni(ident) or ident),
            ))
        for field in ("ipi_number", "isni", "country_code", "email"):
            if field in missing:
                conds.append(_blank(getattr(Party, field)))
    elif et == "contract":
        if title:
            conds.append(or_(_ilike(Contract.title, title), _ilike(Contract.reference, title)))
        for term in (artist, writer):
            if term:
                conds.append(Contract.id.in_(
                    select(ContractParty.contract_id).where(
                        ContractParty.organization_id == organization_id,
                        ContractParty.party_id.in_(_party_name_ids(organization_id, term)),
                    )
                ))
        if ident:
            conds.append(Contract.reference == ident)
        if "start_date" in missing:
            conds.append(Contract.start_date.is_(None))
        if "end_date" in missing:
            conds.append(Contract.end_date.is_(None))
        if "parties" in missing:
            conds.append(~exists(select(ContractParty.id).where(
                ContractParty.contract_id == Contract.id)))
        if "assets" in missing:
            conds.append(~exists(select(ContractAsset.id).where(
                ContractAsset.contract_id == Contract.id)))

    if plan["status"]:
        conds.append(model.status == plan["status"])
    if plan["created_after"]:
        conds.append(model.created_at >= datetime.fromisoformat(plan["created_after"]))
    if plan["created_before"]:
        before = date.fromisoformat(plan["created_before"])
        if before < date.max:  # date.max + 1 day would overflow (audit AF-12)
            conds.append(model.created_at < datetime.combine(before + timedelta(days=1),
                                                             datetime.min.time()))
    order = Party.name if et == "party" else model.title
    return select(model).where(*conds), order


def _search_result(entity_type: str, obj: Any) -> dict[str, Any]:
    subtitle = identifier = None
    if entity_type == "work":
        identifier = obj.iswc
        writers = [c.party.name for c in obj.contributors if c.party]
        subtitle = ", ".join(dict.fromkeys(writers)) or None
    elif entity_type == "recording":
        identifier = obj.isrc
        subtitle = obj.display_artist or (obj.primary_artist.name if obj.primary_artist else None)
    elif entity_type == "release":
        identifier = obj.upc
        subtitle = obj.display_artist
    elif entity_type == "party":
        identifier = obj.ipi_number or obj.isni
        subtitle = obj.legal_name
    elif entity_type == "contract":
        identifier = obj.reference
        subtitle = obj.contract_type
    return {
        "entity_type": entity_type,
        "id": obj.id,
        "title": entity_title(entity_type, obj),
        "subtitle": subtitle,
        "identifier": identifier,
        "status": obj.status,
        "created_at": obj.created_at,
    }


def natural_language_search(db: Session, organization_id: str, user_id: str, query: str,
                            limit: int) -> dict[str, Any]:
    instructions = (
        "Convert the user's catalog search request into a structured filter plan. Only use "
        "the fields of the output schema. Use null for any filter the request does not "
        "mention; do not invent identifiers or names that are not in the request. Dates must "
        f"be ISO YYYY-MM-DD (today is {date.today().isoformat()}).\n\n"
        f"{fence_untrusted('search_request', query)}"
    )
    plan, meta = run_structured(
        db, organization_id=organization_id, user_id=user_id, feature=FEATURE_SEARCH,
        instructions=instructions, output_model=CatalogSearchPlan, max_tokens=1500,
    )
    cleaned, ignored = validate_search_plan(plan)
    stmt, order = _search_statement(organization_id, cleaned)
    total = int(db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)
    rows = db.scalars(stmt.order_by(order).limit(limit)).unique().all()
    return {
        **_ai_meta(meta),
        "query": query,
        "interpreted_plan": cleaned,
        "ignored_filters": ignored,
        "results": [_search_result(cleaned["entity_type"], obj) for obj in rows],
        "total": total,
        "results_source": "database",
    }


# --------------------------------------------------------------------------- metadata cleanup

_LANG_RE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?$")
_FIELD_MAX = {
    "title": 255, "version_title": 255, "display_artist": 255, "name": 255,
    "legal_name": 255, "genre": 100,
}


def _jsonable(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    return value


def validate_cleanup_value(
    db: Session, organization_id: str, entity_type: str, entity_id: str, field: str, value: Any
) -> tuple[bool, Any, str | None]:
    """Validate (and normalize) one proposed field value. Returns (ok, value, reason)."""
    if field not in CLEANUP_FIELDS.get(entity_type, ()):
        return False, value, f"'{field}' cannot be changed by AI suggestions for {entity_type}"
    if field == "alternate_titles":
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            return False, value, "alternate_titles must be a list of strings"
        titles = list(dict.fromkeys(v.strip() for v in value if v and v.strip()))
        if len(titles) > 20 or any(len(t) > 255 for t in titles):
            return False, value, "Too many or too long alternate titles"
        return True, titles, None
    if not isinstance(value, str) or not value.strip():
        return False, value, "A non-empty text value is required"
    value = value.strip()
    if field in _FIELD_MAX:
        if len(value) > _FIELD_MAX[field]:
            return False, value, f"{field} is too long"
        return True, value, None
    if field == "language":
        if not _LANG_RE.match(value):
            return False, value, "language must be an ISO 639 code"
        return True, value.lower(), None
    if field == "country_code":
        code = value.upper()
        if code not in TERRITORIES:
            return False, value, "country_code must be an ISO 3166-1 alpha-2 code"
        return True, code, None

    if field == "iswc":
        if not identifiers.is_valid_iswc(value):
            return False, value, "Invalid ISWC (format or check digit)"
        normalized = identifiers.normalize_iswc(value)
        candidates = {normalized, identifiers.format_iswc(normalized)}
        column, model = Work.iswc, Work
    elif field == "isrc":
        if not identifiers.is_valid_isrc(value):
            return False, value, "Invalid ISRC"
        normalized = identifiers.normalize_isrc(value)
        candidates = {normalized}
        column, model = Recording.isrc, Recording
    elif field == "ipi_number":
        if not identifiers.is_valid_ipi(value):
            return False, value, "Invalid IPI name number"
        normalized = identifiers.normalize_ipi(value)
        candidates = {normalized, re.sub(r"\D", "", value)}
        column, model = Party.ipi_number, Party
    elif field == "isni":
        if not identifiers.is_valid_isni(value):
            return False, value, "Invalid ISNI (format or check character)"
        normalized = identifiers.normalize_isni(value)
        candidates = {normalized}
        column, model = Party.isni, Party
    else:  # pragma: no cover - guarded by CLEANUP_FIELDS
        return False, value, "Unsupported field"
    clash = db.scalar(
        select(model.id).where(
            model.organization_id == organization_id,
            model.id != entity_id,
            column.in_(candidates),
        ).limit(1)
    )
    if clash:
        return False, value, f"{field} is already used by another {entity_type} in this catalog"
    return True, normalized, None


def _same(current: Any, proposed: Any, field: str) -> bool:
    if field in ("iswc", "isrc", "isni"):
        return identifiers._compact(current) == identifiers._compact(proposed)
    if field == "ipi_number":
        return identifiers.normalize_ipi(current) == identifiers.normalize_ipi(proposed)
    return current == proposed


def propose_metadata_cleanup(db: Session, organization_id: str, user_id: str,
                             entity_type: str, entity_id: str,
                             request: Request | None = None) -> dict[str, Any]:
    entity = load_entity(db, organization_id, entity_type, entity_id)
    record = describe_entity(entity_type, entity)
    allowed = CLEANUP_FIELDS[entity_type]
    instructions = (
        f"Review this {entity_type} record and propose metadata cleanups limited to these "
        f"fields: {', '.join(allowed)}. Typical fixes: title capitalization and stray "
        "whitespace, identifier formatting (ISWC T-123.456.789-0 style, ISRC without "
        "separators), missing well-known alternate titles, and artist-name consistency with "
        "the linked parties shown in the record. Never invent identifiers that are not "
        "derivable from the record itself. Return an empty change list if the record is clean."
        f"\n\n{fence_untrusted('record', _json(record))}"
    )
    proposal, meta = run_structured(
        db, organization_id=organization_id, user_id=user_id, feature=FEATURE_METADATA,
        instructions=instructions, output_model=MetadataCleanupProposal,
    )
    label = entity_title(entity_type, entity)
    created: list[AISuggestion] = []
    discarded: list[dict[str, Any]] = []
    seen_fields: set[str] = set()
    pending_changes = [
        s.proposed_changes for s in db.scalars(
            select(AISuggestion).where(
                AISuggestion.organization_id == organization_id,
                AISuggestion.entity_type == entity_type,
                AISuggestion.entity_id == entity.id,
                AISuggestion.kind == KIND_METADATA_CLEANUP,
                AISuggestion.status == "pending",
            )
        ).all()
    ]
    for change in proposal.changes[:20]:
        field = change.field
        value: Any = change.proposed_values if field == "alternate_titles" else change.proposed_value
        if field in seen_fields:
            discarded.append({"field": field, "value": value, "reason": "Duplicate proposal"})
            continue
        ok, normalized, reason = validate_cleanup_value(
            db, organization_id, entity_type, entity.id, field, value
        )
        if not ok:
            discarded.append({"field": field, "value": value, "reason": reason})
            continue
        current = getattr(entity, field)
        if _same(current, normalized, field):
            discarded.append({"field": field, "value": value, "reason": "No change"})
            continue
        proposed_changes = {field: {"from": _jsonable(current), "to": normalized}}
        if proposed_changes in pending_changes:
            discarded.append({"field": field, "value": value,
                              "reason": "An identical suggestion is already pending"})
            continue
        seen_fields.add(field)
        suggestion = AISuggestion(
            organization_id=organization_id,
            kind=KIND_METADATA_CLEANUP,
            source="ai",
            entity_type=entity_type,
            entity_id=entity.id,
            title=f"Update {field} on {entity_type} '{label}'"[:255],
            rationale=change.reason[:5000],
            proposed_changes=proposed_changes,
            status="pending",
            created_by_id=user_id,
        )
        db.add(suggestion)
        created.append(suggestion)
    if created:
        record_audit(
            db, action="ai.suggestions_created", actor_user_id=user_id,
            organization_id=organization_id, entity_type=entity_type, entity_id=entity.id,
            summary=f"AI proposed {len(created)} metadata change(s) for review",
            request=request,
        )
    db.commit()
    for suggestion in created:
        db.refresh(suggestion)
    return {
        **_ai_meta(meta),
        "summary": proposal.summary,
        "suggestions": created,
        "discarded": discarded,
    }


def _load_suggestion(db: Session, organization_id: str, suggestion_id: str) -> AISuggestion:
    suggestion = db.scalar(
        select(AISuggestion).where(
            AISuggestion.id == suggestion_id, AISuggestion.organization_id == organization_id
        )
    )
    if suggestion is None:
        raise NotFoundError("Suggestion not found")
    if suggestion.status != "pending":
        raise ConflictError(f"Suggestion is already {suggestion.status}")
    return suggestion


def approve_suggestion(db: Session, organization_id: str, user_id: str, suggestion_id: str,
                       request: Request | None = None) -> dict[str, Any]:
    """Apply a pending suggestion. Only whitelisted fields whose values pass
    re-validation (and whose current value has not changed since the
    suggestion was made) are written."""
    suggestion = _load_suggestion(db, organization_id, suggestion_id)
    if suggestion.kind != KIND_METADATA_CLEANUP or suggestion.entity_type not in CLEANUP_FIELDS:
        raise ConflictError(
            "This suggestion type cannot be applied automatically; review it in its module",
            code="suggestion_not_applicable",
        )
    try:
        entity = load_entity(db, organization_id, suggestion.entity_type, suggestion.entity_id)
    except NotFoundError:
        raise ConflictError("The record this suggestion refers to no longer exists",
                            code="suggestion_target_missing") from None

    applied: dict[str, Any] = {}
    skipped: list[dict[str, Any]] = []
    changes = suggestion.proposed_changes if isinstance(suggestion.proposed_changes, dict) else {}
    for field, change in changes.items():
        if not isinstance(change, dict) or "to" not in change:
            skipped.append({"field": str(field), "reason": "Malformed change"})
            continue
        ok, value, reason = validate_cleanup_value(
            db, organization_id, suggestion.entity_type, entity.id, str(field), change["to"]
        )
        if not ok:
            skipped.append({"field": str(field), "value": change["to"], "reason": reason})
            continue
        current = _jsonable(getattr(entity, field))
        if "from" in change and current != change["from"]:
            skipped.append({"field": field, "value": change["to"],
                            "reason": "The value changed after the suggestion was created"})
            continue
        applied[field] = {"from": current, "to": value}
    if not applied:
        raise ValidationFailedError(
            "None of the proposed changes can be applied", details={"skipped": skipped}
        )
    before = {f: _jsonable(getattr(entity, f)) for f in applied}
    for field, change in applied.items():
        setattr(entity, field, change["to"])
    after = {f: _jsonable(getattr(entity, f)) for f in applied}
    suggestion.status = "applied"
    suggestion.reviewed_by_id = user_id
    suggestion.reviewed_at = utc_now()
    record_audit(
        db, action=f"{suggestion.entity_type}.updated", actor_user_id=user_id,
        organization_id=organization_id, entity_type=suggestion.entity_type,
        entity_id=entity.id, changes=diff(before, after),
        summary=f"Applied AI suggestion {suggestion.id}", request=request,
    )
    record_audit(
        db, action="ai.suggestion_approved", actor_user_id=user_id,
        organization_id=organization_id, entity_type="ai_suggestion", entity_id=suggestion.id,
        changes=applied,
        summary=f"Approved: {suggestion.title}"
        + (f" ({len(skipped)} change(s) skipped)" if skipped else ""),
        request=request,
    )
    db.commit()
    db.refresh(suggestion)
    return {"suggestion": suggestion, "applied_changes": applied, "skipped": skipped}


def reject_suggestion(db: Session, organization_id: str, user_id: str, suggestion_id: str,
                      reason: str | None, request: Request | None = None) -> AISuggestion:
    suggestion = _load_suggestion(db, organization_id, suggestion_id)
    suggestion.status = "rejected"
    suggestion.reviewed_by_id = user_id
    suggestion.reviewed_at = utc_now()
    record_audit(
        db, action="ai.suggestion_rejected", actor_user_id=user_id,
        organization_id=organization_id, entity_type="ai_suggestion", entity_id=suggestion.id,
        summary=f"Rejected: {suggestion.title}" + (f" - {reason}" if reason else ""),
        request=request,
    )
    db.commit()
    db.refresh(suggestion)
    return suggestion


# --------------------------------------------------------------------------- duplicates


def list_duplicate_candidates(db: Session, organization_id: str, entity_type: str,
                              limit: int) -> list[dict[str, Any]]:
    try:
        from app.services.catalog import find_duplicate_candidates
    except ImportError:
        raise ServiceUnavailableError(
            "Duplicate detection is not available on this server", code="duplicates_unavailable"
        ) from None
    candidates = find_duplicate_candidates(db, organization_id, entity_type, limit=limit)
    return [
        {
            "entity_type": c.get("entity_type", entity_type),
            "ids": list(c.get("ids") or []),
            "titles": list(c.get("titles") or []),
            "score": float(c.get("score") or 0),
            "reasons": [str(r) for r in c.get("reasons") or []],
        }
        for c in candidates
    ]


def explain_duplicate(db: Session, organization_id: str, user_id: str, entity_type: str,
                      ids: list[str]) -> dict[str, Any]:
    first = load_entity(db, organization_id, entity_type, ids[0])
    second = load_entity(db, organization_id, entity_type, ids[1])
    records = [describe_entity(entity_type, first), describe_entity(entity_type, second)]
    instructions = (
        f"Compare these two {entity_type} records from the same catalog and decide whether "
        "they are likely duplicates of each other. Weigh identifiers (identical identifiers "
        "are strong evidence; different valid identifiers are strong counter-evidence), "
        "titles, versions (live, remix, acoustic, edit), artists and contributors. Recommend "
        "what a human administrator should do; records are never merged automatically."
        f"\n\n{fence_untrusted('record_a', _json(records[0]))}"
        f"\n\n{fence_untrusted('record_b', _json(records[1]))}"
    )
    result, meta = run_structured(
        db, organization_id=organization_id, user_id=user_id, feature=FEATURE_DUPLICATE,
        instructions=instructions, output_model=DuplicateAssessment, max_tokens=2000,
    )
    return {
        **_ai_meta(meta),
        "records": [
            {"entity_type": entity_type, "id": obj.id, "title": entity_title(entity_type, obj)}
            for obj in (first, second)
        ],
        "likely_duplicate": result.likely_duplicate,
        "confidence": result.confidence,
        "explanation": result.explanation,
        "recommended_action": result.recommended_action,
        "automatic_merge": False,
    }


# --------------------------------------------------------------------------- conflicts


def explain_conflict(db: Session, organization_id: str, user_id: str,
                     conflict_id: str) -> dict[str, Any]:
    conflict = db.scalar(
        select(RightsConflict).where(
            RightsConflict.id == conflict_id, RightsConflict.organization_id == organization_id
        )
    )
    if conflict is None:
        raise NotFoundError("Conflict not found")
    asset: dict[str, Any] | None = None
    share_filter = []
    if conflict.work_id:
        work = db.scalar(select(Work).where(Work.id == conflict.work_id,
                                            Work.organization_id == organization_id))
        if work is not None:
            asset = describe_entity("work", work)
        share_filter.append(OwnershipShare.work_id == conflict.work_id)
    if conflict.recording_id:
        rec = db.scalar(select(Recording).where(Recording.id == conflict.recording_id,
                                                Recording.organization_id == organization_id))
        if rec is not None:
            asset = describe_entity("recording", rec)
        share_filter.append(OwnershipShare.recording_id == conflict.recording_id)
    shares: list[OwnershipShare] = []
    if share_filter:
        stmt = select(OwnershipShare).where(
            OwnershipShare.organization_id == organization_id,
            or_(*share_filter),
            OwnershipShare.status.in_(("active", "disputed")),
        )
        if conflict.rights_type:
            stmt = stmt.where(OwnershipShare.rights_type == conflict.rights_type)
        shares = list(db.scalars(stmt.order_by(OwnershipShare.rights_type)).unique().all()[:200])
    share_data = [
        {
            "share_id": s.id, "party_id": s.party_id,
            "party_name": s.party.name if s.party else None, "role": s.role,
            "rights_type": s.rights_type, "share_percent": s.share_percent,
            "territories": s.territories, "excluded_territories": s.excluded_territories,
            "effective_from": s.effective_from, "effective_to": s.effective_to,
            "is_controlled": s.is_controlled, "status": s.status,
            "verification_status": s.verification_status, "contract_id": s.contract_id,
        }
        for s in shares
    ]
    party_names: dict[str, str | None] = {s.party_id: (s.party.name if s.party else None)
                                          for s in shares}
    for key in ("writers", "contributors"):
        for person in (asset or {}).get(key) or []:
            party_names.setdefault(person["party_id"], person.get("name"))
    if asset and asset.get("primary_artist"):
        party_names.setdefault(asset["primary_artist"]["party_id"],
                               asset["primary_artist"].get("name"))
    conflict_data = {
        "conflict_id": conflict.id, "conflict_type": conflict.conflict_type,
        "severity": conflict.severity, "status": conflict.status,
        "rights_type": conflict.rights_type, "title": conflict.title,
        "system_explanation": conflict.explanation, "details": conflict.details,
        "last_detected_at": conflict.last_detected_at,
    }
    instructions = (
        "Explain this rights ownership conflict to a music rights administrator in plain "
        "language and suggest concrete next steps a human should take (e.g. check the split "
        "sheet or contract, contact a party, correct a share). Use only the data provided; "
        "percentages and dates must come from it. In parties_involved, only use party_id "
        "values that appear in the data. Do not claim the conflict is resolved."
        f"\n\n{fence_untrusted('conflict', _json(conflict_data))}"
        f"\n\n{fence_untrusted('asset', _json(asset))}"
        f"\n\n{fence_untrusted('ownership_shares', _json(share_data))}"
    )
    result, meta = run_structured(
        db, organization_id=organization_id, user_id=user_id, feature=FEATURE_CONFLICT,
        instructions=instructions, output_model=ConflictExplanation,
    )
    parties = []
    seen: set[str] = set()
    for item in result.parties_involved:
        if item.party_id in party_names and item.party_id not in seen:
            seen.add(item.party_id)
            parties.append({"party_id": item.party_id, "name": party_names[item.party_id],
                            "note": item.note})
    return {
        **_ai_meta(meta),
        "conflict_id": conflict.id,
        "conflict_status": conflict.status,
        "summary": result.summary,
        "likely_causes": result.likely_causes,
        "suggested_next_steps": result.suggested_next_steps,
        "parties_involved": parties,
    }


# --------------------------------------------------------------------------- anomalies


def summarize_anomalies(db: Session, organization_id: str, user_id: str,
                        statement_id: str | None, months: int) -> dict[str, Any]:
    report = detect_anomalies(db, organization_id, statement_id=statement_id, months=months)
    anomalies = report["anomalies"]
    if not anomalies:
        return {
            "ai_generated": False, "advisory_notice": None, "anomaly_count": 0,
            "overview": None, "key_findings": [], "recommended_checks": [],
            "message": "No anomalies were detected, so there is nothing to summarize.",
        }
    payload = {
        "statement_id": report["statement_id"],
        "months": months,
        "counts_by_type": report["counts_by_type"],
        "anomalies": anomalies[:100],
        "anomalies_omitted": max(0, len(anomalies) - 100),
    }
    instructions = (
        "Summarize these royalty anomalies, which were detected by deterministic rules, for a "
        "royalty manager. Prioritize by financial impact and severity, describe likely causes "
        "cautiously, and recommend checks. Do not introduce figures that are not in the data."
        f"\n\n{fence_untrusted('detected_anomalies', _json(payload))}"
    )
    result, meta = run_structured(
        db, organization_id=organization_id, user_id=user_id, feature=FEATURE_ANOMALY,
        instructions=instructions, output_model=AnomalySummary,
    )
    return {
        **_ai_meta(meta),
        "anomaly_count": len(anomalies),
        "overview": result.overview,
        "key_findings": result.key_findings,
        "recommended_checks": result.recommended_checks,
        "message": None,
    }


# --------------------------------------------------------------------------- statement classify


def classify_statement(db: Session, organization_id: str, user_id: str, headers: list[str],
                       sample_rows: list[list[Any]], filename: str | None) -> dict[str, Any]:
    sample = {"headers": headers, "rows": sample_rows[:20]}
    instructions = (
        "Classify this royalty statement export. Choose the income source category, guess "
        "the reporting source if evident, and map canonical fields "
        f"({', '.join(CANONICAL_FIELDS)}) to the exact header strings provided. Only use "
        "headers from the provided header list; leave a canonical field unmapped when no "
        "header fits."
        + (f"\n\n{fence_untrusted('filename', filename)}" if filename else "")
        + f"\n\n{fence_untrusted('statement_sample', _json(sample))}"
    )
    result, meta = run_structured(
        db, organization_id=organization_id, user_id=user_id, feature=FEATURE_CLASSIFY,
        instructions=instructions, output_model=StatementClassification, max_tokens=3000,
    )
    exact = set(headers)
    by_lower = {h.strip().lower(): h for h in headers}
    mapping: dict[str, str] = {}
    dropped: list[dict[str, str]] = []
    for entry in result.column_mapping:
        header = entry.header if entry.header in exact else by_lower.get(entry.header.strip().lower())
        if header is None:
            dropped.append({"canonical_field": entry.canonical_field, "header": entry.header[:200],
                            "reason": "Header not in the provided list"})
            continue
        if entry.canonical_field in mapping:
            dropped.append({"canonical_field": entry.canonical_field, "header": header,
                            "reason": "Canonical field already mapped"})
            continue
        mapping[entry.canonical_field] = header
    used = set(mapping.values())
    return {
        **_ai_meta(meta),
        "source_category": result.source_category,
        "source_name_guess": result.source_name_guess,
        "column_mapping": mapping,
        "dropped_mappings": dropped,
        "unmapped_headers": [h for h in headers if h not in used],
        "confidence": result.confidence,
        "notes": result.notes,
    }


# --------------------------------------------------------------------------- completeness


def _completeness_specs() -> list[tuple[str, Any, Any, list[tuple[str, Any]]]]:
    return [
        ("work", Work, Work.title, [
            ("iswc", _present(Work.iswc)),
            ("writers", exists(select(WorkContributor.id).where(
                WorkContributor.work_id == Work.id))),
            ("shares", exists(select(OwnershipShare.id).where(
                OwnershipShare.work_id == Work.id, OwnershipShare.status == "active"))),
        ]),
        ("recording", Recording, Recording.title, [
            ("isrc", _present(Recording.isrc)),
            ("linked_work", exists(select(RecordingWork.id).where(
                RecordingWork.recording_id == Recording.id))),
            ("primary_artist", or_(Recording.primary_artist_id.is_not(None),
                                   _present(Recording.display_artist))),
            ("duration", and_(Recording.duration_seconds.is_not(None),
                              Recording.duration_seconds > 0)),
        ]),
        ("release", Release, Release.title, [
            ("upc", _present(Release.upc)),
            ("tracks", exists(select(ReleaseTrack.id).where(
                ReleaseTrack.release_id == Release.id))),
            ("release_date", Release.release_date.is_not(None)),
        ]),
    ]


def _catalog_completeness(db: Session, organization_id: str, scorer: Any, sample_size: int,
                          batch: int = 500) -> dict[str, Any]:
    """Aggregate the catalog module's per-record ``completeness_score``."""
    entities = []
    grand_score = grand_total = 0
    for entity_type, model in (("work", Work), ("recording", Recording), ("release", Release)):
        total = complete = score_sum = 0
        missing_counts: dict[str, int] = {}
        keys: list[str] = []
        worst: list[tuple[int, str, str, list[str]]] = []
        last_id = ""
        while True:
            rows = db.scalars(
                select(model).where(
                    model.organization_id == organization_id, model.status != "archived",
                    model.id > last_id,
                ).order_by(model.id).limit(batch)
            ).unique().all()
            if not rows:
                break
            for obj in rows:
                result = scorer(obj)
                score, missing = int(result["score"]), list(result["missing"])
                total += 1
                score_sum += score
                complete += 1 if not missing else 0
                for key in missing:
                    missing_counts[key] = missing_counts.get(key, 0) + 1
                    if key not in keys:
                        keys.append(key)
                if missing and sample_size:
                    worst.append((score, obj.title, obj.id, missing))
            worst.sort(key=lambda w: (w[0], w[1]))
            worst = worst[:sample_size]
            # The identity map is weak-referencing, so processed rows are released.
            last_id = rows[-1].id
        weight_keys = {"work": "WORK_WEIGHTS", "recording": "RECORDING_WEIGHTS",
                       "release": "RELEASE_WEIGHTS"}[entity_type]
        try:
            from app.services import catalog as catalog_service
            keys = list(getattr(catalog_service, weight_keys).keys())
        except (ImportError, AttributeError):
            pass
        grand_score += score_sum
        grand_total += total
        entities.append({
            "entity_type": entity_type,
            "total": total,
            "complete": complete,
            "score_percent": format(
                (Decimal(score_sum) / Decimal(total)).quantize(Decimal("0.1")) if total
                else Decimal("0.0"), "f"),
            "checks": [
                {"check": key, "present": total - missing_counts.get(key, 0),
                 "missing": missing_counts.get(key, 0)}
                for key in keys
            ],
            "incomplete_sample": [
                {"id": oid, "title": title, "missing": missing}
                for _, title, oid, missing in worst
            ],
        })
    return {
        "overall_score_percent": format(
            (Decimal(grand_score) / Decimal(grand_total)).quantize(Decimal("0.1"))
            if grand_total else Decimal("0.0"), "f"),
        "entities": entities,
        "source": "catalog_completeness_score",
    }


def compute_completeness(db: Session, organization_id: str, sample_size: int = 20
                         ) -> dict[str, Any]:
    try:
        from app.services.catalog import completeness_score
    except ImportError:
        completeness_score = None
    if completeness_score is not None:
        return _catalog_completeness(db, organization_id, completeness_score, sample_size)
    return _sql_completeness(db, organization_id, sample_size)


def _sql_completeness(db: Session, organization_id: str, sample_size: int) -> dict[str, Any]:
    entities = []
    total_checks = total_present = 0
    for entity_type, model, title_col, checks in _completeness_specs():
        base = [model.organization_id == organization_id, model.status != "archived"]
        all_present = and_(*[expr for _, expr in checks])
        row = db.execute(
            select(
                func.count(model.id),
                func.coalesce(func.sum(case((all_present, 1), else_=0)), 0),
                *[func.coalesce(func.sum(case((expr, 1), else_=0)), 0) for _, expr in checks],
            ).where(*base)
        ).one()
        total, complete = int(row[0] or 0), int(row[1] or 0)
        present_counts = [int(v or 0) for v in row[2:]]
        sample_rows = db.execute(
            select(model.id, title_col, *[expr.label(f"c_{name}") for name, expr in checks])
            .where(*base, ~all_present)
            .order_by(title_col)
            .limit(sample_size)
        ).all()
        sample = [
            {
                "id": r[0],
                "title": r[1],
                "missing": [name for (name, _), ok in zip(checks, r[2:]) if not ok],
            }
            for r in sample_rows
        ]
        total_checks += total * len(checks)
        total_present += sum(present_counts)
        entities.append({
            "entity_type": entity_type,
            "total": total,
            "complete": complete,
            "score_percent": _pct(sum(present_counts), total * len(checks)),
            "checks": [
                {"check": name, "present": present, "missing": total - present}
                for (name, _), present in zip(checks, present_counts)
            ],
            "incomplete_sample": sample,
        })
    return {
        "overall_score_percent": _pct(total_present, total_checks),
        "entities": entities,
        "source": "rightsflow_ai_rules",
    }


# --------------------------------------------------------------------------- reports


def _statement_scope(organization_id: str, period_start: date | None,
                     period_end: date | None) -> list:
    conds = [
        StatementLine.organization_id == organization_id,
        RoyaltyStatement.organization_id == organization_id,
        RoyaltyStatement.status.in_(FINAL_STATEMENT_STATUSES),
        StatementLine.amount.is_not(None),
        StatementLine.match_status != "ignored",
        StatementLine.is_valid.is_(True),
    ]
    if period_start:
        conds.append(RoyaltyStatement.period_end >= period_start)
    if period_end:
        conds.append(RoyaltyStatement.period_start <= period_end)
    return conds


def _currency_totals(figures: list[dict[str, Any]]) -> dict[str, Any]:
    totals: dict[str, Decimal] = {}
    lines = 0
    for f in figures:
        totals[f["currency"]] = totals.get(f["currency"], Decimal("0")) + Decimal(f["amount"])
        lines += f["line_count"]
    return {
        "amount_by_currency": {k: format(v, "f") for k, v in sorted(totals.items())},
        "line_count": lines,
    }


def compute_report_figures(db: Session, organization_id: str, report_type: str,
                           period_start: date | None, period_end: date | None
                           ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    currency = func.coalesce(StatementLine.currency, RoyaltyStatement.currency)
    if report_type == "royalties_by_source":
        rows = db.execute(
            select(
                RoyaltyStatement.source_name, RoyaltyStatement.source_category,
                currency.label("currency"), func.sum(StatementLine.amount),
                func.count(StatementLine.id), func.count(distinct(RoyaltyStatement.id)),
            )
            .join(RoyaltyStatement, RoyaltyStatement.id == StatementLine.statement_id)
            .where(*_statement_scope(organization_id, period_start, period_end))
            .group_by(RoyaltyStatement.source_name, RoyaltyStatement.source_category, currency)
            .order_by(func.sum(StatementLine.amount).desc())
            .limit(100)
        ).all()
        figures = [
            {"source_name": name, "source_category": cat, "currency": cur,
             "amount": format(_dec(amount), "f"), "line_count": int(n),
             "statement_count": int(stmts)}
            for name, cat, cur, amount, n, stmts in rows
        ]
        return figures, (_currency_totals(figures) if figures else {})
    if report_type == "royalties_by_territory":
        territory = func.coalesce(StatementLine.territory, "UNKNOWN")
        rows = db.execute(
            select(territory.label("territory"), currency.label("currency"),
                   func.sum(StatementLine.amount), func.count(StatementLine.id))
            .join(RoyaltyStatement, RoyaltyStatement.id == StatementLine.statement_id)
            .where(*_statement_scope(organization_id, period_start, period_end))
            .group_by(territory, currency)
            .order_by(func.sum(StatementLine.amount).desc())
            .limit(100)
        ).all()
        figures = [
            {"territory": terr, "currency": cur, "amount": format(_dec(amount), "f"),
             "line_count": int(n)}
            for terr, cur, amount, n in rows
        ]
        return figures, (_currency_totals(figures) if figures else {})
    if report_type == "catalog_health":
        completeness = compute_completeness(db, organization_id, sample_size=0)
        if not any(e["total"] for e in completeness["entities"]):
            return [], {}
        figures = [
            {"entity_type": e["entity_type"], "total": e["total"], "complete": e["complete"],
             "score_percent": e["score_percent"],
             "missing": {c["check"]: c["missing"] for c in e["checks"]}}
            for e in completeness["entities"]
        ]
        open_conflicts = int(db.scalar(
            select(func.count(RightsConflict.id)).where(
                RightsConflict.organization_id == organization_id,
                RightsConflict.status.in_(("open", "acknowledged")),
            )
        ) or 0)
        return figures, {"overall_score_percent": completeness["overall_score_percent"],
                         "unresolved_conflicts": open_conflicts}
    if report_type == "conflicts":
        conds = [RightsConflict.organization_id == organization_id]
        if period_start:
            conds.append(RightsConflict.created_at >= datetime.combine(period_start,
                                                                       datetime.min.time()))
        if period_end and period_end < date.max:
            conds.append(RightsConflict.created_at < datetime.combine(
                period_end + timedelta(days=1), datetime.min.time()))
        rows = db.execute(
            select(RightsConflict.conflict_type, RightsConflict.severity, RightsConflict.status,
                   func.count(RightsConflict.id))
            .where(*conds)
            .group_by(RightsConflict.conflict_type, RightsConflict.severity,
                      RightsConflict.status)
            .order_by(func.count(RightsConflict.id).desc())
        ).all()
        figures = [
            {"conflict_type": ct, "severity": sev, "status": st, "count": int(n)}
            for ct, sev, st, n in rows
        ]
        by_status: dict[str, int] = {}
        for f in figures:
            by_status[f["status"]] = by_status.get(f["status"], 0) + f["count"]
        return figures, ({"total": sum(by_status.values()), "by_status": by_status}
                         if figures else {})
    raise ValidationFailedError("Unknown report type")


def report_summary(db: Session, organization_id: str, user_id: str, report_type: str,
                   period_start: date | None, period_end: date | None) -> dict[str, Any]:
    figures, totals = compute_report_figures(db, organization_id, report_type,
                                             period_start, period_end)
    base = {
        "report_type": report_type,
        "period_start": period_start,
        "period_end": period_end,
        "figures": figures,
        "totals": totals,
    }
    if not figures:
        return {
            **base, "narrative": None, "ai_generated": False, "advisory_notice": None,
            "message": "No data is available for this report and period, so no narrative "
                       "was generated.",
        }
    if not ai_is_configured():
        # The figures come from the database and stay useful without AI.
        return {
            **base, "narrative": None, "ai_generated": False, "advisory_notice": None,
            "message": "AI provider not configured; showing database figures without a narrative.",
        }
    payload = {
        "report_type": report_type,
        "period_start": period_start,
        "period_end": period_end,
        "totals": totals,
        "figures": figures,
        "notes": "Amounts are grouped by currency and must never be added across currencies.",
    }
    instructions = (
        "Write a concise executive narrative for this report. Use only the figures provided "
        "(computed by the system from the organization's database); do not compute new "
        "totals across currencies or invent numbers. Mention data limitations as caveats."
        f"\n\n{fence_untrusted('report_figures', _json(payload))}"
    )
    narrative, meta = run_structured(
        db, organization_id=organization_id, user_id=user_id, feature=FEATURE_REPORT,
        instructions=instructions, output_model=ReportNarrative,
    )
    return {**base, **_ai_meta(meta), "narrative": narrative, "message": None}
