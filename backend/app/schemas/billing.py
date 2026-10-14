"""Billing, plan and usage schemas."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field

from app.schemas.common import DecimalStr, OptionalDecimalStr

DEVELOPMENT_PLAN_NOTICE = (
    "Development plan: limits are defaults for evaluation and commercial pricing "
    "has not been configured."
)
MANUAL_BILLING_NOTICE = (
    "No payment provider is configured. Plan changes are recorded internally and "
    "nothing is charged."
)


class PlanResponse(BaseModel):
    id: str
    code: str
    name: str
    description: str | None = None
    is_development: bool
    is_public: bool
    sort_order: int
    monthly_price: OptionalDecimalStr = None
    currency: str
    price_display: str
    price_configured: bool
    limits: dict[str, Any]
    notice: str | None = None


class SubscriptionResponse(BaseModel):
    id: str
    plan: PlanResponse
    status: str
    provider: str
    current_period_start: datetime
    current_period_end: datetime | None = None
    cancel_at_period_end: bool
    billing_email: str | None = None


class UsageItem(BaseModel):
    key: str
    label: str
    used: int
    limit: int | None = None
    unlimited: bool
    # used / limit * 100, rounded to 2 places; null when unlimited.
    percentage: OptionalDecimalStr = None
    exceeded: bool


class BillingOverview(BaseModel):
    subscription: SubscriptionResponse
    usage: list[UsageItem]
    features: dict[str, bool]
    provider: str
    provider_configured: bool
    notice: str | None = None


class PlanChangeRequest(BaseModel):
    plan_code: str = Field(min_length=1, max_length=50, pattern=r"^[a-z0-9][a-z0-9-]*$")


class PlanChangeResponse(BaseModel):
    status: Literal["changed", "unchanged", "checkout_required"]
    charged: bool = False
    message: str
    provider: str
    checkout_url: str | None = None
    billing: BillingOverview | None = None


class BillingUpdate(BaseModel):
    billing_email: EmailStr | None = None


class CheckoutRequest(BaseModel):
    plan_code: str | None = Field(
        default=None, min_length=1, max_length=50, pattern=r"^[a-z0-9][a-z0-9-]*$"
    )


class CheckoutResponse(BaseModel):
    provider: str
    checkout_url: str
    charged: bool = False
    message: str


class AIUsageMonth(BaseModel):
    month: str
    feature: str
    requests: int
    input_tokens: int
    output_tokens: int
    estimated_cost_usd: DecimalStr


class AITotals(BaseModel):
    requests: int
    input_tokens: int
    output_tokens: int
    estimated_cost_usd: DecimalStr


class ImportsMonth(BaseModel):
    month: str
    statements: int


class StorageCategory(BaseModel):
    category: str
    files: int
    bytes: int


class StorageUsage(BaseModel):
    files: int
    bytes: int
    megabytes: int
    limit_mb: int | None = None
    by_category: list[StorageCategory]


class UsageHistoryResponse(BaseModel):
    months: int
    since: datetime
    ai_usage: list[AIUsageMonth]
    ai_totals: AITotals
    statement_imports: list[ImportsMonth]
    storage: StorageUsage
