"""Catalog CSV/XLSX import (background job ``catalog_import``) and CSV export.

Import files
============
CSV (UTF-8, UTF-8 with BOM or Windows-1252; comma, semicolon or tab
delimited) or XLSX (first worksheet). The first non-empty row holds the
column headers. Headers are matched case-insensitively and ignore
punctuation/spacing, so ``ISRC``, ``isrc`` and ``I.S.R.C`` are equivalent.
Unknown columns are ignored and reported. Multi-value cells use ``;``.

Works (``entity_type=work``)
    title*           title, work title, song title, composition title, name
    iswc             iswc, iswc code
    internal_code    internal code, code, work code, work id, catalog code
    alternate_titles alternate titles, alternative titles, aka, alt titles
    writers          writers, writer, songwriters, songwriter
                     (contributor role composer_lyricist)
    composers        composers, composer
    lyricists        lyricists, lyricist, authors, author
    publishers       publishers, publisher (role original_publisher)
    language         language, lang
    genre            genre
    creation_year    creation year, year, written year
    status           status (active | draft)
    verification_status  verification status, verification
    notes            notes, comments

Recordings (``entity_type=recording``)
    title*           title, track title, recording title, song title, name
    version_title    version title, version, mix, mix title
    isrc             isrc, isrc code
    internal_code    internal code, code, recording code, recording id
    artists          artists, artist, main artist(s), primary artist
                     (first name becomes the primary artist; all are main_artist)
    featured_artists featured artists, featured artist, featuring, feat
    producers        producers, producer
    display_artist   display artist, artist display name
    duration         duration, duration seconds, length, time
                     (seconds, ``m:ss`` or ``h:mm:ss``)
    recording_date   recording date, recorded, date (YYYY-MM-DD)
    p_line           p line, pline, phonographic copyright
    is_explicit      explicit, is explicit, parental advisory (yes/no, true/false, 1/0)
    work_iswcs       work iswc(s), iswc, linked iswc (works in this catalog)
    status           status (active | draft)
    verification_status  verification status, verification
    notes            notes, comments

Parties (``entity_type=party``)
    name*            name, party name, full name, artist name, writer name
    party_type       party type, type (person | company)
    roles            roles, role (artist, songwriter, composer, lyricist,
                     producer, publisher, label, performer, engineer,
                     administrator, other)
    legal_name       legal name
    email            email, e-mail, email address
    country_code     country code, country
    ipi_number       ipi, ipi number, ipi name number, cae ipi, cae
    isni             isni
    pro_affiliation  pro, pro affiliation, society, performing rights organization
    status           status (active | draft)
    notes            notes, comments

Matching existing rows: works by ISWC then internal code; recordings by
ISRC then internal code; parties by IPI, then ISNI, then exact name. Matched
rows are updated with the non-empty values in the file (contributors and
work links are added, never removed); rows that change nothing count as
``skipped``. Names in ``writers``/``artists``/... columns are matched to
parties by exact name, and created when missing. New works/recordings respect
the plan's ``max_catalog_items`` limit. ``dry_run`` validates and reports the
same counts without saving anything.
"""

import csv
import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import AppError, NotFoundError, ValidationFailedError
from app.core.permissions import OrgContext
from app.db.mixins import utc_now
from app.models.catalog import (
    Party,
    Recording,
    RecordingContributor,
    RecordingWork,
    Work,
    WorkContributor,
)
from app.models.platform import BackgroundJob
from app.schemas.catalog import PartyCreate, RecordingCreate, WorkCreate
from app.services import billing, identifiers, jobs, storage
from app.services import catalog as svc
from app.services.audit import record_audit
from app.services.notifications import notify_user

IMPORT_JOB_TYPE = "catalog_import"
IMPORT_ENTITY_TYPES = ("work", "recording", "party")
EXPORT_ENTITY_TYPES = ("work", "recording", "release", "party")
MAX_IMPORT_ROWS = 20000
MAX_REPORTED_ERRORS = 500


