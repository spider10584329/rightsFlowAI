"""audit hardening constraints

Pre-launch audit fixes (docs/FINAL_AUDIT_REPORT.md):
- royalty_allocations.line_id / contract_term_id: CASCADE / SET NULL -> RESTRICT
  so the audit trail of posted royalties cannot be deleted or silently altered.
- royalty_allocations.work_id / recording_id: add foreign keys (+ indexes).
- subscriptions: one per organization.
- contract_assets: NULL-safe uniqueness (contract, work) and (contract, recording).
- Indexes for notification lists, unmatched-line queries and the email log.
- ledger_entries.created_at: microsecond precision (remittance advice ordering).

Additive except for constraint tightening. Before upgrading a database, check
there are no duplicate subscriptions per organization, duplicate contract
assets, or allocation work/recording ids that reference deleted rows (the
upgrade fails safely if there are).

Revision ID: cbc38defc8d1
Revises: 010ae74ee6d8
Create Date: 2026-10-14 08:28:45.128802

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = 'cbc38defc8d1'
down_revision: Union[str, Sequence[str], None] = '010ae74ee6d8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _fk_name(table: str, column: str) -> str | None:
    """Existing FK names are server-generated (e.g. royalty_allocations_ibfk_2)."""
    for fk in sa.inspect(op.get_bind()).get_foreign_keys(table):
        if fk["constrained_columns"] == [column]:
            return fk["name"]
    return None


def _replace_fk(column: str, target: str, name: str, ondelete: str,
                table: str = "royalty_allocations") -> None:
    old = _fk_name(table, column)
    if old:
        op.drop_constraint(old, table, type_="foreignkey")
    op.create_foreign_key(name, table, target, [column], ["id"], ondelete=ondelete)


def upgrade() -> None:
    # Allocations: protect financial history.
    _replace_fk("line_id", "statement_lines", "fk_allocations_line", "RESTRICT")
    _replace_fk("contract_term_id", "contract_royalty_terms", "fk_allocations_contract_term", "RESTRICT")
    _replace_fk("contract_id", "contracts", "fk_shares_contract", "RESTRICT", table="ownership_shares")
    op.create_index("ix_royalty_allocations_work_id", "royalty_allocations", ["work_id"])
    op.create_index("ix_royalty_allocations_recording_id", "royalty_allocations", ["recording_id"])
    op.create_foreign_key("fk_allocations_work", "royalty_allocations", "works",
                          ["work_id"], ["id"], ondelete="RESTRICT")
    op.create_foreign_key("fk_allocations_recording", "royalty_allocations", "recordings",
                          ["recording_id"], ["id"], ondelete="RESTRICT")

    # One subscription per organization.
    op.create_unique_constraint("uq_subscription_org", "subscriptions", ["organization_id"])

    # Contract assets: add the NULL-safe keys first (the old index also backs
    # the contract_id foreign key, so it can only be dropped afterwards).
    op.create_unique_constraint("uq_contract_asset_work", "contract_assets", ["contract_id", "work_id"])
    op.create_unique_constraint("uq_contract_asset_recording", "contract_assets",
                                ["contract_id", "recording_id"])
    op.drop_index("uq_contract_asset", table_name="contract_assets")

    op.create_index("ix_notifications_user_created", "notifications", ["user_id", "created_at"])
    op.create_index("ix_lines_org_match", "statement_lines", ["organization_id", "match_status"])
    op.create_index("ix_email_org_created", "email_messages", ["organization_id", "created_at"])

    # Content-based duplicate statement detection (audit F-H5).
    op.add_column("royalty_statements", sa.Column("content_sha256", sa.String(length=64), nullable=True))
    op.create_index("ix_statements_org_content", "royalty_statements", ["organization_id", "content_sha256"])

    # Ledger ordering within the same second (audit F-M4). Widening only.
    op.alter_column("ledger_entries", "created_at", existing_type=mysql.DATETIME(),
                    type_=mysql.DATETIME(fsp=6), existing_nullable=False)


def downgrade() -> None:
    op.alter_column("ledger_entries", "created_at", existing_type=mysql.DATETIME(fsp=6),
                    type_=mysql.DATETIME(), existing_nullable=False)
    op.drop_index("ix_statements_org_content", table_name="royalty_statements")
    op.drop_column("royalty_statements", "content_sha256")
    op.drop_index("ix_email_org_created", table_name="email_messages")
    op.drop_index("ix_lines_org_match", table_name="statement_lines")
    op.drop_index("ix_notifications_user_created", table_name="notifications")

    op.create_index("uq_contract_asset", "contract_assets", ["contract_id", "work_id", "recording_id"],
                    unique=True)
    op.drop_constraint("uq_contract_asset_recording", "contract_assets", type_="unique")
    op.drop_constraint("uq_contract_asset_work", "contract_assets", type_="unique")

    op.drop_constraint("uq_subscription_org", "subscriptions", type_="unique")

    op.drop_constraint("fk_allocations_recording", "royalty_allocations", type_="foreignkey")
    op.drop_constraint("fk_allocations_work", "royalty_allocations", type_="foreignkey")
    op.drop_index("ix_royalty_allocations_recording_id", table_name="royalty_allocations")
    op.drop_index("ix_royalty_allocations_work_id", table_name="royalty_allocations")
    op.drop_constraint("fk_allocations_contract_term", "royalty_allocations", type_="foreignkey")
    op.create_foreign_key(None, "royalty_allocations", "contract_royalty_terms",
                          ["contract_term_id"], ["id"], ondelete="SET NULL")
    op.drop_constraint("fk_shares_contract", "ownership_shares", type_="foreignkey")
    op.create_foreign_key(None, "ownership_shares", "contracts", ["contract_id"], ["id"], ondelete="SET NULL")
    op.drop_constraint("fk_allocations_line", "royalty_allocations", type_="foreignkey")
    op.create_foreign_key(None, "royalty_allocations", "statement_lines",
                          ["line_id"], ["id"], ondelete="CASCADE")
