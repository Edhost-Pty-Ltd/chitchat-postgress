"""Short-lived, tamper-evident receipts for reported-user re-verification.

The mobile app is only a courier. Django mints a receipt *after* the on-device
FaceAISDK liveness verdict and the server-side identity match against the
existing encrypted reference (InsightFace, or the SDK-feature cosine fallback
for older profiles) both pass. The Node backend verifies the HMAC and clears
only the exact report generation embedded in the receipt.

This is intentionally a tiny two-segment format rather than a general JWT:
base64url(canonical JSON).base64url(HMAC-SHA256(first segment)). There is no
algorithm field for an attacker to downgrade and no third-party dependency.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid

from django.conf import settings


class ReceiptConfigurationError(RuntimeError):
    pass


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def mint_registration_receipt(external_user_id: str) -> tuple[str, str]:
    """Return ``(receipt, expires_at_iso)`` proving a new user just completed
    on-device face enrollment plus a live 1:1 verification.

    Node's POST /me/register requires this before it creates the account. The
    ``purpose`` literal is distinct from the reported-account receipt, so one
    can never be accepted as the other even though they share a secret.
    """
    secret = settings.FACE_VERIFICATION_RECEIPT_SECRET
    if not secret or len(secret.encode("utf-8")) < 32:
        raise ReceiptConfigurationError(
            "FACE_VERIFICATION_RECEIPT_SECRET must contain at least 32 bytes"
        )

    now = int(time.time())
    ttl = max(30, min(int(settings.FACE_VERIFICATION_RECEIPT_TTL_SEC), 300))
    exp = now + ttl
    payload = {
        "v": 1,
        "sub": external_user_id,
        "purpose": "self_registration_face_enrollment",
        "jti": str(uuid.uuid4()),
        "iat": now,
        "exp": exp,
    }
    encoded = _b64url(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    signature = hmac.new(
        secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256
    ).digest()

    from datetime import datetime, timezone

    expires_at = datetime.fromtimestamp(exp, tz=timezone.utc).isoformat()
    return f"{encoded}.{_b64url(signature)}", expires_at


def mint_report_verification_receipt(
    external_user_id: str,
    report_generation: str,
    call_nonce: str,
) -> tuple[str, str]:
    """Return ``(receipt, expires_at_iso)`` after validating all bound ids.

    ``call_nonce`` is a per-verification UUID chosen by the service. It replaces
    the old server-issued challenge id, which no longer exists now that the SDK
    runs the liveness challenge on-device. Including it means a leaked receipt
    cannot be duplicated for the same generation.
    """
    secret = settings.FACE_VERIFICATION_RECEIPT_SECRET
    if not secret or len(secret.encode("utf-8")) < 32:
        raise ReceiptConfigurationError(
            "FACE_VERIFICATION_RECEIPT_SECRET must contain at least 32 bytes"
        )

    generation = str(uuid.UUID(str(report_generation)))
    nonce = str(uuid.UUID(str(call_nonce)))
    now = int(time.time())
    ttl = max(30, min(int(settings.FACE_VERIFICATION_RECEIPT_TTL_SEC), 300))
    exp = now + ttl
    payload = {
        "v": 1,
        "sub": external_user_id,
        "purpose": "reported_user_reverification",
        "generation": generation,
        # Legacy field name kept so the existing Node receipt verifier accepts
        # the new signed payload unchanged. It is purely a per-call nonce now.
        "challengeId": nonce,
        "jti": str(uuid.uuid4()),
        "iat": now,
        "exp": exp,
    }
    encoded = _b64url(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    signature = hmac.new(
        secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256
    ).digest()

    from datetime import datetime, timezone

    expires_at = datetime.fromtimestamp(exp, tz=timezone.utc).isoformat()
    return f"{encoded}.{_b64url(signature)}", expires_at