def _norm_header(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()


_ALIASES: dict[str, dict[str, list[str]]] = {
    "work": {
        "title": ["title", "work title", "song title", "composition title", "name"],
        "iswc": ["iswc", "iswc code"],
        "internal_code": ["internal code", "code", "work code", "work id", "catalog code"],
        "alternate_titles": ["alternate titles", "alternative titles", "aka", "alt titles",
                             "alternate title"],
        "writers": ["writers", "writer", "songwriters", "songwriter"],
        "composers": ["composers", "composer"],
        "lyricists": ["lyricists", "lyricist", "authors", "author"],
        "publishers": ["publishers", "publisher"],
        "language": ["language", "lang"],
        "genre": ["genre"],
        "creation_year": ["creation year", "year", "written year"],
        "status": ["status"],
        "verification_status": ["verification status", "verification"],
        "notes": ["notes", "comments"],
    },
    "recording": {
        "title": ["title", "track title", "recording title", "song title", "name"],
        "version_title": ["version title", "version", "mix", "mix title"],
        "isrc": ["isrc", "isrc code"],
        "internal_code": ["internal code", "code", "recording code", "recording id"],
        "artists": ["artists", "artist", "main artist", "main artists", "primary artist"],
        "featured_artists": ["featured artists", "featured artist", "featuring", "feat"],
        "producers": ["producers", "producer"],
        "display_artist": ["display artist", "artist display name"],
        "duration": ["duration", "duration seconds", "length", "time"],
        "recording_date": ["recording date", "recorded", "date"],
        "p_line": ["p line", "pline", "phonographic copyright"],
        "is_explicit": ["explicit", "is explicit", "parental advisory"],
        "work_iswcs": ["work iswc", "work iswcs", "iswc", "linked iswc"],
        "status": ["status"],
        "verification_status": ["verification status", "verification"],
        "notes": ["notes", "comments"],
    },
    "party": {
        "name": ["name", "party name", "full name", "artist name", "writer name"],
        "party_type": ["party type", "type"],
        "roles": ["roles", "role"],
        "legal_name": ["legal name"],
        "email": ["email", "e mail", "email address"],
        "country_code": ["country code", "country"],
        "ipi_number": ["ipi", "ipi number", "ipi name number", "cae ipi", "cae"],
        "isni": ["isni"],
        "pro_affiliation": ["pro", "pro affiliation", "society",
                            "performing rights organization"],
        "status": ["status"],
        "notes": ["notes", "comments"],
    },
}
HEADER_ALIASES: dict[str, dict[str, str]] = {
    entity: {_norm_header(alias): canonical for canonical, aliases in spec.items()
             for alias in aliases}
    for entity, spec in _ALIASES.items()
}
REQUIRED_COLUMNS = {"work": "title", "recording": "title", "party": "name"}

TEMPLATES: dict[str, list[list[str]]] = {
    "work": [
        ["title", "iswc", "internal_code", "alternate_titles", "writers", "composers",
         "lyricists", "publishers", "language", "genre", "creation_year", "status",
         "verification_status", "notes"],
        ["Midnight River", "T-034.524.680-1", "WK-0001", "Midnight River (Acoustic)",
         "Jane Writer; John Cowriter", "", "", "Example Publishing", "en", "Pop", "2021",
         "active", "unverified", ""],
    ],
    "recording": [
        ["title", "version_title", "isrc", "internal_code", "artists", "featured_artists",
         "producers", "display_artist", "duration", "recording_date", "p_line",
         "is_explicit", "work_iswcs", "status", "verification_status", "notes"],
        ["Midnight River", "Radio Edit", "US-RC1-76-07839", "REC-0001", "The Example Band",
         "Guest Singer", "Pat Producer", "The Example Band feat. Guest Singer", "3:45",
         "2021-05-01", "2021 Example Records", "no", "T-034.524.680-1", "active",
         "unverified", ""],
    ],
    "party": [
        ["name", "party_type", "roles", "legal_name", "email", "country_code", "ipi_number",
         "isni", "pro_affiliation", "status", "notes"],
        ["Jane Writer", "person", "songwriter; composer", "Jane A. Writer",
         "jane@example.com", "US", "00052210040", "0000000121032683", "ASCAP", "active", ""],
    ],
}


def canonical_import_type(value: str) -> str:
    return svc.canonical_entity_type(value, IMPORT_ENTITY_TYPES)


def template_csv(entity_type: str) -> str:
    entity_type = canonical_import_type(entity_type)
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    writer.writerows(TEMPLATES[entity_type])
    return buffer.getvalue()


# --------------------------------------------------------------------------- export

_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def csv_safe(value: Any) -> str:
    """Render a cell for CSV, neutralizing spreadsheet formula injection by
    prefixing cells that start with ``= + - @`` (or tab/CR) with ``'``."""
    if value is None:
        return ""
    if isinstance(value, bool):
        text = "yes" if value else "no"
    elif isinstance(value, (datetime, date)):
        text = value.isoformat()
    else:
        text = str(value)
    if text.startswith(_FORMULA_PREFIXES):
        return "'" + text
    return text


def _names(contributors: list, roles: set[str] | frozenset[str]) -> str:
    return "; ".join(sorted({c.party.name for c in contributors
                             if c.role in roles and c.party is not None}, key=str.casefold))


def export_rows(db: Session, organization_id: str, entity_type: str,
                include_archived: bool = False) -> list[list[Any]]:
    entity_type = svc.canonical_entity_type(entity_type, EXPORT_ENTITY_TYPES)
    model = svc.ENTITY_MODELS[entity_type]
    stmt = select(model).where(model.organization_id == organization_id)
    if not include_archived:
        stmt = stmt.where(model.status != "archived")
    order = model.name if model is Party else model.title
    rows = db.scalars(stmt.order_by(order, model.id)).unique().all()

    if entity_type == "work":
        out: list[list[Any]] = [[
            "id", "title", "iswc", "internal_code", "alternate_titles", "writers",
            "publishers", "language", "genre", "creation_year", "status",
            "verification_status", "completeness", "notes"]]
        for w in rows:
            out.append([
                w.id, w.title, identifiers.format_iswc(w.iswc) if w.iswc else "",
                w.internal_code, "; ".join(w.alternate_titles or []),
                _names(w.contributors, svc.WRITER_ROLES),
                _names(w.contributors, svc.PUBLISHER_ROLES),
                w.language, w.genre, w.creation_year, w.status, w.verification_status,
                svc.completeness_score(w)["score"], w.notes,
            ])
    elif entity_type == "recording":
        out = [[
            "id", "title", "version_title", "isrc", "internal_code", "artist",
            "primary_artist", "featured_artists", "work_titles", "work_iswcs",
            "duration_seconds", "recording_date", "p_line", "is_explicit", "status",
            "verification_status", "completeness", "notes"]]
        for r in rows:
            works = sorted((link.work for link in r.work_links if link.work is not None),
                           key=lambda w: (w.title.casefold(), w.id))
            out.append([
                r.id, r.title, r.version_title, r.isrc, r.internal_code,
                svc._recording_artist(r), r.primary_artist.name if r.primary_artist else "",
                _names(r.contributors, {"featured_artist"}),
                "; ".join(w.title for w in works),
                "; ".join(identifiers.format_iswc(w.iswc) or "" for w in works if w.iswc),
                r.duration_seconds, r.recording_date, r.p_line, r.is_explicit, r.status,
                r.verification_status, svc.completeness_score(r)["score"], r.notes,
            ])
    elif entity_type == "release":
        out = [[
            "id", "title", "release_type", "upc", "catalog_number", "label",
            "display_artist", "release_date", "c_line", "track_count", "isrcs", "status",
            "completeness", "notes"]]
        for rel in rows:
            out.append([
                rel.id, rel.title, rel.release_type, rel.upc, rel.catalog_number,
                rel.label.name if rel.label else "", rel.display_artist, rel.release_date,
                rel.c_line, len(rel.tracks),
                "; ".join(t.recording.isrc for t in rel.tracks
                          if t.recording is not None and t.recording.isrc),
                rel.status, svc.completeness_score(rel)["score"], rel.notes,
            ])
    else:
        out = [[
            "id", "name", "party_type", "roles", "legal_name", "email", "country_code",
            "ipi_number", "isni", "pro_affiliation", "is_internal", "status", "notes"]]
        for p in rows:
            out.append([
                p.id, p.name, p.party_type, "; ".join(p.roles or []), p.legal_name, p.email,
                p.country_code, p.ipi_number, p.isni, p.pro_affiliation, p.is_internal,
                p.status, p.notes,
            ])
    return out


def export_csv(db: Session, organization_id: str, entity_type: str,
               include_archived: bool = False) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    for row in export_rows(db, organization_id, entity_type, include_archived):
        writer.writerow([csv_safe(cell) for cell in row])
    return buffer.getvalue()


# --------------------------------------------------------------------------- parsing


class ImportFileError(Exception):
    """The file as a whole cannot be imported."""


class RowError(Exception):
    """One row cannot be imported."""


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.date().isoformat() if value.time() == datetime.min.time() else value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _decode(data: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def parse_table(data: bytes, extension: str) -> list[list[str]]:
    """Return all rows (header first) as lists of trimmed strings."""
    rows: list[list[str]] = []
    if extension == ".xlsx":
        import openpyxl

        try:
            workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        except Exception as exc:  # noqa: BLE001 - any parser failure means an unreadable file
            raise ImportFileError("The spreadsheet could not be read") from exc
        try:
            sheet = workbook.worksheets[0]
            sheet.reset_dimensions()  # never trust the declared <dimension> (audit AF-02)
            for values in sheet.iter_rows(values_only=True, max_col=200):
                rows.append([_cell(v) for v in values])
                if len(rows) > MAX_IMPORT_ROWS + 1:
                    break
        finally:
            workbook.close()
    else:
        text = _decode(data)
        first_line = text.split("\n", 1)[0]
        delimiter = max([",", ";", "\t"], key=lambda d: first_line.count(d))
        try:
            for values in csv.reader(io.StringIO(text), delimiter=delimiter):
                rows.append([_cell(v) for v in values])
                if len(rows) > MAX_IMPORT_ROWS + 1:
                    break
        except csv.Error as exc:
            raise ImportFileError(f"The CSV file could not be parsed: {exc}") from exc
    while rows and not any(rows[0]):
        rows.pop(0)
    if not rows:
        raise ImportFileError("The file contains no header row")
    if len(rows) - 1 > MAX_IMPORT_ROWS:
        raise ImportFileError(f"The file has more than {MAX_IMPORT_ROWS} rows; split it up")
    return rows


def map_headers(entity_type: str, header: list[str]) -> tuple[dict[int, str], list[str]]:
    aliases = HEADER_ALIASES[entity_type]
    mapping: dict[int, str] = {}
    ignored: list[str] = []
    for index, raw in enumerate(header):
        canonical = aliases.get(_norm_header(raw))
        if canonical is None or canonical in mapping.values():
            if raw:
                ignored.append(raw)
            continue
        mapping[index] = canonical
    required = REQUIRED_COLUMNS[entity_type]
    if required not in mapping.values():
        raise ImportFileError(f"Missing required column '{required}'")
    return mapping, ignored


def _split(value: str | None) -> list[str]:
    return list(dict.fromkeys(v.strip() for v in (value or "").split(";") if v.strip()))


def _parse_duration(value: str) -> int:
    value = value.strip()
    if re.fullmatch(r"\d+", value):
        return int(value)
    match = re.fullmatch(r"(?:(\d+):)?(\d{1,2}):(\d{2})", value)
    if not match:
        raise RowError(f"Invalid duration '{value}' (use seconds or m:ss)")
    hours, minutes, seconds = int(match.group(1) or 0), int(match.group(2)), int(match.group(3))
    if seconds >= 60 or (match.group(1) and minutes >= 60):
        raise RowError(f"Invalid duration '{value}'")
    return hours * 3600 + minutes * 60 + seconds


def _validation_message(exc: ValidationError) -> str:
    parts = []
    for err in exc.errors():
        loc = ".".join(str(p) for p in err.get("loc", ()) if not isinstance(p, int)) or "row"
        message = err.get("msg", "Invalid value").removeprefix("Value error, ")
        parts.append(f"{loc}: {message}")
    return "; ".join(parts)


# --------------------------------------------------------------------------- import


@dataclass
class ImportState:
    organization_id: str
    user_id: str | None
    filename: str
    dry_run: bool
    remaining: int | None
    parties: dict[str, Party] = field(default_factory=dict)
    parties_created: int = 0

    def audit(self, db: Session, action: str, entity_type: str, entity_id: str,
              summary: str, changes: dict | None = None) -> None:
        record_audit(db, action=action, actor_user_id=self.user_id,
                     organization_id=self.organization_id, entity_type=entity_type,
                     entity_id=entity_id, summary=summary, changes=changes or None)

    def reserve_capacity(self) -> None:
        if self.remaining is not None and self.remaining <= 0:
            raise RowError("Plan limit for catalog items reached; row not imported")


PARTY_ROLE_FOR_COLUMN = {
    "writers": ("songwriter", "composer_lyricist"),
    "composers": ("composer", "composer"),
    "lyricists": ("lyricist", "lyricist"),
    "publishers": ("publisher", "original_publisher"),
    "artists": ("artist", "main_artist"),
    "featured_artists": ("artist", "featured_artist"),
    "producers": ("producer", "producer"),
}


def find_or_create_party(db: Session, state: ImportState, name: str, party_role: str) -> Party:
    name = name.strip()
    if len(name) > 255:
        raise RowError(f"Party name is too long: '{name[:40]}...'")
    key = name.casefold()
    party = state.parties.get(key)
    if party is None:
        party = db.scalars(
            select(Party).where(Party.organization_id == state.organization_id,
                                Party.name == name).order_by(Party.created_at, Party.id).limit(1)
        ).first()
    if party is None:
        party = Party(
            organization_id=state.organization_id,
            created_by_id=state.user_id,
            name=name,
            party_type="company" if party_role in ("publisher", "label") else "person",
            roles=[party_role],
        )
        db.add(party)
        db.flush()
        state.parties_created += 1
        state.audit(db, "party.created", "party", party.id,
                    f"Created party {name} (import of {state.filename})")
    elif party_role not in (party.roles or []):
        party.roles = [*(party.roles or []), party_role]
    state.parties[key] = party
    return party


def _apply_changes(entity: Any, values: dict[str, Any]) -> dict[str, Any]:
    changes = {}
    for name, value in values.items():
        current = getattr(entity, name)
        if current != value:
            changes[name] = {"from": current, "to": value}
            setattr(entity, name, value)
    return changes


def _provided(row: dict[str, str], *columns: str) -> dict[str, str]:
    return {c: row[c] for c in columns if row.get(c)}


def _import_work(db: Session, state: ImportState, row: dict[str, str]) -> str:
    raw = _provided(row, "title", "iswc", "internal_code", "language", "genre",
                    "creation_year", "status", "verification_status", "notes")
    if "alternate_titles" in row and row["alternate_titles"]:
        raw["alternate_titles"] = _split(row["alternate_titles"])
    if "status" in raw:
        raw["status"] = raw["status"].lower()
    if "verification_status" in raw:
        raw["verification_status"] = raw["verification_status"].lower()
    try:
        data = WorkCreate.model_validate(raw)
    except ValidationError as exc:
        raise RowError(_validation_message(exc)) from exc
    values = data.model_dump(include=set(raw), exclude={"contributors"})

    contributors: list[tuple[Party, str]] = []
    for column in ("writers", "composers", "lyricists", "publishers"):
        party_role, work_role = PARTY_ROLE_FOR_COLUMN[column]
        for name in _split(row.get(column)):
            contributors.append((find_or_create_party(db, state, name, party_role), work_role))

    org = state.organization_id
    existing = None
    if data.iswc:
        existing = svc.find_by_identifier(db, org, "work", data.iswc)
    if existing is None and data.internal_code:
        existing = db.scalars(select(Work).where(
            Work.organization_id == org, Work.internal_code == data.internal_code)).first()

    if existing is None:
        state.reserve_capacity()
        work = Work(organization_id=org, created_by_id=state.user_id,
                    **data.model_dump(exclude={"contributors"}))
        db.add(work)
        for party, role in dict.fromkeys(contributors):
            work.contributors.append(WorkContributor(organization_id=org, party_id=party.id,
                                                     role=role))
        db.flush()
        state.audit(db, "work.created", "work", work.id,
                    f"Created work {work.title} (import of {state.filename})")
        return "created"

    if "internal_code" in values and values["internal_code"] != existing.internal_code:
        svc.check_internal_code(db, Work, org, values["internal_code"], exclude_id=existing.id)
    changes = _apply_changes(existing, values)
    have = {(c.party_id, c.role) for c in existing.contributors}
    added = []
    for party, role in dict.fromkeys(contributors):
        if (party.id, role) not in have:
            existing.contributors.append(WorkContributor(organization_id=org,
                                                         party_id=party.id, role=role))
            have.add((party.id, role))
            added.append(f"{party.id}:{role}")
    if added:
        changes["contributors_added"] = added
    if not changes:
        return "skipped"
    db.flush()
    state.audit(db, "work.updated", "work", existing.id,
                f"Updated work {existing.title} (import of {state.filename})", changes)
    return "updated"


def _import_recording(db: Session, state: ImportState, row: dict[str, str]) -> str:
    raw: dict[str, Any] = _provided(row, "title", "version_title", "isrc", "internal_code",
                                    "display_artist", "recording_date", "p_line", "is_explicit",
                                    "status", "verification_status", "notes")
    if row.get("duration"):
        raw["duration_seconds"] = _parse_duration(row["duration"])
    for key in ("status", "verification_status", "is_explicit"):
        if key in raw:
            raw[key] = raw[key].lower()
    try:
        data = RecordingCreate.model_validate(raw)
    except ValidationError as exc:
        raise RowError(_validation_message(exc)) from exc
    values = data.model_dump(include=set(raw),
                             exclude={"contributors", "work_ids"})

    org = state.organization_id
    work_ids: list[str] = []
    for value in _split(row.get("work_iswcs")):
        if not identifiers.is_valid_iswc(value):
            raise RowError(f"Invalid work ISWC '{value}'")
        work = svc.find_by_identifier(db, org, "work", identifiers.normalize_iswc(value))
        if work is None:
            raise RowError(f"No work with ISWC {value} in this catalog")
        work_ids.append(work.id)

    contributors: list[tuple[Party, str]] = []
    artist_names = _split(row.get("artists"))
    for column in ("artists", "featured_artists", "producers"):
        party_role, recording_role = PARTY_ROLE_FOR_COLUMN[column]
        for name in _split(row.get(column)):
            contributors.append((find_or_create_party(db, state, name, party_role),
                                 recording_role))
    primary = contributors[0][0] if artist_names else None

    existing = None
    if data.isrc:
        existing = svc.find_by_identifier(db, org, "recording", data.isrc)
    if existing is None and data.internal_code:
        existing = db.scalars(select(Recording).where(
            Recording.organization_id == org,
            Recording.internal_code == data.internal_code)).first()

    if existing is None:
        state.reserve_capacity()
        recording = Recording(organization_id=org, created_by_id=state.user_id,
                              primary_artist_id=primary.id if primary else None,
                              **data.model_dump(exclude={"contributors", "work_ids",
                                                         "primary_artist_id"}))
        db.add(recording)
        for party, role in dict.fromkeys(contributors):
            recording.contributors.append(RecordingContributor(
                organization_id=org, party_id=party.id, role=role))
        for work_id in dict.fromkeys(work_ids):
            recording.work_links.append(RecordingWork(organization_id=org, work_id=work_id))
        db.flush()
        state.audit(db, "recording.created", "recording", recording.id,
                    f"Created recording {recording.title} (import of {state.filename})")
        return "created"

    if "internal_code" in values and values["internal_code"] != existing.internal_code:
        svc.check_internal_code(db, Recording, org, values["internal_code"],
                                exclude_id=existing.id)
    if primary is not None and existing.primary_artist_id is None:
        values["primary_artist_id"] = primary.id
    changes = _apply_changes(existing, values)
    have = {(c.party_id, c.role) for c in existing.contributors}
    added = []
    for party, role in dict.fromkeys(contributors):
        if (party.id, role) not in have:
            existing.contributors.append(RecordingContributor(
                organization_id=org, party_id=party.id, role=role))
            have.add((party.id, role))
            added.append(f"{party.id}:{role}")
    linked = {link.work_id for link in existing.work_links}
    new_links = [w for w in dict.fromkeys(work_ids) if w not in linked]
    for work_id in new_links:
        existing.work_links.append(RecordingWork(organization_id=org, work_id=work_id))
    if added:
        changes["contributors_added"] = added
    if new_links:
        changes["works_linked"] = new_links
    if not changes:
        return "skipped"
    db.flush()
    state.audit(db, "recording.updated", "recording", existing.id,
                f"Updated recording {existing.title} (import of {state.filename})", changes)
    return "updated"


def _import_party(db: Session, state: ImportState, row: dict[str, str]) -> str:
    raw: dict[str, Any] = _provided(row, "name", "party_type", "legal_name", "email",
                                    "country_code", "ipi_number", "isni", "pro_affiliation",
                                    "status", "notes")
    if row.get("roles"):
        raw["roles"] = [r.lower() for r in _split(row["roles"])]
    for key in ("party_type", "status"):
        if key in raw:
            raw[key] = raw[key].lower()
    try:
        data = PartyCreate.model_validate(raw)
    except ValidationError as exc:
        raise RowError(_validation_message(exc)) from exc
    values = data.model_dump(include=set(raw))

    org = state.organization_id
    existing = None
    if data.ipi_number:
        existing = db.scalars(select(Party).where(
            Party.organization_id == org, Party.ipi_number == data.ipi_number)
            .order_by(Party.created_at, Party.id)).first()
    if existing is None and data.isni:
        existing = db.scalars(select(Party).where(
            Party.organization_id == org, Party.isni == data.isni)
            .order_by(Party.created_at, Party.id)).first()
    if existing is None:
        existing = db.scalars(select(Party).where(
            Party.organization_id == org, Party.name == data.name)
            .order_by(Party.created_at, Party.id)).first()

    if existing is None:
        party = Party(organization_id=org, created_by_id=state.user_id, **data.model_dump())
        db.add(party)
        db.flush()
        state.parties[party.name.casefold()] = party
        state.audit(db, "party.created", "party", party.id,
                    f"Created party {party.name} (import of {state.filename})")
        return "created"

    if "roles" in values:
        values["roles"] = list(dict.fromkeys([*(existing.roles or []), *values["roles"]]))
    changes = _apply_changes(existing, values)
    if not changes:
        return "skipped"
    db.flush()
    state.audit(db, "party.updated", "party", existing.id,
                f"Updated party {existing.name} (import of {state.filename})", changes)
    return "updated"


ROW_HANDLERS = {"work": _import_work, "recording": _import_recording, "party": _import_party}


def _remaining_capacity(db: Session, organization_id: str) -> int | None:
    """Catalog items that can still be created under the plan limit (the
    same rule ``billing.check_limit`` enforces), or None when unlimited."""
    plan = billing.get_plan_for_org(db, organization_id)
    limit = plan.limits.get("max_catalog_items")
    if limit is None:
        return None
    usage = billing.measure_usage(db, organization_id)["max_catalog_items"]
    return max(0, int(limit) - usage)


def run_import(db: Session, *, organization_id: str, entity_type: str, data: bytes,
               extension: str, filename: str, dry_run: bool, user_id: str | None,
               progress=None) -> dict[str, Any]:
    """Import rows into the session (the caller commits or rolls back)."""
    entity_type = canonical_import_type(entity_type)
    rows = parse_table(data, extension)
    mapping, ignored = map_headers(entity_type, rows[0])
    body = rows[1:]
    state = ImportState(
        organization_id=organization_id,
        user_id=user_id,
        filename=filename,
        dry_run=dry_run,
        remaining=None if entity_type == "party" else _remaining_capacity(db, organization_id),
    )
    handler = ROW_HANDLERS[entity_type]
    counts = {"created": 0, "updated": 0, "skipped": 0}
    errors: list[dict[str, Any]] = []
    error_count = 0
    total = len(body)
    processed = 0
    for index, values in enumerate(body):
        line = index + 2
        if progress and index and index % 25 == 0:
            progress(int(index * 100 / max(total, 1)))
        row = {canonical: values[i].strip() if i < len(values) else ""
               for i, canonical in mapping.items()}
        if not any(row.values()):
            continue
        processed += 1
        parties_before = state.parties_created
        message: str | None = None
        try:
            with db.begin_nested():
                outcome = handler(db, state, row)
        except RowError as exc:
            message = str(exc)
        except AppError as exc:  # duplicate internal code, unknown ids...
            message = exc.message
        except IntegrityError:
            message = "Conflicts with existing catalog data"
        if message is not None:
            # The row's savepoint was rolled back, including parties it created.
            state.parties.clear()
            state.parties_created = parties_before
            error_count += 1
            if len(errors) < MAX_REPORTED_ERRORS:
                errors.append({"row": line, "message": message})
            continue
        counts[outcome] += 1
        if outcome == "created" and entity_type != "party" and state.remaining is not None:
            state.remaining -= 1
    return {
        "entity_type": entity_type,
        "dry_run": dry_run,
        "filename": filename,
        "total_rows": processed,
        **counts,
        "parties_created": state.parties_created,
        "error_count": error_count,
        "errors": errors,
        "errors_truncated": error_count > len(errors),
        "ignored_columns": ignored,
    }


def _notify_failure(db: Session, ctx: jobs.JobContext, message: str) -> None:
    if not ctx.created_by_id:
        return
    notify_user(
        db,
        user_id=ctx.created_by_id,
        organization_id=ctx.organization_id,
        type="import_failed",
        title="Catalog import failed",
        body=f"{ctx.payload.get('filename') or 'The file'} could not be imported: {message}",
        link=f"/catalog/imports/{ctx.job_id}",
        severity="error",
    )


@jobs.job_handler(IMPORT_JOB_TYPE, on_failure=_notify_failure)
def handle_catalog_import(db: Session, ctx: jobs.JobContext) -> dict[str, Any]:
    payload = ctx.payload
    try:
        record = storage.get_org_file(db, ctx.organization_id, payload["file_id"])
        content = storage.read_file(record)
    except (KeyError, NotFoundError) as exc:
        raise jobs.PermanentJobError("The uploaded file is no longer available") from exc
    filename = record.original_filename
    extension = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ".csv"
    dry_run = bool(payload.get("dry_run"))
    try:
        result = run_import(
            db,
            organization_id=ctx.organization_id,
            entity_type=payload.get("entity_type", ""),
            data=content,
            extension=extension,
            filename=filename,
            dry_run=dry_run,
            user_id=ctx.created_by_id,
            progress=ctx.progress,
        )
    except (ImportFileError, ValidationFailedError) as exc:
        db.rollback()
        raise jobs.PermanentJobError(getattr(exc, "message", None) or str(exc)) from exc

    result["file_id"] = record.id
    if dry_run:
        db.rollback()
    else:
        record_audit(
            db,
            action="catalog.imported",
            actor_user_id=ctx.created_by_id,
            organization_id=ctx.organization_id,
            entity_type="background_job",
            entity_id=ctx.job_id,
            summary=(f"Imported {result['entity_type']}s from {filename}: "
                     f"{result['created']} created, {result['updated']} updated, "
                     f"{result['skipped']} skipped, {result['error_count']} errors"),
        )
    if ctx.created_by_id:
        prefix = "Dry run: would create" if dry_run else "Created"
        notify_user(
            db,
            user_id=ctx.created_by_id,
            organization_id=ctx.organization_id,
            type="import_completed",
            title=("Catalog import dry run completed" if dry_run
                   else "Catalog import completed"),
            body=(f"{filename}: {prefix} {result['created']}, updated {result['updated']}, "
                  f"skipped {result['skipped']}, {result['error_count']} row error(s)."),
            link=f"/catalog/imports/{ctx.job_id}",
            severity="warning" if result["error_count"] else "info",
        )
    return result


# --------------------------------------------------------------------------- job API


def import_idempotency_key(organization_id: str, entity_type: str, dry_run: bool,
                           sha256: str) -> str:
    return f"catalog_import:{organization_id}:{entity_type}:{'dry' if dry_run else 'run'}:{sha256}"


def start_import(db: Session, ctx: OrgContext, *, filename: str | None, data: bytes,
                 entity_type: str, dry_run: bool) -> tuple[BackgroundJob, bool]:
    """Validate and store the upload, then queue the import job. Re-uploading
    the same file for the same entity type returns the existing job (a failed
    or cancelled one is re-queued)."""
    entity_type = canonical_import_type(entity_type)
    upload = storage.validate_bytes(filename, data, "import")
    key = import_idempotency_key(ctx.organization_id, entity_type, dry_run, upload.sha256)
    existing = db.scalar(select(BackgroundJob).where(BackgroundJob.idempotency_key == key))
    if existing is not None:
        if existing.status in ("failed", "cancelled"):
            jobs.retry_job(db, existing)
            db.refresh(existing)
        return existing, True
    stored = storage.store_file(db, organization_id=ctx.organization_id, category="import",
                                upload=upload, created_by_id=ctx.user.id)
    record_audit(
        db,
        action="catalog.import_started",
        actor_user_id=ctx.user.id,
        organization_id=ctx.organization_id,
        entity_type="stored_file",
        entity_id=stored.id,
        summary=f"Uploaded {upload.filename} for {entity_type} import"
                + (" (dry run)" if dry_run else ""),
    )
    job = jobs.enqueue(
        db,
        organization_id=ctx.organization_id,
        job_type=IMPORT_JOB_TYPE,
        payload={"file_id": stored.id, "entity_type": entity_type, "dry_run": dry_run,
                 "filename": upload.filename},
        created_by_id=ctx.user.id,
        idempotency_key=key,
    )
    return job, False


def get_import_job(db: Session, organization_id: str, job_id: str) -> BackgroundJob:
    job = db.scalar(select(BackgroundJob).where(
        BackgroundJob.id == job_id,
        BackgroundJob.organization_id == organization_id,
        BackgroundJob.job_type == IMPORT_JOB_TYPE,
    ))
    if job is None:
        raise NotFoundError("Import not found")
    return job


def list_import_jobs(db: Session, organization_id: str, limit: int = 50) -> list[BackgroundJob]:
    return list(db.scalars(
        select(BackgroundJob).where(
            BackgroundJob.organization_id == organization_id,
            BackgroundJob.job_type == IMPORT_JOB_TYPE,
        ).order_by(BackgroundJob.created_at.desc(), BackgroundJob.id).limit(limit)
    ).all())


def import_job_payload(job: BackgroundJob, deduplicated: bool = False) -> dict[str, Any]:
    payload = job.payload or {}
    return {
        "id": job.id,
        "job_type": job.job_type,
        "status": job.status,
        "progress": job.progress,
        "entity_type": payload.get("entity_type"),
        "dry_run": bool(payload.get("dry_run")),
        "filename": payload.get("filename"),
        "file_id": payload.get("file_id"),
        "result": job.result,
        "error": job.error,
        "deduplicated": deduplicated,
        "created_by_id": job.created_by_id,
        "created_at": job.created_at,
        "finished_at": job.finished_at,
    }


def export_filename(entity_type: str) -> str:
    entity_type = svc.canonical_entity_type(entity_type, EXPORT_ENTITY_TYPES)
    plural = "parties" if entity_type == "party" else f"{entity_type}s"
    return f"rightsflow-{plural}-{utc_now():%Y%m%d}.csv"
