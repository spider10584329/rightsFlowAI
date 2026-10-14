"""Background job schemas."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]


class JobResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    organization_id: str
    job_type: str
    status: str
    progress: int
    payload: dict[str, Any] | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    attempts: int
    max_attempts: int
    run_after: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    created_by_id: str | None = None
    created_at: datetime
    updated_at: datetime
