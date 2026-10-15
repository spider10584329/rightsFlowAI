"""Import every model so SQLAlchemy metadata (and Alembic) see all tables."""

from app.models.organization import Organization
from app.models.user import User
from app.models.organization_membership import OrganizationMembership
from app.models.auth_tokens import RefreshToken, UserActionToken
from app.models.invitation import OrganizationInvitation
from app.models.platform import (
    AuditLog,
    BackgroundJob,
    EmailMessage,
    Notification,
    StoredFile,
)
from app.models.billing import AISuggestion, AIUsageRecord, Plan, Subscription
from app.models.catalog import (
    Party,
    Recording,
    RecordingContributor,
    RecordingWork,
    Release,
    ReleaseTrack,
    Work,
    WorkContributor,
)
from app.models.contract import (
    Contract,
    ContractAnalysis,
    ContractAsset,
    ContractDocument,
    ContractParty,
    ContractRoyaltyTerm,
)
from app.models.rights import OwnershipShare, RightsConflict, SplitRule, SplitSheet
from app.models.royalty import (
    LedgerEntry,
    Payee,
    Payout,
    PayoutBatch,
    RoyaltyAllocation,
    RoyaltyRun,
    RoyaltyStatement,
    StatementLine,
)
from app.models.automation import (
    AutomationConnection,
    AutomationDelivery,
    AutomationEvent,
    AutomationIdempotencyKey,
    AutomationInboxFile,
    AutomationIncident,
    AutomationReviewTask,
    AutomationRun,
    AutomationStatementState,
    IntegrationCredential,
    OrganizationAutomation,
)

__all__ = [
    "AISuggestion",
    "AIUsageRecord",
    "AuditLog",
    "AutomationConnection",
    "AutomationDelivery",
    "AutomationEvent",
    "AutomationIdempotencyKey",
    "AutomationInboxFile",
    "AutomationIncident",
    "AutomationReviewTask",
    "AutomationRun",
    "AutomationStatementState",
    "BackgroundJob",
    "Contract",
    "ContractAnalysis",
    "ContractAsset",
    "ContractDocument",
    "ContractParty",
    "ContractRoyaltyTerm",
    "EmailMessage",
    "IntegrationCredential",
    "LedgerEntry",
    "Notification",
    "Organization",
    "OrganizationAutomation",
    "OrganizationInvitation",
    "OrganizationMembership",
    "OwnershipShare",
    "Party",
    "Payee",
    "Payout",
    "PayoutBatch",
    "Plan",
    "Recording",
    "RecordingContributor",
    "RecordingWork",
    "RefreshToken",
    "Release",
    "ReleaseTrack",
    "RightsConflict",
    "RoyaltyAllocation",
    "RoyaltyRun",
    "RoyaltyStatement",
    "SplitRule",
    "SplitSheet",
    "StatementLine",
    "StoredFile",
    "Subscription",
    "User",
    "UserActionToken",
    "Work",
    "WorkContributor",
]
