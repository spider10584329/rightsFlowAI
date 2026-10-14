"""Test configuration.

Tests run against a separate MariaDB database (``TEST_DATABASE_URL``, default:
the development database name with a ``_test`` suffix). The schema is
recreated at the start of the session and every table is emptied after each
test. A guard refuses to run against any database whose name does not end
in ``_test``.
"""

import os
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from dotenv import dotenv_values
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

_env = {**dotenv_values(BACKEND_DIR / ".env"), **os.environ}
_base_url = make_url(_env["DATABASE_URL"])
_test_url = _env.get("TEST_DATABASE_URL") or _base_url.set(
    database=f"{_base_url.database}_test"
).render_as_string(hide_password=False)
if not make_url(_test_url).database.endswith("_test"):
    raise RuntimeError("Refusing to run tests against a non-test database")

os.environ["DATABASE_URL"] = _test_url
os.environ["APP_ENV"] = "test"
os.environ["RUN_EMBEDDED_WORKER"] = "false"
os.environ["AI_PROVIDER"] = "none"
os.environ["EMAIL_PROVIDER"] = "console"
os.environ["BILLING_PROVIDER"] = "manual"
os.environ.setdefault("LOG_LEVEL", "WARNING")


def _ensure_database() -> None:
    url = make_url(_test_url)
    server = create_engine(url.set(database=""))
    with server.connect() as conn:
        conn.execute(
            text(
                f"CREATE DATABASE IF NOT EXISTS `{url.database}` "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
            )
        )
    server.dispose()


_ensure_database()

from fastapi.testclient import TestClient  # noqa: E402

import app.models  # noqa: E402,F401
from app.core.config import settings  # noqa: E402
from app.core.rate_limit import limiter  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.session import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.services import storage  # noqa: E402
from app.services.billing import ensure_plans  # noqa: E402

assert engine.url.database.endswith("_test")


@pytest.fixture(scope="session", autouse=True)
def _schema() -> Iterator[None]:
    with engine.begin() as conn:
        conn.execute(text("SET FOREIGN_KEY_CHECKS=0"))
        Base.metadata.drop_all(conn)
        conn.execute(text("DROP TABLE IF EXISTS alembic_version"))
        conn.execute(text("SET FOREIGN_KEY_CHECKS=1"))
        Base.metadata.create_all(conn)
    yield


@pytest.fixture(autouse=True)
def _clean_state(tmp_path: Path) -> Iterator[None]:
    limiter.reset()
    storage.set_storage(storage.LocalStorage(tmp_path / "files"))
    settings.email_outbox_path = tmp_path / "outbox"
    with SessionLocal() as db:
        ensure_plans(db)
    yield
    with engine.begin() as conn:
        conn.execute(text("SET FOREIGN_KEY_CHECKS=0"))
        for table in reversed(Base.metadata.sorted_tables):
            if table.name != "plans":
                conn.execute(table.delete())
        conn.execute(text("SET FOREIGN_KEY_CHECKS=1"))
    storage.set_storage(None)


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def db():
    with SessionLocal() as session:
        yield session


DEFAULT_PASSWORD = "Sup3r-Secure-Pass!"


class Api:
    """Small helper around TestClient for authenticated calls."""

    def __init__(self, client: TestClient) -> None:
        self.client = client

    def register(self, email: str, name: str = "Test User", password: str = DEFAULT_PASSWORD) -> dict:
        response = self.client.post(
            "/api/v1/auth/register",
            json={"email": email, "full_name": name, "password": password},
        )
        assert response.status_code == 201, response.text
        return response.json()

    def login(self, email: str, password: str = DEFAULT_PASSWORD) -> dict:
        response = self.client.post(
            "/api/v1/auth/login", json={"email": email, "password": password}
        )
        assert response.status_code == 200, response.text
        return response.json()

    def user(self, email: str, name: str = "Test User") -> dict:
        """Register + login; returns auth headers and tokens."""
        profile = self.register(email, name)
        tokens = self.login(email)
        return {
            "id": profile["id"],
            "email": email,
            "headers": {"Authorization": f"Bearer {tokens['access_token']}"},
            "tokens": tokens,
        }

    def org(self, owner: dict, slug: str = "acme-music", name: str = "Acme Music") -> dict:
        response = self.client.post(
            "/api/v1/organizations", json={"name": name, "slug": slug}, headers=owner["headers"]
        )
        assert response.status_code == 201, response.text
        return response.json()

    def add_member(self, org_id: str, owner: dict, member: dict, role: str) -> dict:
        """Invite ``member`` and accept with the emailed token (the only way to join)."""
        invited = self.client.post(
            f"/api/v1/organizations/{org_id}/invitations",
            json={"email": member["email"], "role": role},
            headers=owner["headers"],
        )
        assert invited.status_code == 201, invited.text
        token = invited.json()["invite_url"].split("token=", 1)[1]
        response = self.client.post(
            "/api/v1/invitations/accept", json={"token": token}, headers=member["headers"]
        )
        assert response.status_code == 200, response.text
        # Fixture setup shouldn't leave invitation emails/notifications behind
        # for the tests that then inspect those tables.
        from app.models.platform import EmailMessage, Notification

        with SessionLocal() as session:
            session.execute(
                Notification.__table__.delete().where(
                    Notification.organization_id == org_id,
                    Notification.type.in_(["invitation", "invitation_accepted"]),
                )
            )
            session.execute(
                EmailMessage.__table__.delete().where(
                    EmailMessage.to_email.in_([member["email"], owner["email"]]),
                    EmailMessage.template.like("%invitation%"),
                )
            )
            session.commit()
        return response.json()


