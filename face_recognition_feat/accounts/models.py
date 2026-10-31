"""
Biometric data owned by the standalone face service.

The service never stores a raw face photograph. ``FaceProfile`` holds a private
S3 key for a Fernet-encrypted 1024-char reference feature extracted on-device
by the FaceAISDK, plus operational/audit metadata. User identity lives in
Firebase; the Node/Postgres application owns everything else.
"""

import uuid

from django.db import models


class FaceProfile(models.Model):
    # Firebase UID, resolved only from a verified Firebase token or a signed,
    # purpose-bound Node grant. It is never accepted as a client form field.
    external_user_id = models.CharField(max_length=128, unique=True, db_index=True)

    # Private S3 object containing ONLY the Fernet-encrypted feature bytes.
    embedding_object_key = models.CharField(max_length=512)
    key_version = models.PositiveSmallIntegerField(default=0)

    # Private S3 object holding the Fernet-encrypted InsightFace (ArcFace)
    # 512-d float32 embedding, computed server-side from the enrollment face
    # image. This is the AUTHORITATIVE identity reference: reported-account
    # recovery compares a freshly computed ArcFace embedding of the live image
    # against this, so the match decision is made from the real image on the
    # server — never asserted by the client. Blank when the profile predates
    # InsightFace (legacy SDK-feature-only enrollment); such profiles fall back
    # to the SDK cosine path until re-enrolled.
    arcface_object_key = models.CharField(max_length=512, blank=True, default="")
    arcface_key_version = models.PositiveSmallIntegerField(default=0)
    arcface_dim = models.PositiveSmallIntegerField(default=0)

    # The 1024-char feature extracted by the on-device SDK represents 512 bytes
    # of raw float data. We store that fixed size so the server can cross-check
    # format before touching S3.
    feature_length = models.PositiveSmallIntegerField(default=1024)
    sdk_version = models.CharField(max_length=32, blank=True, default="")

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    last_verified_at = models.DateTimeField(null=True, blank=True)

    failed_attempts = models.PositiveSmallIntegerField(default=0)
    locked_until = models.DateTimeField(null=True, blank=True)

    # Last SDK liveness verdict recorded at enrollment time (audit only).
    #   code = 1 verify success (admin-assisted uses this), 10 all liveness
    #   score = SDK liveness score 0..1
    liveness_code = models.PositiveSmallIntegerField(default=0)
    liveness_score = models.FloatField(default=0.0)
    enrolled_with_liveness = models.BooleanField(default=False)

    # Admin-assisted agent enrollment intentionally does not run SDK liveness,
    # but must remain distinguishable from self enrollment so it cannot be used
    # to clear a reported-account lock.
    enrollment_method = models.CharField(max_length=32, default="self_liveness")
    enrolled_by_external_user_id = models.CharField(max_length=128, blank=True, default="")
    enrollment_business_id = models.CharField(max_length=64, blank=True, default="")

    class Meta:
        db_table = "face_profile"
        constraints = [
            models.CheckConstraint(
                check=models.Q(feature_length__gt=0),
                name="face_profile_feature_length_positive",
            ),
        ]

    def __str__(self):  # pragma: no cover - trivial
        return f"FaceProfile(user={self.external_user_id})"


class AdminAgentEnrollmentGrant(models.Model):
    """
    One-time record of a Node-signed administrator-assisted enrollment grant.

    Node authorizes business membership; Django atomically consumes the grant
    before touching the model/S3. This prevents replay and prevents a manager
    from choosing an arbitrary target Firebase UID.
    """

    id = models.UUIDField(primary_key=True, editable=False)
    manager_external_user_id = models.CharField(max_length=128, db_index=True)
    agent_external_user_id = models.CharField(max_length=128, db_index=True)
    business_id = models.CharField(max_length=64, db_index=True)
    expires_at = models.DateTimeField(db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    consumed_at = models.DateTimeField(null=True, blank=True)
    # Kept only briefly so a manager can retry the Node completion handoff if
    # their network drops after Django stored the embedding. A fresh manager
    # grant can also reconcile an existing immutable profile.
    completion_receipt = models.TextField(blank=True, default="")
    completion_receipt_expires_at = models.DateTimeField(null=True, blank=True)
    enrollment_succeeded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "face_admin_agent_enrollment_grant"
        indexes = [models.Index(fields=["agent_external_user_id", "consumed_at"])]

    @property
    def is_consumed(self) -> bool:
        return self.consumed_at is not None


# NOTE: The old LivenessChallenge table was removed when the on-device SDK took
# over anti-spoofing and the randomised motion challenge. See migration 0006.
