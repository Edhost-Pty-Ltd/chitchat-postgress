"""
Encryption + feature math for the FaceAISDK-powered service.

Nothing here depends on InsightFace or any other heavy ML wheel. The device SDK
already extracted a fixed-length reference feature; the server's job is to
keep it encrypted at rest and to compute cosine similarity on the raw bytes.

Encryption uses ``MultiFernet`` built from ``settings.FERNET_KEYS``. The FIRST
key encrypts new data; ALL keys can decrypt — standard key rotation. We NEVER
generate a key at startup (that would make existing data undecryptable) and
NEVER fall back to plaintext. Missing/invalid keys raise
``EncryptionNotConfigured``.
"""

from __future__ import annotations

import base64
import logging
import math
import struct
import threading
from typing import Optional

from cryptography.fernet import Fernet, MultiFernet
from django.conf import settings

logger = logging.getLogger("accounts.face_engine")


class EncryptionNotConfigured(RuntimeError):
    pass


class InvalidFaceFeature(ValueError):
    pass


# ── Encryption ────────────────────────────────────────────────────────────────
_cipher: Optional[MultiFernet] = None
_cipher_lock = threading.Lock()


def get_cipher() -> MultiFernet:
    """Return the process-wide MultiFernet. Raises if no keys are configured."""
    global _cipher
    if _cipher is not None:
        return _cipher
    with _cipher_lock:
        if _cipher is not None:
            return _cipher
        keys = getattr(settings, "FERNET_KEYS", None) or []
        if not keys:
            raise EncryptionNotConfigured(
                "FERNET_KEYS is empty — refusing to encrypt/store biometric data. "
                "Generate a key and set FERNET_KEYS (see .env.example)."
            )
        try:
            fernets = [Fernet(k.encode() if isinstance(k, str) else k) for k in keys]
        except Exception as exc:  # invalid key material
            raise EncryptionNotConfigured(f"Invalid FERNET_KEYS value: {exc}") from exc
        _cipher = MultiFernet(fernets)
        return _cipher


def current_key_version() -> int:
    """Index of the key used to ENCRYPT new data (always the first key)."""
    return 0


def encrypt_bytes(data: bytes) -> bytes:
    return get_cipher().encrypt(data)


def decrypt_bytes(token: bytes) -> bytes:
    return get_cipher().decrypt(token)


# ── Feature validation and matching ───────────────────────────────────────────
def validate_feature(face_feature: object) -> str:
    """Return the normalised feature string or raise InvalidFaceFeature.

    The SDK ships a fixed-length string on both platforms. We accept exactly
    that length and nothing else — a shorter payload is a client bug or an
    attempted injection and must not be stored.
    """
    expected = getattr(settings, "FACE_FEATURE_LENGTH", 1024)
    if not isinstance(face_feature, str):
        raise InvalidFaceFeature("Face feature must be a string")
    if len(face_feature) != expected:
        raise InvalidFaceFeature(
            f"Face feature must be exactly {expected} chars, got {len(face_feature)}"
        )
    # The SDK packs float data into the string. We don't need to interpret the
    # encoding here — we only need deterministic bytes for cosine math and the
    # Fernet envelope. Reject payloads containing control characters or NULs so
    # a malicious client cannot sneak binary garbage past the length check.
    for ch in face_feature:
        if ord(ch) < 0x20 or ord(ch) == 0x7F:
            raise InvalidFaceFeature("Face feature contains control characters")
    return face_feature


def decode_feature_vector(face_feature: str) -> list[float]:
    """Decode the SDK's feature string into its float32 embedding.

    The FaceAISDK returns an L2-normalised float32 face embedding encoded as a
    base64url string (1024 chars → 768 bytes → 192 float32 values). Identity
    comparison MUST be done on these decoded vectors.

    Comparing the raw base64 *text* bytes instead (as an earlier version did)
    is NOT a valid match: the base64 alphabet is all-positive printable bytes,
    so two different people score a ~0.95 cosine. On the decoded vectors the
    same person scores ~1.0 and different people ~0.1.
    """
    padded = face_feature + "=" * (-len(face_feature) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded)
    except Exception as exc:
        raise InvalidFaceFeature(f"Feature is not valid base64url: {exc}") from exc
    if len(raw) < 4 or len(raw) % 4 != 0:
        raise InvalidFaceFeature("Feature byte length is not a multiple of 4")
    n = len(raw) // 4
    return list(struct.unpack("<%df" % n, raw))


def cosine_similarity(a: str, b: str) -> float:
    """Cosine similarity between two SDK feature embeddings.

    Decodes each base64url feature to its float32 vector and compares those.
    Same person ≈ 1.0, different people ≈ 0.0. Raises InvalidFaceFeature when a
    payload cannot be decoded or the dimensionalities differ.
    """
    va = decode_feature_vector(a)
    vb = decode_feature_vector(b)
    if len(va) != len(vb):
        raise InvalidFaceFeature("Face feature dimensionality mismatch")
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(va, vb):
        dot += x * y
        na += x * x
        nb += y * y
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


def readiness() -> dict:
    """Encryption readiness only — this service has no model to warm up."""
    enc_ok = False
    enc_err = None
    try:
        get_cipher()
        enc_ok = True
    except Exception as exc:
        enc_err = str(exc)
    return {
        "encryption_ok": enc_ok,
        "encryption_error": enc_err,
        # Kept so existing health-check consumers keep working. The on-device
        # SDK is the model, so from the server's perspective it is always ready.
        "model_ok": True,
        "model_error": None,
    }