@pytest.fixture
def api(client: TestClient) -> Api:
    return Api(client)


class FakeAIProvider:
    """Deterministic provider for tests. ``responses`` maps a schema title
    (the Pydantic model name) to the dict to return; ``error`` forces failure."""

    name = "fake"
    model = "fake-model"

    def __init__(self, responses: dict | None = None, error: Exception | None = None) -> None:
        self.responses = responses or {}
        self.error = error
        self.calls: list[dict] = []

    def generate_json(self, *, system, messages, schema, max_tokens):
        from app.services.ai import AIResult

        self.calls.append({"system": system, "messages": messages, "schema": schema})
        if self.error:
            raise self.error
        return AIResult(
            data=self.responses.get(schema.get("title"), {}),
            provider=self.name,
            model=self.model,
            input_tokens=100,
            output_tokens=50,
            latency_ms=5,
        )


@pytest.fixture
def fake_ai():
    from app.services.ai import set_ai_provider

    provider = FakeAIProvider()
    set_ai_provider(provider)
    yield provider
    set_ai_provider(None)


def fence_section(prompt: str, source: str) -> str | None:
    """Content of the untrusted-data fence with ``source`` (tag names carry a
    random per-call suffix, so tests match them by pattern)."""
    import re

    match = re.search(
        r'<(untrusted_data_[0-9a-f]+) source="' + re.escape(source) + r'">\n(.*?)\n</\1>', prompt, re.S
    )
    return match.group(2) if match else None


FENCE_OPEN_RE = r"<untrusted_data_[0-9a-f]+ source="
FENCE_CLOSE_RE = r"</untrusted_data_[0-9a-f]+>"


def email_token(db, to_email: str, template: str) -> str:
    """One-time token from the latest email of ``template`` sent to ``to_email``.

    Stored message bodies are redacted, so tests read the dev outbox preview
    file (the console provider's .eml), exactly like a developer would.
    """
    import re

    from sqlalchemy import select

    from app.models.platform import EmailMessage

    db.expire_all()
    message = db.scalars(
        select(EmailMessage)
        .where(EmailMessage.to_email == to_email, EmailMessage.template == template)
        .order_by(EmailMessage.created_at.desc())
    ).first()
    assert message is not None and message.preview_path, f"no {template} email for {to_email}"
    assert "[redacted]" in message.body_text or "token=" not in message.body_text
    from email import message_from_bytes, policy

    parsed = message_from_bytes(Path(message.preview_path).read_bytes(), policy=policy.default)
    preview = parsed.get_content()  # decodes quoted-printable
    match = re.search(r"token=([A-Za-z0-9_\-]+)", preview)
    assert match, "token not found in preview"
    return match.group(1)


def run_jobs() -> int:
    """Process all queued background jobs synchronously."""
    from app.services.jobs import run_pending_jobs

    return run_pending_jobs(SessionLocal)


@pytest.fixture
def team(api: Api) -> dict:
    """An organization with one user per role plus an outsider in another org."""
    owner = api.user("owner@example.com", "Olivia Owner")
    org = api.org(owner)
    admin = api.user("admin@example.com", "Adam Admin")
    manager = api.user("manager@example.com", "Mia Manager")
    viewer = api.user("viewer@example.com", "Victor Viewer")
    api.add_member(org["id"], owner, admin, "admin")
    api.add_member(org["id"], owner, manager, "manager")
    api.add_member(org["id"], owner, viewer, "viewer")
    outsider = api.user("outsider@example.com", "Oscar Outsider")
    other_org = api.org(outsider, slug="other-label", name="Other Label")
    return {
        "org": org,
        "org_id": org["id"],
        "owner": owner,
        "admin": admin,
        "manager": manager,
        "viewer": viewer,
        "outsider": outsider,
        "other_org": other_org,
    }
