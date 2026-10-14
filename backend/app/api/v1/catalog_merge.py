from typing import Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.permissions import OrgAdmin
from app.db.session import get_db
from app.services import catalog_merge

router = APIRouter(prefix="/organizations/{organization_id}/catalog", tags=["Catalog"])


class MergeRequest(BaseModel):
    entity_type: Literal["party", "work", "recording", "release"]
    survivor_id: str = Field(max_length=36)
    duplicate_id: str = Field(max_length=36)
    # Merging is irreversible in practice; require explicit confirmation.
    confirm: Literal[True]


class MergeResponse(BaseModel):
    entity_type: str
    survivor_id: str
    duplicate_id: str
    moved: dict[str, int]
    filled_fields: list[str]
    message: str


@router.post("/merge", response_model=MergeResponse)
def merge_duplicates(payload: MergeRequest, ctx: OrgAdmin, request: Request,
                     db: Session = Depends(get_db)) -> dict[str, Any]:
    """Merge a duplicate catalog item into a survivor (admin).

    Operational references move to the survivor; posted financial history is
    not rewritten; the duplicate is archived with a note (never deleted).
    """
    survivor, summary = catalog_merge.merge(db, ctx, payload.entity_type, payload.survivor_id,
                                            payload.duplicate_id, request)
    return {
        "entity_type": payload.entity_type,
        "survivor_id": survivor.id,
        "duplicate_id": payload.duplicate_id,
        "moved": summary["moved"],
        "filled_fields": summary["filled_fields"],
        "message": "Merged. The duplicate was archived and points to the surviving item.",
    }
