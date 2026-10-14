"""Music catalog: parties, works (compositions), recordings and releases."""

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.db.mixins import (
    CreatedByMixin,
    TenantMixin,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
    utc_now,
)

CATALOG_STATUSES = ("active", "draft", "archived")
_STATUS_CHECK = "status IN ('active', 'draft', 'archived')"


class Party(UUIDPrimaryKeyMixin, TenantMixin, CreatedByMixin, TimestampMixin, Base):
    """A person or company: artist, songwriter, composer, producer, publisher,
    label or any other contributor / rights holder."""

    __tablename__ = "parties"
    __table_args__ = (
        CheckConstraint("party_type IN ('person', 'company')", name="ck_party_type"),
        CheckConstraint(_STATUS_CHECK, name="ck_party_status"),
        Index("ix_parties_org_name", "organization_id", "name"),
        Index("ix_parties_org_ipi", "organization_id", "ipi_number"),
    )

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    party_type: Mapped[str] = mapped_column(String(20), default="person", nullable=False)
    # e.g. ["artist", "songwriter", "publisher"]
    roles: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    legal_name: Mapped[str | None] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(255))
    country_code: Mapped[str | None] = mapped_column(String(2))
    ipi_number: Mapped[str | None] = mapped_column(String(20))
    isni: Mapped[str | None] = mapped_column(String(20))
    pro_affiliation: Mapped[str | None] = mapped_column(String(100))
    # True when the party represents the organization itself (e.g. its own
    # publishing designee); earnings to internal parties are retained, not payable.
    is_internal: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    external_ids: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)


class Work(UUIDPrimaryKeyMixin, TenantMixin, CreatedByMixin, TimestampMixin, Base):
    """A musical work / composition."""

    __tablename__ = "works"
    __table_args__ = (
        CheckConstraint(_STATUS_CHECK, name="ck_work_status"),
        UniqueConstraint("organization_id", "internal_code", name="uq_work_internal_code"),
        Index("ix_works_org_title", "organization_id", "title"),
        Index("ix_works_org_iswc", "organization_id", "iswc"),
    )

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    alternate_titles: Mapped[list[str] | None] = mapped_column(JSON)
    iswc: Mapped[str | None] = mapped_column(String(15))
    internal_code: Mapped[str | None] = mapped_column(String(50))
    language: Mapped[str | None] = mapped_column(String(10))
    genre: Mapped[str | None] = mapped_column(String(100))
    creation_year: Mapped[int | None] = mapped_column(Integer)
    lyrics_excerpt: Mapped[str | None] = mapped_column(Text)
    external_ids: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)
    verification_status: Mapped[str] = mapped_column(
        String(20), default="unverified", nullable=False
    )

    contributors: Mapped[list["WorkContributor"]] = relationship(
        back_populates="work", cascade="all, delete-orphan", lazy="selectin"
    )


class Recording(UUIDPrimaryKeyMixin, TenantMixin, CreatedByMixin, TimestampMixin, Base):
    """A sound recording (master)."""

    __tablename__ = "recordings"
    __table_args__ = (
        CheckConstraint(_STATUS_CHECK, name="ck_recording_status"),
        UniqueConstraint(
            "organization_id", "internal_code", name="uq_recording_internal_code"
        ),
        Index("ix_recordings_org_title", "organization_id", "title"),
        Index("ix_recordings_org_isrc", "organization_id", "isrc"),
    )

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    version_title: Mapped[str | None] = mapped_column(String(255))
    isrc: Mapped[str | None] = mapped_column(String(12))
    internal_code: Mapped[str | None] = mapped_column(String(50))
    primary_artist_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("parties.id", ondelete="SET NULL")
    )
    display_artist: Mapped[str | None] = mapped_column(String(255))
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    recording_date: Mapped[date | None] = mapped_column(Date)
    p_line: Mapped[str | None] = mapped_column(String(255))
    is_explicit: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    external_ids: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)
    verification_status: Mapped[str] = mapped_column(
        String(20), default="unverified", nullable=False
    )

    primary_artist: Mapped[Party | None] = relationship(lazy="joined")
    contributors: Mapped[list["RecordingContributor"]] = relationship(
        back_populates="recording", cascade="all, delete-orphan", lazy="selectin"
    )
    work_links: Mapped[list["RecordingWork"]] = relationship(
        back_populates="recording", cascade="all, delete-orphan", lazy="selectin"
    )


