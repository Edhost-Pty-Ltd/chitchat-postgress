"""Request and response serializers for the face API.

Keeping the request shapes here makes ``views.py`` read like a small list of
business actions. The feature format itself is still validated in
``face_service`` because that is the single place that stores or compares it.
"""

from rest_framework import serializers


class FaceFeatureInputSerializer(serializers.Serializer):
    """The common SDK feature payload used for enrollment operations."""

    # Do not trim this value: it is a fixed-length SDK feature, not human text.
    face_feature = serializers.CharField(allow_blank=False, trim_whitespace=False)
    # The app always sends numbers. ``allow_null`` retains the former API's
    # useful fallback of treating null as zero.
    liveness_score = serializers.FloatField(required=False, allow_null=True, default=0.0)
    liveness_code = serializers.IntegerField(required=False, allow_null=True, default=0)
    sdk_version = serializers.CharField(required=False, allow_blank=True, default="")
    # Base64 face image (optional). When present, the server computes an
    # InsightFace (ArcFace) embedding from it and stores/compares that as the
    # authoritative identity reference. Not length-bounded here — the image
    # decoder enforces a byte ceiling before decoding.
    face_image = serializers.CharField(
        required=False, allow_blank=True, allow_null=True, trim_whitespace=False
    )


class FaceEnrollmentSerializer(FaceFeatureInputSerializer):
    """Payload for POST /api/face/enroll/."""


class FaceRegistrationSerializer(FaceFeatureInputSerializer):
    """Payload for POST /api/face/register/."""


class FaceVerificationSerializer(FaceFeatureInputSerializer):
    """Payload for POST /api/face/verify-live/."""

    report_generation = serializers.CharField(allow_blank=False, trim_whitespace=True)
    # The server deliberately does not use the client-reported similarity for
    # authorization. It is accepted only to keep the mobile request contract.
    similarity = serializers.FloatField(required=False, allow_null=True)


class AdminAgentEnrollmentSerializer(serializers.Serializer):
    """Manager-approved agent enrollment payload.

    ``face_feature`` is optional for a retry: a new signed grant can reconcile
    an already stored immutable reference without sending it again.
    """

    grant = serializers.CharField(allow_blank=False, trim_whitespace=True)
    face_feature = serializers.CharField(
        required=False,
        allow_blank=True,
        allow_null=True,
        trim_whitespace=False,
    )


class EnrollmentStatusSerializer(serializers.Serializer):
    """Safe, non-biometric enrollment state returned by the status action."""

    enrolled = serializers.BooleanField()
    locked = serializers.BooleanField()
    last_verified_at = serializers.CharField(allow_null=True, required=False)
    enrolled_at = serializers.CharField(allow_null=True, required=False)
