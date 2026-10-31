"""Manager-authorized, no-liveness agent face enrollment.

A signed Node grant binds manager, business, and agent Firebase UID. The normal
self-enrollment and reported-account flows remain unchanged. This path stores
only a first encrypted reference feature; it never overwrites an existing
self/admin enrollment. Existing immutable profiles can be reconciled into a new
manager receipt so a lost mobile completion response never strands a valid
agent membership.

Since migrating to @faceaisdk/react-native-face-sdk the admin's device extracts
the feature directly from the chosen photo via ``addFaceByImage``. The server
therefore receives a 1024-char feature, never a raw image.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from django.db import transaction

from . import agent_enrollment, storage
from .face_engine import (
    InvalidFaceFeature,
    current_key_version,
    encrypt_bytes,
    validate_feature,
)
from .face_service import ServiceError, _object_key
from .models import FaceProfile

logger = logging.getLogger("accounts.agent_service")


@dataclass
class AdminAgentEnrollmentResult:
    ok: bool
    completion_receipt: str
    receipt_expires_at: str
    agent_external_user_id: str
    business_id: str
    reconciled: bool = False


def _result_from_receipt(state, receipt: str, expires_at: str, reconciled: bool):
    return AdminAgentEnrollmentResult(
        ok=True,
        completion_receipt=receipt,
        receipt_expires_at=expires_at,
        agent_external_user_id=state.payload["agentId"],
        business_id=state.payload["businessId"],
        reconciled=reconciled,
    )


def enroll_agent_face_admin_assisted(
    manager_external_user_id: str,
    grant: str,
    face_feature: object = None,
) -> AdminAgentEnrollmentResult:
    """Create or reconcile an immutable agent face profile from a feature string."""
    state = agent_enrollment.consume_agent_enrollment_grant(
        grant, manager_external_user_id
    )
    payload = state.payload
    agent_id = payload["agentId"]

    if state.has_stored_completion:
        return _result_from_receipt(
            state,
            state.record.completion_receipt,
            state.record.completion_receipt_expires_at.isoformat(),
            reconciled=True,
        )

    existing = FaceProfile.objects.filter(external_user_id=agent_id).first()
    (
        receipt,
        receipt_expires_at,
        receipt_expires_at_dt,
    ) = agent_enrollment.mint_agent_enrollment_receipt(payload)

    if existing:
        # Reconcile only: same agent target came from a fresh business-manager
        # grant. We never alter the stored feature, object key, or method.
        agent_enrollment.record_agent_enrollment_completion(
            state.record, receipt, receipt_expires_at_dt
        )
        return _result_from_receipt(state, receipt, receipt_expires_at, reconciled=True)

    if face_feature is None:
        raise ServiceError("empty_feature", "No face feature provided")
    try:
        feature = validate_feature(face_feature)
    except InvalidFaceFeature as exc:
        raise ServiceError("bad_feature", str(exc))

    ciphertext = encrypt_bytes(feature.encode("latin-1"))
    object_key = _object_key(agent_id)
    storage.put_embedding(object_key, ciphertext)

    try:
        with transaction.atomic():
            if FaceProfile.objects.select_for_update().filter(
                external_user_id=agent_id
            ).exists():
                # A concurrent successful path created an immutable reference.
                raise ServiceError("already_enrolled", "Agent already has a face reference")
            FaceProfile.objects.create(
                external_user_id=agent_id,
                embedding_object_key=object_key,
                key_version=current_key_version(),
                feature_length=len(feature),
                enrollment_method="admin_assisted",
                enrolled_by_external_user_id=manager_external_user_id,
                enrollment_business_id=payload["businessId"],
                enrolled_with_liveness=False,
            )
    except ServiceError:
        storage.delete_embedding(object_key)
        raise
    except Exception:
        storage.delete_embedding(object_key)
        logger.exception("Agent enrollment DB write failed; cleaned up S3 object")
        raise ServiceError("enrollment_failed", "Could not complete agent enrollment")

    agent_enrollment.record_agent_enrollment_completion(
        state.record, receipt, receipt_expires_at_dt
    )
    return _result_from_receipt(state, receipt, receipt_expires_at, reconciled=False)