class RecordingWork(UUIDPrimaryKeyMixin, TenantMixin, Base):
    """Link between a recording and the work(s) it embodies."""

    __tablename__ = "recording_works"
    __table_args__ = (
        UniqueConstraint("recording_id", "work_id", name="uq_recording_work"),
    )

    recording_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("recordings.id", ondelete="CASCADE"), nullable=False
    )
    work_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("works.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)

    recording: Mapped[Recording] = relationship(back_populates="work_links")
    work: Mapped[Work] = relationship(lazy="joined")


class WorkContributor(UUIDPrimaryKeyMixin, TenantMixin, Base):
    __tablename__ = "work_contributors"
    __table_args__ = (
        UniqueConstraint("work_id", "party_id", "role", name="uq_work_contributor"),
    )

    work_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("works.id", ondelete="CASCADE"), nullable=False
    )
    party_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("parties.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # composer, lyricist, composer_lyricist, arranger, adapter, translator,
    # original_publisher, sub_publisher, administrator
    role: Mapped[str] = mapped_column(String(30), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)

    work: Mapped[Work] = relationship(back_populates="contributors")
    party: Mapped[Party] = relationship(lazy="joined")


class RecordingContributor(UUIDPrimaryKeyMixin, TenantMixin, Base):
    __tablename__ = "recording_contributors"
    __table_args__ = (
        UniqueConstraint(
            "recording_id", "party_id", "role", name="uq_recording_contributor"
        ),
    )

    recording_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("recordings.id", ondelete="CASCADE"), nullable=False
    )
    party_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("parties.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # main_artist, featured_artist, producer, co_producer, mixer, engineer,
    # mastering_engineer, musician, vocalist, label
    role: Mapped[str] = mapped_column(String(30), nullable=False)
    instrument: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)

    recording: Mapped[Recording] = relationship(back_populates="contributors")
    party: Mapped[Party] = relationship(lazy="joined")


class Release(UUIDPrimaryKeyMixin, TenantMixin, CreatedByMixin, TimestampMixin, Base):
    """An album, EP, single or compilation."""

    __tablename__ = "releases"
    __table_args__ = (
        CheckConstraint(_STATUS_CHECK, name="ck_release_status"),
        CheckConstraint(
            "release_type IN ('album', 'ep', 'single', 'compilation', 'other')",
            name="ck_release_type",
        ),
        Index("ix_releases_org_title", "organization_id", "title"),
        Index("ix_releases_org_upc", "organization_id", "upc"),
    )

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    release_type: Mapped[str] = mapped_column(String(20), default="album", nullable=False)
    upc: Mapped[str | None] = mapped_column(String(14))
    catalog_number: Mapped[str | None] = mapped_column(String(50))
    label_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("parties.id", ondelete="SET NULL")
    )
    display_artist: Mapped[str | None] = mapped_column(String(255))
    release_date: Mapped[date | None] = mapped_column(Date)
    c_line: Mapped[str | None] = mapped_column(String(255))
    external_ids: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="active", nullable=False)

    label: Mapped[Party | None] = relationship(lazy="joined")
    tracks: Mapped[list["ReleaseTrack"]] = relationship(
        back_populates="release",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="(ReleaseTrack.disc_number, ReleaseTrack.track_number)",
    )


class ReleaseTrack(UUIDPrimaryKeyMixin, TenantMixin, Base):
    __tablename__ = "release_tracks"
    __table_args__ = (
        UniqueConstraint(
            "release_id", "disc_number", "track_number", name="uq_release_track_position"
        ),
    )

    release_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("releases.id", ondelete="CASCADE"), nullable=False
    )
    recording_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("recordings.id", ondelete="CASCADE"), nullable=False, index=True
    )
    disc_number: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    track_number: Mapped[int] = mapped_column(Integer, nullable=False)

    release: Mapped[Release] = relationship(back_populates="tracks")
    recording: Mapped[Recording] = relationship(lazy="joined")
