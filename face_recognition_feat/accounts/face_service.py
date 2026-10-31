"""
Enrollment + reported-account verification service.

FaceAISDK on the device runs motion/silent liveness and returns a fixed-length
SDK feature plus the captured face image. This service:

  • Encrypts the SDK feature with Fernet and keeps it in a private S3 object,
    so another device of the same Firebase UID can restore it.
  • Runs InsightFace on the liveness-verified face image at enrollment and
    stores the resulting ArcFace embedding as a second encrypted object. The
    image itself is processed in memory and never stored.
  • For reported-account recovery, runs InsightFace on the fresh live image and
    compares it with the stored ArcFace embedding. Profiles without an ArcFace
    reference fall back to comparing the decoded SDK features. A short-lived
    HMAC receipt is minted only when the SDK liveness verdict and the
    server-side match both pass.

The service never trusts a client-asserted "matched" boolean.
"""

from __future__ import annotations

import logging
import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Optional

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from . import insightface_engine, receipts, storage
from .face_engine import (
    EncryptionNotConfigured,
    InvalidFaceFeature,
    cosine_similarity,
    current_key_version,
    decrypt_bytes,
    encrypt_bytes,
    validate_feature,
)
from .insightface_engine import (
    InsightFaceError,
    InsightFaceNotInstalled,
    NoFaceDetected,
)
from .models import FaceProfile

logger = logging.getLogger("accounts.face_service")


