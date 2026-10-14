"""Outbound email with pluggable providers.

``console`` (default for development) does NOT deliver mail. It writes an
``.eml`` preview file to ``EMAIL_OUTBOX_PATH`` and records the message with
status ``logged`` so nobody mistakes it for a delivered email.
``smtp`` delivers through a real SMTP server and records ``sent``/``failed``.
"""

import re
import smtplib
import ssl
from email.message import EmailMessage as MimeMessage
from email.utils import make_msgid
from pathlib import Path
from typing import Protocol

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.logging import get_logger
from app.db.mixins import utc_now
from app.models.platform import EmailMessage

logger = get_logger(__name__)


class EmailDeliveryResult:
    def __init__(self, status: str, error: str | None = None, preview_path: str | None = None):
        self.status = status
        self.error = error
        self.preview_path = preview_path


class EmailProvider(Protocol):
    name: str

    def send(self, message: MimeMessage) -> EmailDeliveryResult: ...


class ConsoleEmailProvider:
    name = "console"

    def __init__(self, outbox: Path) -> None:
        self.outbox = outbox

    def send(self, message: MimeMessage) -> EmailDeliveryResult:
        self.outbox.mkdir(parents=True, exist_ok=True)
        filename = f"{utc_now():%Y%m%dT%H%M%S}-{make_msgid(domain='rightsflow.local').strip('<>').split('@')[0]}.eml"
        path = self.outbox / filename
        path.write_bytes(bytes(message))
        logger.info(
            "Email NOT delivered (console provider); preview written",
            extra={"context": {"to": message["To"], "subject": message["Subject"], "path": str(path)}},
        )
        return EmailDeliveryResult("logged", preview_path=str(path))


class SmtpEmailProvider:
    name = "smtp"

    def send(self, message: MimeMessage) -> EmailDeliveryResult:
        if not settings.smtp_host:
            return EmailDeliveryResult("failed", "SMTP_HOST is not configured")
        try:
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20) as client:
                if settings.smtp_use_tls:
                    client.starttls(context=ssl.create_default_context())
                if settings.smtp_username and settings.smtp_password:
                    client.login(settings.smtp_username, settings.smtp_password)
                client.send_message(message)
            return EmailDeliveryResult("sent")
        except (smtplib.SMTPException, OSError) as exc:
            logger.warning("SMTP delivery failed: %s", exc)
            return EmailDeliveryResult("failed", str(exc)[:500])


def get_email_provider() -> EmailProvider:
    if settings.email_provider == "smtp":
        return SmtpEmailProvider()
    return ConsoleEmailProvider(settings.email_outbox_path)


def _mime(to: str, subject: str, body: str) -> MimeMessage:
    mime = MimeMessage()
    mime["From"] = settings.email_from
    mime["To"] = to
    mime["Subject"] = subject
    mime["Message-ID"] = make_msgid(domain="rightsflow.local")
    mime.set_content(body)
    return mime


def send_email(
    db: Session,
    *,
    to: str,
    subject: str,
    body: str,
    template: str,
    organization_id: str | None = None,
    provider: EmailProvider | None = None,
    deliver_async: bool | None = None,
) -> EmailMessage:
    """Record an outbound email and deliver it.

    Real providers (SMTP) deliver through the ``email_delivery`` background
    job, so requests never block on the mail server and failures are retried
    with backoff. The console provider writes its preview immediately.
    """
    provider = provider or get_email_provider()
    if deliver_async is None:
        deliver_async = provider.name != "console"

    record = EmailMessage(
        organization_id=organization_id,
        to_email=to,
        subject=subject,
        template=template,
        body_text=body,
        provider=provider.name,
        status="queued",
    )
    db.add(record)
    db.flush()

    if deliver_async:
        from app.services import jobs

        jobs.enqueue(
            db,
            organization_id=organization_id,
            job_type=EMAIL_JOB,
            payload={"message_id": record.id},
            idempotency_key=f"email:{record.id}",
            max_attempts=5,
            commit=False,
        )
        return record

    _apply_result(record, provider.send(_mime(to, subject, body)), provider.name)
    return record


_SECRET_RE = re.compile(r"(token=)[A-Za-z0-9_\-]+")


def redact_secrets(text: str) -> str:
    """Remove one-time tokens (reset, verification, invitation links) so the
    outbox table never holds usable credentials."""
    return _SECRET_RE.sub(r"\1[redacted]", text)


def _apply_result(record: EmailMessage, result: EmailDeliveryResult, provider_name: str) -> None:
    # Once a message is final (delivered, logged or failed) the stored copy is
    # only an audit trail; tokens inside it are redacted.
    record.body_text = redact_secrets(record.body_text)
    record.provider = provider_name
    record.status = result.status
    record.error = result.error
    record.preview_path = result.preview_path
    record.sent_at = utc_now() if result.status == "sent" else None


EMAIL_JOB = "email_delivery"


def _register_job() -> None:
    from app.services import jobs

    def on_failure(db: Session, ctx: "jobs.JobContext", message: str) -> None:
        record = db.get(EmailMessage, ctx.payload.get("message_id"))
        if record is not None and record.status != "sent":
            record.status = "failed"
            record.error = message[:2000]
            record.body_text = redact_secrets(record.body_text)

    @jobs.job_handler(EMAIL_JOB, on_failure=on_failure)
    def deliver_email(db: Session, ctx: "jobs.JobContext") -> dict:
        record = db.get(EmailMessage, ctx.payload.get("message_id"))
        if record is None:
            raise jobs.PermanentJobError("Email message not found")
        if record.status in ("sent", "logged"):
            return {"skipped": record.status}
        provider = get_email_provider()
        result = provider.send(_mime(record.to_email, record.subject, record.body_text))
        if result.status == "failed":
            record.error = result.error
            db.commit()
            # Raising lets the job runner retry with exponential backoff.
            raise RuntimeError(result.error or "Email delivery failed")
        _apply_result(record, result, provider.name)
        return {"status": record.status}


_register_job()


def frontend_link(path: str) -> str:
    return settings.frontend_url.rstrip("/") + path
