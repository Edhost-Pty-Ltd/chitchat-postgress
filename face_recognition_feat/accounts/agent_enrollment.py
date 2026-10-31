"""Node↔Django signed capabilities for admin-assisted agent enrollment.

Node authorizes the business manager and target Firebase UID. Django atomically
consumes the one-time grant before any face work, stores only an encrypted
embedding, then mints a completion receipt that Node verifies before activating
the membership. The app carries signed values; it cannot choose the target or
mark enrollment complete by itself.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone as django_timezone

from .models import AdminAgentEnrollmentGrant


class AgentEnrollmentTokenError(Exception):
    def __init__(self, code: str = "agent_grant_invalid", message: str = ""):
        super().__init__(message or code)
        self.code = code


@dataclass
class ConsumedAgentEnrollmentGrant:
    payload: dict
    record: AdminAgentEnrollmentGrant
    # A duplicate delivery of a previously successful request can reuse the
    # still-valid stored receipt without repeating model/S3 work.
    has_stored_completion: bool = False


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _decode_b64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _secret() -> bytes:
    value = settings.AGENT_FACE_ENROLLMENT_SECRET
    if not value or len(value.encode("utf-8")) < 32:
        raise AgentEnrollmentTokenError(
            "agent_grant_not_configured",
            "Agent enrollment handoff is unavailable",
        )
    return value.encode("utf-8")


def _verify_grant(token: str) -> dict:
    if not isinstance(token, str) or len(token) > 4096:
        raise AgentEnrollmentTokenError()
    parts = token.split(".")
    if len(parts) != 2 or not all(parts):
        raise AgentEnrollmentTokenError()
    encoded, encoded_signature = parts
    try:
        supplied = _decode_b64url(encoded_signature)
    except Exception:
        raise AgentEnrollmentTokenError()
    expected = hmac.new(_secret(), encoded.encode("ascii"), hashlib.sha256).digest()
    if len(supplied) != len(expected) or not hmac.compare_digest(supplied, expected):
        raise AgentEnrollmentTokenError()
    try:
        payload = json.loads(_decode_b64url(encoded).decode("utf-8"))
    except Exception:
        raise AgentEnrollmentTokenError()

    required = {
        "v", "purpose", "managerId", "agentId", "businessId", "jti", "iat", "exp"
    }
    if not isinstance(payload, dict) or set(payload) != required:
        raise AgentEnrollmentTokenError()
    if payload.get("v") != 1 or payload.get("purpose") != "admin_assisted_agent_enrollment_grant":
        raise AgentEnrollmentTokenError()
    for name in ("managerId", "agentId"):
        if not isinstance(payload.get(name), str) or not (1 <= len(payload[name]) <= 128):
            raise AgentEnrollmentTokenError()
    try:
        payload["businessId"] = str(uuid.UUID(str(payload["businessId"])))
        payload["jti"] = str(uuid.UUID(str(payload["jti"])))
        payload["iat"] = int(payload["iat"])
        payload["exp"] = int(payload["exp"])
    except (TypeError, ValueError, AttributeError):
        raise AgentEnrollmentTokenError()

    now = int(time.time())
    if (
        payload["iat"] > now + 30
        or payload["exp"] <= now
        or payload["exp"] <= payload["iat"]
        or payload["exp"] - payload["iat"] > 900
    ):
        raise AgentEnrollmentTokenError("agent_grant_expired", "Enrollment grant expired")
    return payload


def _matches(record: AdminAgentEnrollmentGrant, payload: dict, expires_at: datetime) -> bool:
    return (
        record.manager_external_user_id == payload["managerId"]
        and record.agent_external_user_id == payload["agentId"]
        and record.business_id == payload["businessId"]
        and record.expires_at == expires_at
    )


def consume_agent_enrollment_grant(
    grant: str, manager_external_user_id: str
) -> ConsumedAgentEnrollmentGrant:
    """Verify and atomically consume one grant, safely handling race losers."""
    payload = _verify_grant(grant)
    if payload["managerId"] != manager_external_user_id:
        raise AgentEnrollmentTokenError("agent_grant_invalid", "Grant owner mismatch")

    expires_at = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
    grant_id = uuid.UUID(payload["jti"])
    with transaction.atomic():
        try:
            record = AdminAgentEnrollmentGrant.objects.select_for_update().get(id=grant_id)
        except AdminAgentEnrollmentGrant.DoesNotExist:
            # A nested atomic block is a savepoint. If another request wins the
            # unique-PK race, the outer transaction stays usable for the lock/read.
            try:
                with transaction.atomic():
                    AdminAgentEnrollmentGrant.objects.create(
                        id=grant_id,
                        manager_external_user_id=payload["managerId"],
                        agent_external_user_id=payload["agentId"],
                        business_id=payload["businessId"],
                        expires_at=expires_at,
                    )
            except IntegrityError:
                pass
            record = AdminAgentEnrollmentGrant.objects.select_for_update().get(id=grant_id)

        if not _matches(record, payload, expires_at):
            raise AgentEnrollmentTokenError()
        now = django_timezone.now()
        if record.expires_at <= now:
            raise AgentEnrollmentTokenError("agent_grant_expired", "Enrollment grant expired")
        if record.consumed_at is not None:
            if (
                record.completion_receipt
                and record.completion_receipt_expires_at
                and record.completion_receipt_expires_at > now
            ):
                return ConsumedAgentEnrollmentGrant(payload, record, True)
            raise AgentEnrollmentTokenError("agent_grant_used", "Enrollment grant already used")

        record.consumed_at = now
        record.save(update_fields=["consumed_at"])
        return ConsumedAgentEnrollmentGrant(payload, record, False)


def mint_agent_enrollment_receipt(payload: dict) -> tuple[str, str, datetime]:
    """Create a short-lived receipt Node accepts to activate the roster entry."""
    now = int(time.time())
    ttl = max(30, min(int(settings.AGENT_FACE_ENROLLMENT_RECEIPT_TTL_SEC), 300))
    exp = now + ttl
    completion = {
        "v": 1,
        "purpose": "admin_assisted_agent_enrollment_complete",
        "managerId": payload["managerId"],
        "agentId": payload["agentId"],
        "businessId": payload["businessId"],
        "grantId": payload["jti"],
        "jti": str(uuid.uuid4()),
        "iat": now,
        "exp": exp,
    }
    encoded = _b64url(
        json.dumps(completion, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    signature = hmac.new(_secret(), encoded.encode("ascii"), hashlib.sha256).digest()
    expires_at = datetime.fromtimestamp(exp, tz=timezone.utc)
    return f"{encoded}.{_b64url(signature)}", expires_at.isoformat(), expires_at


def record_agent_enrollment_completion(
    record: AdminAgentEnrollmentGrant,
    receipt: str,
    receipt_expires_at: datetime,
) -> None:
    """Persist a short-lived retry receipt without storing any biometric data."""
    AdminAgentEnrollmentGrant.objects.filter(id=record.id).update(
        completion_receipt=receipt,
        completion_receipt_expires_at=receipt_expires_at,
        enrollment_succeeded_at=django_timezone.now(),
    )
