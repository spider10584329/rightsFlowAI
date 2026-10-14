"""Shared API schema primitives."""

from decimal import Decimal
from typing import Annotated, Generic, Literal, TypeVar

from fastapi import Query
from pydantic import BaseModel, ConfigDict, PlainSerializer
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

T = TypeVar("T")

# Money and percentages are serialized as strings to preserve precision.
DecimalStr = Annotated[Decimal, PlainSerializer(lambda v: format(v, "f"), return_type=str)]
OptionalDecimalStr = Annotated[
    Decimal | None,
    PlainSerializer(lambda v: format(v, "f") if v is not None else None, return_type=str | None),
]


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int
    pages: int


class PageParams:
    def __init__(
        self,
        page: Annotated[int, Query(ge=1, le=100000)] = 1,
        page_size: Annotated[int, Query(ge=1, le=200)] = 25,
        sort: Annotated[str | None, Query(max_length=50)] = None,
        order: Annotated[Literal["asc", "desc"], Query()] = "asc",
    ) -> None:
        self.page = page
        self.page_size = page_size
        self.sort = sort
        self.order = order

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size


def paginate(
    db: Session,
    stmt: Select,
    params: PageParams,
    *,
    sortable: dict[str, object] | None = None,
    default_sort: object | None = None,
    scalars: bool = True,
) -> tuple[list, int]:
    """Apply whitelisted sorting and pagination; return (rows, total)."""
    total = db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0
    if params.sort and sortable and params.sort in sortable:
        column = sortable[params.sort]
        stmt = stmt.order_by(column.desc() if params.order == "desc" else column.asc())  # type: ignore[attr-defined]
    elif default_sort is not None:
        # Used verbatim, so callers may pass e.g. ``Model.created_at.desc()``.
        stmt = stmt.order_by(default_sort)
    stmt = stmt.offset(params.offset).limit(params.page_size)
    rows = list(db.scalars(stmt).unique().all()) if scalars else list(db.execute(stmt).all())
    return rows, total


def page_of(items: list, total: int, params: PageParams) -> dict:
    return {
        "items": items,
        "total": total,
        "page": params.page,
        "page_size": params.page_size,
        "pages": max(1, -(-total // params.page_size)),
    }


class MessageResponse(BaseModel):
    message: str


class BulkActionResult(BaseModel):
    affected: int
    skipped: list[str] = []