class ServiceError(Exception):
    """Carries a stable machine code returned to the view layer."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


@dataclass
class EnrollResult:
    ok: bool
    error: Optional[str] = None


@dataclass
class FeatureRestoreResult:
    enrolled: bool
    face_feature: Optional[str] = None


@dataclass
class LivenessVerifyResult:
    ok: bool
    matched: bool = False
    error: Optional[str] = None
    hint: Optional[str] = None
    receipt: Optional[str] = None
    receipt_expires_at: Optional[str] = None
    verified_at: Optional[str] = None
    # Cosine similarity (0..1) between the live face and the stored reference.
    # Surfaced for diagnostics so a rejection can be explained.
    match_score: Optional[float] = None
    # The threshold the match was judged against and which engine produced the
    # score ("insightface" or "sdk_cosine"). Diagnostics only.
    match_threshold: Optional[float] = None
    match_engine: Optional[str] = None


def _object_key(external_user_id: str) -> str:
    prefix = settings.FACE_S3_PREFIX.strip("/")
    return f"{prefix}/{external_user_id}/{uuid.uuid4().hex}.enc"


def _arcface_object_key(external_user_id: str) -> str:
    prefix = settings.FACE_S3_PREFIX.strip("/")
    return f"{prefix}/{external_user_id}/arcface-{uuid.uuid4().hex}.enc"


def _store_arcface_reference(external_user_id: str, image: object) -> tuple[str, int, int]:
    """Compute an ArcFace embedding from an enrollment image and store it
    encrypted. Returns (object_key, key_version, dim).

    Raises ServiceError with a stable code the view layer maps to HTTP:
      • insightface_unavailable  → model/wheels not ready (503)
      • no_face_detected         → image had no usable single face (422)
      • arcface_failed           → decode/inference failure (500)
    """
    try:
        emb = insightface_engine.embedding_from_image(image)
    except InsightFaceNotInstalled as exc:
        logger.error("ArcFace enrollment blocked: %s", exc)
        raise ServiceError("insightface_unavailable", str(exc))
    except NoFaceDetected as exc:
        raise ServiceError("no_face_detected", str(exc))
    except InsightFaceError as exc:
        logger.error("ArcFace embedding failed during enrollment: %s", exc)
        raise ServiceError("arcface_failed", "Could not read a face from the image")

    ciphertext = encrypt_bytes(insightface_engine.embedding_to_bytes(emb))
    key = _arcface_object_key(external_user_id)
    storage.put_embedding(key, ciphertext)
    return key, current_key_version(), int(emb.shape[0])


def _load_arcface_reference(profile: FaceProfile):
    """Decrypt and return the stored ArcFace embedding, or None when the
    profile has no ArcFace reference (legacy SDK-only enrollment) or it is
    unreadable."""
    if not profile.arcface_object_key:
        return None
    ciphertext = storage.get_embedding(profile.arcface_object_key)
    if ciphertext is None:
        logger.error("ArcFace reference object missing for a profile")
        return None
    try:
        raw = decrypt_bytes(ciphertext)
        return insightface_engine.embedding_from_bytes(raw)
    except Exception:
        logger.error("Stored ArcFace reference could not be decrypted/decoded")
        return None


SDK_CODE_VERIFY_SUCCESS = 1
SDK_CODE_VERIFY_FAILED = 2  # live person, but did not match the enrolled reference
SDK_CODE_ALL_LIVENESS_SUCCESS = 10


def _accept_sdk_liveness(code: int, score: float) -> bool:
    """SDK verdict acceptance policy. Centralised so settings override is cheap.

    Only verdicts that indicate the SDK saw a live person are accepted:
    code=1 (verify + liveness pass) and code=10 (standalone liveness pass).
    code=2 (live person, no match) is NOT accepted here — it is handled by the
    caller as ``matched:false`` so the user sees a clear "face did not match"
    message rather than a vague liveness error.
    """
    accepted = getattr(
        settings, "FACE_ACCEPTED_LIVENESS_CODES", {1, 10}
    )
    min_score = float(getattr(settings, "FACE_MIN_LIVENESS_SCORE", 0.0))
    if code not in accepted:
        return False
    # code=1 (verify success) doesn't need a non-zero liveness score, because
    # the SDK's motion/silent liveness runs BEFORE the match; failing those
    # yields a different code. code=10 is the SDK's definitive "all liveness
    # steps passed" verdict; the numeric score is advisory, so enforce the floor
    # only when a positive score is actually reported (some SDK builds return 0
    # for a pass, which must not be rejected).
    if code == 10 and 0.0 < score < min_score:
        return False
    return True


# ── Enrollment ───────────────────────────────────────────────────────────────
def store_enrollment(
    external_user_id: str,
    face_feature: str,
    liveness_score: float = 0.0,
    liveness_code: int = 1,
    sdk_version: str = "",
    enrollment_method: str = "self_liveness",
    enrolled_by_external_user_id: str = "",
    enrollment_business_id: str = "",
    enrollment_image: object = None,
) -> EnrollResult:
    """Encrypt and persist a reference feature.

    An existing immutable reference is never replaced through this path. Report
    recovery and admin-assisted enrollment have their own code paths with their
    own authority. See ``agent_service`` for admin-assisted.

    When ``enrollment_image`` (base64 face image) is supplied, an InsightFace
    ArcFace embedding is computed server-side from it and stored as a SECOND
    encrypted object. That becomes the authoritative identity reference for
    reported-account recovery. If InsightFace is unavailable, the SDK feature is
    still stored (the recovery path then falls back to the SDK cosine), so a
    missing model never blocks enrollment.
    """
    try:
        feature = validate_feature(face_feature)
    except InvalidFaceFeature as exc:
        raise ServiceError("bad_feature", str(exc))

    # SDK liveness must agree the live person was confirmed. Admin-assisted
    # enrollment calls this helper with its own method name and skips liveness
    # explicitly; everything else must present an accepted SDK code.
    if enrollment_method == "self_liveness":
        if not _accept_sdk_liveness(liveness_code, liveness_score):
            raise ServiceError(
                "liveness_rejected",
                "The on-device liveness verdict was not accepted",
            )

    if FaceProfile.objects.filter(external_user_id=external_user_id).exists():
        raise ServiceError("already_enrolled", "A face reference already exists")

    ciphertext = encrypt_bytes(feature.encode("latin-1"))
    new_key = _object_key(external_user_id)
    storage.put_embedding(new_key, ciphertext)

    # Best-effort ArcFace reference. A face-detection failure on the enrollment
    # image IS fatal (the user must present a usable face), but the model simply
    # being unavailable degrades gracefully to the SDK path.
    arcface_key = ""
    arcface_version = 0
    arcface_dim = 0
    if enrollment_image:
        try:
            arcface_key, arcface_version, arcface_dim = _store_arcface_reference(
                external_user_id, enrollment_image
            )
        except ServiceError as exc:
            if exc.code == "insightface_unavailable":
                logger.warning(
                    "InsightFace unavailable at enrollment; storing SDK feature only"
                )
            else:
                storage.delete_embedding(new_key)
                raise

    try:
        with transaction.atomic():
            if FaceProfile.objects.select_for_update().filter(
                external_user_id=external_user_id
            ).exists():
                raise ServiceError("already_enrolled", "A face reference already exists")
            FaceProfile.objects.create(
                external_user_id=external_user_id,
                embedding_object_key=new_key,
                key_version=current_key_version(),
                feature_length=len(feature),
                sdk_version=sdk_version[:32],
                liveness_code=liveness_code,
                liveness_score=max(0.0, min(1.0, float(liveness_score))),
                enrolled_with_liveness=enrollment_method == "self_liveness",
                enrollment_method=enrollment_method,
                enrolled_by_external_user_id=enrolled_by_external_user_id,
                enrollment_business_id=enrollment_business_id,
                arcface_object_key=arcface_key,
                arcface_key_version=arcface_version,
                arcface_dim=arcface_dim,
            )
    except ServiceError:
        storage.delete_embedding(new_key)
        if arcface_key:
            storage.delete_embedding(arcface_key)
        raise
    except Exception:
        storage.delete_embedding(new_key)
        if arcface_key:
            storage.delete_embedding(arcface_key)
        logger.exception("Enrollment DB write failed; cleaned up S3 object")
        raise ServiceError("enrollment_failed", "Could not complete enrollment")

    return EnrollResult(ok=True)


# ── Self registration (enrollment + live verification → signed receipt) ─────
@dataclass
class RegistrationEnrollResult:
    ok: bool
    receipt: Optional[str] = None
    receipt_expires_at: Optional[str] = None
    reconciled: bool = False


def register_self_enrollment(
    external_user_id: str,
    face_feature: str,
    liveness_code: int,
    liveness_score: float = 0.0,
    sdk_version: str = "",
    enrollment_image: object = None,
) -> RegistrationEnrollResult:
    """Store a new user's reference and mint the receipt Node needs to create
    the account.

    The client sends the 1024-char feature from the SDK enrollment and the
    verdict of the SDK's 1:1 ``faceVerify`` run against that enrollment.
    Only code 1 is accepted: motion + silent anti-spoofing passed AND the live
    face matched the just-enrolled reference.

    Idempotent per uid. If a self-enrolled reference already exists (the user
    retried after Node registration failed), the stored reference is kept
    unchanged and a fresh receipt is minted, so a dropped response can never
    strand an account half-created.
    """
    try:
        feature = validate_feature(face_feature)
    except InvalidFaceFeature as exc:
        raise ServiceError("bad_feature", str(exc))
    if liveness_code != SDK_CODE_VERIFY_SUCCESS:
        raise ServiceError(
            "liveness_rejected",
            "Registration requires a passed live face verification",
        )

    def _is_self_enrolled(profile) -> bool:
        return (
            profile is not None
            and profile.enrollment_method == "self_liveness"
            and profile.enrolled_with_liveness
        )

    existing = FaceProfile.objects.filter(external_user_id=external_user_id).first()
    reconciled = existing is not None
    if existing is not None and not _is_self_enrolled(existing):
        # e.g. an admin-assisted agent reference: not a self-registration.
        raise ServiceError("already_enrolled", "A face reference already exists")
    if existing is None:
        try:
            store_enrollment(
                external_user_id,
                feature,
                liveness_score=liveness_score,
                liveness_code=liveness_code,
                sdk_version=sdk_version,
                enrollment_method="self_liveness",
                enrollment_image=enrollment_image,
            )
        except ServiceError as exc:
            if exc.code != "already_enrolled":
                raise
            # A concurrent request stored it first; reconcile the same way.
            raced = FaceProfile.objects.filter(external_user_id=external_user_id).first()
            if not _is_self_enrolled(raced):
                raise
            reconciled = True

    try:
        receipt, receipt_expires_at = receipts.mint_registration_receipt(external_user_id)
    except receipts.ReceiptConfigurationError as exc:
        logger.error("Cannot mint registration receipt: %s", exc)
        raise ServiceError("receipt_not_configured", "Registration handoff unavailable")

    return RegistrationEnrollResult(
        ok=True,
        receipt=receipt,
        receipt_expires_at=receipt_expires_at,
        reconciled=reconciled,
    )


# ── Feature restore (cross-device) ───────────────────────────────────────────
def fetch_enrollment_feature(external_user_id: str) -> FeatureRestoreResult:
    """Decrypt and return the stored reference feature.

    Called when a user signs in on a fresh device: the SDK has no local
    reference, so the client calls this and immediately ``insertFaceFeature``s
    the result into the SDK's secure store.
    """
    profile = FaceProfile.objects.filter(external_user_id=external_user_id).first()
    if not profile:
        return FeatureRestoreResult(enrolled=False)
    ciphertext = storage.get_embedding(profile.embedding_object_key)
    if ciphertext is None:
        logger.error("Stored feature object missing for a profile")
        raise ServiceError("reference_unreadable", "Encrypted reference is unavailable")
    try:
        plain = decrypt_bytes(ciphertext).decode("latin-1")
        validate_feature(plain)
    except Exception:
        logger.error("Stored feature could not be decrypted or validated")
        raise ServiceError("reference_unreadable", "Encrypted reference is unreadable")
    return FeatureRestoreResult(enrolled=True, face_feature=plain)


# ── Match computation (InsightFace preferred, SDK cosine fallback) ───────────
def _compute_match(
    profile: FaceProfile,
    face_feature: str,
    live_image: object,
) -> tuple[float, str, float]:
    """Return (match_score, engine, threshold).

    ``engine`` is "insightface" or "sdk_cosine". Raises ServiceError with a
    stable code on a recoverable failure (``no_face_detected``,
    ``arcface_failed``, ``insightface_unavailable``, ``bad_feature``,
    ``reference_unreadable``).
    """
    arcface_ref = _load_arcface_reference(profile)

    # ── Preferred path: InsightFace on the live image. ───────────────────────
    if live_image and arcface_ref is not None:
        try:
            live_emb = insightface_engine.embedding_from_image(live_image)
        except InsightFaceNotInstalled as exc:
            # Model not installed: fall through to SDK cosine if we can, else
            # surface a clear unavailable error.
            logger.warning("InsightFace unavailable during verify: %s", exc)
            if _has_sdk_reference(profile):
                return _sdk_cosine_match(profile, face_feature)
            raise ServiceError("insightface_unavailable", str(exc))
        except NoFaceDetected as exc:
            raise ServiceError("no_face_detected", str(exc))
        except InsightFaceError as exc:
            logger.error("InsightFace inference failed during verify: %s", exc)
            raise ServiceError("arcface_failed", "Could not read a face from the image")

        score = insightface_engine.cosine_similarity(live_emb, arcface_ref)
        threshold = float(getattr(settings, "INSIGHTFACE_MATCH_THRESHOLD", 0.42))
        return score, "insightface", threshold

    # ── Fallback: SDK cosine on the two 1024-char features. ──────────────────
    # Covers legacy profiles (no ArcFace reference) and callers that did not
    # send an image (older app builds), preserving existing behaviour.
    return _sdk_cosine_match(profile, face_feature)


def _has_sdk_reference(profile: FaceProfile) -> bool:
    return bool(profile.embedding_object_key)
def _is_recovery_eligible(profile: FaceProfile) -> bool:
    """Whether this profile can be used as an account-recovery anchor.

    - ``self_liveness``  — always eligible; the owner proved the face live at
      enrollment, so a live match at recovery time is enough.
    - ``admin_assisted`` — eligible only when
      ``settings.FACE_ALLOW_ADMIN_ASSISTED_RECOVERY`` is True. The face was
      vouched for by a manager rather than proven live by the agent, so
      recovery is opt-in. Even when enabled, liveness + server-side match
      still run on every attempt.
    - anything else (legacy / unknown) — not eligible.
    """
    if profile.enrollment_method == "self_liveness":
        return bool(profile.enrolled_with_liveness)
    if profile.enrollment_method == "admin_assisted":
        return bool(getattr(settings, "FACE_ALLOW_ADMIN_ASSISTED_RECOVERY", False))
    return False
    

def _sdk_cosine_match(profile: FaceProfile, face_feature: str) -> tuple[float, str, float]:
    ciphertext = storage.get_embedding(profile.embedding_object_key)
    if ciphertext is None:
        logger.error("Stored feature object missing during verify")
        raise ServiceError("reference_unreadable", "Encrypted reference unavailable")
    try:
        stored_feature = decrypt_bytes(ciphertext).decode("latin-1")
        score = cosine_similarity(face_feature, stored_feature)
    except InvalidFaceFeature:
        raise ServiceError("bad_feature", "Face feature could not be decoded")
    except Exception:
        logger.error("Stored feature unreadable during verify")
        raise ServiceError("reference_unreadable", "Encrypted reference unreadable")
    threshold = float(getattr(settings, "FACE_MATCH_THRESHOLD", 0.5))
    return score, "sdk_cosine", threshold


# ── Reported-account recovery (SDK liveness + server-side identity match) ────
def verify_reported_account(
    external_user_id: str,
    report_generation: str,
    face_feature: str,
    liveness_score: float,
    liveness_code: int,
    live_image: object = None,
) -> LivenessVerifyResult:
    """Mint a signed receipt when the SDK liveness verdict AND the server-side
    identity match both agree.

    The MATCH is computed on the server, from the actual live face:
      • Preferred: InsightFace. When a ``live_image`` is supplied and the
        profile has a stored ArcFace reference, the server computes the ArcFace
        embedding of the live image and compares it to the stored ArcFace
        embedding. This is authoritative — the client cannot assert the match.
      • Fallback: SDK cosine. For profiles enrolled before InsightFace (no
        ArcFace reference) or when no image is supplied, the server falls back
        to decoding the two 1024-char SDK features and comparing those, exactly
        as before, so existing users are never locked out.

    Never replaces the stored reference. Replay protection comes from Node:
    receipts are bound to the current ``report_generation`` and any new report
    rotates it, invalidating in-flight receipts.

    Recovery anchors:
      • ``self_liveness``   — always eligible (owner proved the face live at
        enrollment).
      • ``admin_assisted``  — eligible only when
        ``settings.FACE_ALLOW_ADMIN_ASSISTED_RECOVERY`` is True. When enabled,
        the agent can recover their own account by presenting their own live
        face; liveness + server-side match still run on every attempt.
    """
    try:
        generation = str(uuid.UUID(str(report_generation)))
    except (ValueError, TypeError, AttributeError):
        raise ServiceError("report_generation_invalid", "Invalid report generation")

    try:
        _ = validate_feature(face_feature)
    except InvalidFaceFeature as exc:
        raise ServiceError("bad_feature", str(exc))

    max_fail = settings.FACE_MAX_FAILED_ATTEMPTS

    with transaction.atomic():
        try:
            profile = FaceProfile.objects.select_for_update().get(
                external_user_id=external_user_id
            )
        except FaceProfile.DoesNotExist:
            return LivenessVerifyResult(
                ok=False,
                error="not_enrolled",
                hint="Set up identity verification before account recovery is needed.",
            )

        # Recovery eligibility. See _is_recovery_eligible for the policy.
        # Admin-assisted profiles are allowed when the setting is on, so an
        # agent can self-verify. Every attempt still requires on-device
        # liveness AND a server-side identity match, so a manager cannot turn
        # an arbitrary face into a working recovery anchor on their own.
        if not _is_recovery_eligible(profile):
            return LivenessVerifyResult(
                ok=False,
                error="reference_not_recovery_eligible",
                hint="This face reference cannot be used for reported-account recovery. Contact support.",
            )

        now = timezone.now()
        if profile.failed_attempts >= max_fail or (
            profile.locked_until and profile.locked_until > now
        ):
            return LivenessVerifyResult(
                ok=False,
                error="locked",
                hint="Contact support to unlock verification.",
            )

        # The SDK proves LIVENESS on-device; this SERVICE proves the MATCH. The
        # client runs a liveness-only check (code=10, or legacy code=1) and
        # sends the captured live image plus an SDK feature extracted from it.
        # The match is computed here (see _compute_match), so a client cannot
        # assert it.
        score = float(liveness_score or 0.0)

        # 1) Liveness gate — trust the on-device anti-spoofing verdict only.
        if not _accept_sdk_liveness(liveness_code, score):
            profile.failed_attempts += 1
            if profile.failed_attempts >= max_fail:
                profile.locked_until = now
            profile.save(
                update_fields=["failed_attempts", "locked_until", "updated_at"]
            )
            return LivenessVerifyResult(ok=False, error="liveness_failed")

        # 2) Match gate — server computes the identity decision.
        #    Preferred: InsightFace on the live image vs the stored ArcFace
        #    reference. Fallback: SDK cosine on the two 1024-char features.
        try:
            match_score, match_engine, threshold = _compute_match(
                profile, face_feature, live_image
            )
        except ServiceError as exc:
            # Decode/model failures become clear, non-fatal verify errors so the
            # user can retry rather than being permanently locked.
            if exc.code in ("no_face_detected", "arcface_failed", "insightface_unavailable"):
                return LivenessVerifyResult(ok=False, error=exc.code, hint=str(exc) or None)
            if exc.code == "bad_feature":
                return LivenessVerifyResult(ok=False, error="bad_feature")
            return LivenessVerifyResult(
                ok=False,
                error="reference_unreadable",
                hint="Your encrypted face reference is unavailable. Contact support.",
            )

        logger.info(
            "reported verify: engine=%s match_score=%.4f (%.1f%%) threshold=%.4f -> %s",
            match_engine,
            match_score,
            match_score * 100.0,
            threshold,
            "match" if match_score >= threshold else "no-match",
        )
        if match_score < threshold:
            # A live person, but not the enrolled owner.
            profile.failed_attempts += 1
            if profile.failed_attempts >= max_fail:
                profile.locked_until = now
            profile.save(
                update_fields=["failed_attempts", "locked_until", "updated_at"]
            )
            return LivenessVerifyResult(
                ok=True,
                matched=False,
                match_score=match_score,
                match_threshold=threshold,
                match_engine=match_engine,
            )

        # 3) Live AND matched → mint the receipt while the row is still locked.
        try:
            # Receipts bind a per-call UUID so a leaked receipt cannot be
            # replayed against a different generation or report.
            call_nonce = str(uuid.uuid4())
            receipt, receipt_expires_at = receipts.mint_report_verification_receipt(
                external_user_id,
                generation,
                call_nonce,
            )
        except receipts.ReceiptConfigurationError as exc:
            logger.error("Cannot mint face verification receipt: %s", exc)
            raise ServiceError(
                "receipt_not_configured", "Verification handoff unavailable"
            )

        profile.failed_attempts = 0
        profile.locked_until = None
        profile.last_verified_at = now
        profile.save(
            update_fields=[
                "failed_attempts",
                "locked_until",
                "last_verified_at",
                "updated_at",
            ]
        )

    return LivenessVerifyResult(
        ok=True,
        matched=True,
        receipt=receipt,
        receipt_expires_at=receipt_expires_at,
        verified_at=now.isoformat(),
        match_score=match_score,
        match_threshold=threshold,
        match_engine=match_engine,
    )

# ── Status / deletion ────────────────────────────────────────────────────────
def enrollment_status(external_user_id: str) -> dict:
    profile = FaceProfile.objects.filter(external_user_id=external_user_id).first()
    if not profile:
        return {"enrolled": False, "locked": False}
    now = timezone.now()
    locked = profile.failed_attempts >= settings.FACE_MAX_FAILED_ATTEMPTS or (
        profile.locked_until is not None and profile.locked_until > now
    )
    return {
        "enrolled": True,
        "locked": locked,
        "last_verified_at": profile.last_verified_at.isoformat()
        if profile.last_verified_at
        else None,
        "enrolled_at": profile.created_at.isoformat() if profile.created_at else None,
    }


def delete_enrollment(external_user_id: str) -> bool:
    """Controlled biometric deletion. Not exposed as a self-service endpoint."""
    profile = FaceProfile.objects.filter(external_user_id=external_user_id).first()
    if not profile:
        return False
    storage.delete_embedding(profile.embedding_object_key)
    if profile.arcface_object_key:
        storage.delete_embedding(profile.arcface_object_key)
    profile.delete()
    return True
