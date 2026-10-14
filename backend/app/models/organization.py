from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.db.mixins import new_uuid, utc_now

__all__ = ["Organization", "utc_now"]


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(
        String(100), unique=True, index=True, nullable=False
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    legal_name: Mapped[str | None] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(Text)
    website: Mapped[str | None] = mapped_column(String(255))
    country_code: Mapped[str | None] = mapped_column(String(2))
    default_currency: Mapped[str] = mapped_column(
        String(3), default="USD", server_default="USD", nullable=False
    )
    timezone: Mapped[str] = mapped_column(
        String(64), default="UTC", server_default="UTC", nullable=False
    )
    brand_color: Mapped[str | None] = mapped_column(String(7))
    logo_url: Mapped[str | None] = mapped_column(String(500))
    settings: Mapped[dict[str, Any] | None] = mapped_column(JSON)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )
