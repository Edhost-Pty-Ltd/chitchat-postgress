"""Django REST Framework viewsets for the face API.

The public API stays at ``/api/face/...``. Keeping each operation as a named
``@action`` gives the service a familiar DRF ViewSet layout without exposing
unsafe generic CRUD routes for biometric profiles.
"""

from __future__ import annotations

import logging

from django.conf import settings
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle

from .agent_enrollment import AgentEnrollmentTokenError
from .agent_service import enroll_agent_face_admin_assisted
from .authentication import FirebaseAuthentication
from .face_engine import EncryptionNotConfigured
from .face_service import (
    ServiceError,
    enrollment_status,
    fetch_enrollment_feature,
    register_self_enrollment,
    store_enrollment,
    verify_reported_account,
)
from .permissions import IsFirebaseAuthenticated
from .serializers import (
    AdminAgentEnrollmentSerializer,
    EnrollmentStatusSerializer,
    FaceEnrollmentSerializer,
    FaceRegistrationSerializer,
    FaceVerificationSerializer,
)

logger = logging.getLogger("accounts.views")

# Service error code → HTTP status. Keep these mappings in the HTTP layer so
# ``face_service.py`` stays focused on storing and comparing features.
_ENROLL_STATUS = {
    "bad_feature": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "empty_feature": status.HTTP_400_BAD_REQUEST,
    "liveness_rejected": status.HTTP_403_FORBIDDEN,
    "already_enrolled": status.HTTP_409_CONFLICT,
    "no_face_detected": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "arcface_failed": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "insightface_unavailable": status.HTTP_503_SERVICE_UNAVAILABLE,
    "enrollment_failed": status.HTTP_500_INTERNAL_SERVER_ERROR,
    "service_unavailable": status.HTTP_503_SERVICE_UNAVAILABLE,
}

_REGISTER_STATUS = {
    **_ENROLL_STATUS,
    "receipt_not_configured": status.HTTP_503_SERVICE_UNAVAILABLE,
}

_VERIFY_STATUS = {
    "bad_feature": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "liveness_failed": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "no_face_detected": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "arcface_failed": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "insightface_unavailable": status.HTTP_503_SERVICE_UNAVAILABLE,
    "report_generation_invalid": status.HTTP_400_BAD_REQUEST,
    "not_enrolled": status.HTTP_404_NOT_FOUND,
    "locked": status.HTTP_423_LOCKED,
    "reference_unreadable": status.HTTP_409_CONFLICT,
    "reference_not_recovery_eligible": status.HTTP_409_CONFLICT,
    "receipt_not_configured": status.HTTP_503_SERVICE_UNAVAILABLE,
    "service_unavailable": status.HTTP_503_SERVICE_UNAVAILABLE,
}

_AGENT_ENROLLMENT_STATUS = {
    "empty_feature": status.HTTP_400_BAD_REQUEST,
    "bad_feature": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "already_enrolled": status.HTTP_409_CONFLICT,
    "agent_grant_invalid": status.HTTP_403_FORBIDDEN,
    "agent_grant_expired": status.HTTP_403_FORBIDDEN,
    "agent_grant_used": status.HTTP_409_CONFLICT,
    "agent_grant_not_configured": status.HTTP_503_SERVICE_UNAVAILABLE,
    "enrollment_failed": status.HTTP_500_INTERNAL_SERVER_ERROR,
}


class FirebaseScopedRateThrottle(SimpleRateThrottle):
    """Apply a DRF rate scope per verified Firebase user instead of per IP."""

    scope = ""

    def get_rate(self):
        rates = getattr(settings, "REST_FRAMEWORK", {}).get(
            "DEFAULT_THROTTLE_RATES", {}
        )
        return rates.get(self.scope)

    def get_cache_key(self, request, view):
        user = getattr(request, "user", None)
        uid = getattr(user, "uid", None)
        ident = uid or self.get_ident(request)
        return self.cache_format % {"scope": self.scope, "ident": ident}


class FaceEnrollThrottle(FirebaseScopedRateThrottle):
    scope = "face_enroll"


class FaceRegisterThrottle(FirebaseScopedRateThrottle):
    scope = "face_register"


class FaceFeatureThrottle(FirebaseScopedRateThrottle):
    scope = "face_feature"


class FaceVerifyThrottle(FirebaseScopedRateThrottle):
    scope = "face_verify"


class FaceStatusThrottle(FirebaseScopedRateThrottle):
    scope = "face_status"


class AgentAdminEnrollmentThrottle(FirebaseScopedRateThrottle):
    scope = "face_agent_register"


def _is_companion(request) -> bool:
    """Return whether the Firebase token belongs to a linked companion device."""

    claims = getattr(request.user, "claims", None) or {}
    return claims.get("companion") is True


def _error(code: str, http_status: int, details=None) -> Response:
    """Keep the existing compact error contract: ``{"error": "code"}``."""

    body = {"error": code}
    if details:
        body["details"] = details
    return Response(body, status=http_status)


def _sdk_values(data: dict) -> dict:
    """Normalize optional SDK metadata after serializer validation."""

    return {
        "liveness_score": float(data.get("liveness_score") or 0.0),
        "liveness_code": int(data.get("liveness_code") or 0),
        "sdk_version": str(data.get("sdk_version") or ""),
    }


def _face_input_error(serializer) -> Response:
    """Preserve the app's existing missing-feature response."""

    if "face_feature" in serializer.errors:
        return _error("empty_feature", status.HTTP_400_BAD_REQUEST)
    return _error("invalid_request", status.HTTP_400_BAD_REQUEST, serializer.errors)


def _verify_input_error(serializer) -> Response:
    if "face_feature" in serializer.errors:
        return _error("empty_feature", status.HTTP_400_BAD_REQUEST)
    if "report_generation" in serializer.errors:
        return _error("report_generation_invalid", status.HTTP_400_BAD_REQUEST)
    return _error("invalid_request", status.HTTP_400_BAD_REQUEST, serializer.errors)


def _agent_input_error(serializer) -> Response:
    if "grant" in serializer.errors:
        return _error("agent_grant_invalid", status.HTTP_400_BAD_REQUEST)
    return _error("invalid_request", status.HTTP_400_BAD_REQUEST, serializer.errors)


class FaceViewSet(viewsets.ViewSet):
    """All authenticated face actions in one conventional DRF ViewSet.

    These are actions instead of a ``ModelViewSet`` because a ``FaceProfile``
    must never have automatic list, retrieve, update, or delete endpoints.
    """

    authentication_classes = [FirebaseAuthentication]
    permission_classes = [IsFirebaseAuthenticated]

    @action(
        detail=False,
        methods=["post"],
        url_path="enroll",
        url_name="enroll",
        throttle_classes=[FaceEnrollThrottle],
    )
    def enroll(self, request):
        """Store one encrypted reference feature for the signed-in user."""

        if _is_companion(request):
            return _error("companion_not_allowed", status.HTTP_403_FORBIDDEN)

        serializer = FaceEnrollmentSerializer(data=request.data)
        if not serializer.is_valid():
            return _face_input_error(serializer)

        data = serializer.validated_data
        try:
            result = store_enrollment(
                request.user.uid,
                data["face_feature"],
                enrollment_image=data.get("face_image") or None,
                **_sdk_values(data),
            )
        except EncryptionNotConfigured:
            logger.error("Enrollment blocked: encryption not configured")
            return _error("service_unavailable", status.HTTP_503_SERVICE_UNAVAILABLE)
        except ServiceError as exc:
            return _error(exc.code, _ENROLL_STATUS.get(exc.code, 422))
        except Exception:
            logger.exception("Unexpected enrollment error")
            return _error("internal_error", status.HTTP_500_INTERNAL_SERVER_ERROR)

        if not result.ok:
            code = result.error or "enrollment_failed"
            return _error(code, _ENROLL_STATUS.get(code, 422))
        return Response({"ok": True, "enrolled": True}, status=status.HTTP_201_CREATED)

    @action(
        detail=False,
        methods=["post"],
        url_path="register",
        url_name="register",
        throttle_classes=[FaceRegisterThrottle],
    )
    def register(self, request):
        """Enroll a new account and return the signed registration receipt."""

        if _is_companion(request):
            return _error("companion_not_allowed", status.HTTP_403_FORBIDDEN)

        serializer = FaceRegistrationSerializer(data=request.data)
        if not serializer.is_valid():
            return _face_input_error(serializer)

        data = serializer.validated_data
        try:
            result = register_self_enrollment(
                request.user.uid,
                data["face_feature"],
                enrollment_image=data.get("face_image") or None,
                **_sdk_values(data),
            )
        except EncryptionNotConfigured:
            logger.error("Registration blocked: encryption not configured")
            return _error("service_unavailable", status.HTTP_503_SERVICE_UNAVAILABLE)
        except ServiceError as exc:
            return _error(exc.code, _REGISTER_STATUS.get(exc.code, 422))
        except Exception:
            logger.exception("Unexpected registration enrollment error")
            return _error("internal_error", status.HTTP_500_INTERNAL_SERVER_ERROR)

        return Response(
            {
                "ok": True,
                "enrolled": True,
                "reconciled": result.reconciled,
                "receipt": result.receipt,
                "receipt_expires_at": result.receipt_expires_at,
            },
            status=status.HTTP_201_CREATED,
        )

    @action(
        detail=False,
        methods=["get"],
        url_path="feature",
        url_name="feature",
        throttle_classes=[FaceFeatureThrottle],
    )
    def feature(self, request):
        """Restore the signed-in user's reference feature on a new device."""

        if _is_companion(request):
            return _error("companion_not_allowed", status.HTTP_403_FORBIDDEN)

        try:
            restored = fetch_enrollment_feature(request.user.uid)
        except EncryptionNotConfigured:
            logger.error("Feature restore blocked: encryption not configured")
            return _error("service_unavailable", status.HTTP_503_SERVICE_UNAVAILABLE)
        except ServiceError as exc:
            return _error(exc.code, _VERIFY_STATUS.get(exc.code, 500))
        except Exception:
            logger.exception("Unexpected feature restore error")
            return _error("internal_error", status.HTTP_500_INTERNAL_SERVER_ERROR)

        if not restored.enrolled:
            return Response({"enrolled": False})
        return Response({"enrolled": True, "face_feature": restored.face_feature})

    @action(
        detail=False,
        methods=["post"],
        url_path="verify-live",
        url_name="verify-live",
        throttle_classes=[FaceVerifyThrottle],
    )
    def verify_live(self, request):
        """Verify a live feature against the stored reference for recovery."""

        if _is_companion(request):
            return _error("companion_not_allowed", status.HTTP_403_FORBIDDEN)

        serializer = FaceVerificationSerializer(data=request.data)
        if not serializer.is_valid():
            return _verify_input_error(serializer)

        data = serializer.validated_data
        try:
            result = verify_reported_account(
                request.user.uid,
                data["report_generation"],
                data["face_feature"],
                float(data.get("liveness_score") or 0.0),
                int(data.get("liveness_code") or 0),
                live_image=data.get("face_image") or None,
            )
        except EncryptionNotConfigured:
            logger.error("Reported verification blocked: encryption not configured")
            return _error("service_unavailable", status.HTTP_503_SERVICE_UNAVAILABLE)
        except ServiceError as exc:
            return _error(exc.code, _VERIFY_STATUS.get(exc.code, 422))
        except Exception:
            logger.exception("Unexpected reported verification error")
            return _error("internal_error", status.HTTP_500_INTERNAL_SERVER_ERROR)

        if not result.ok:
            body = {"error": result.error or "verification_failed"}
            if result.hint:
                body["hint"] = result.hint
            return Response(body, status=_VERIFY_STATUS.get(result.error, 422))

        # Match diagnostics are for development only. The client must never
        # decide whether a recovery succeeds; the signed receipt is the proof.
        diagnostics = {}
        if settings.DEBUG and result.match_score is not None:
            diagnostics = {
                "similarity": round(result.match_score, 4),
                "threshold": float(
                    result.match_threshold
                    if result.match_threshold is not None
                    else getattr(settings, "FACE_MATCH_THRESHOLD", 0.5)
                ),
                "engine": result.match_engine or "sdk_cosine",
            }

        if not result.matched:
            return Response({"ok": True, "matched": False, **diagnostics})

        return Response(
            {
                "ok": True,
                "matched": True,
                "receipt": result.receipt,
                "receipt_expires_at": result.receipt_expires_at,
                "verified_at": result.verified_at,
                **diagnostics,
            }
        )

    @action(
        detail=False,
        methods=["get"],
        url_path="status",
        url_name="status",
        throttle_classes=[FaceStatusThrottle],
    )
    def status(self, request):
        """Return safe enrollment state without returning biometric data."""

        # Preserve the existing behavior: a companion may read this harmless
        # state endpoint, while the other operations reject companion devices.
        payload = EnrollmentStatusSerializer(enrollment_status(request.user.uid))
        return Response(payload.data)

    @action(
        detail=False,
        methods=["post"],
        url_path="admin-register",
        url_name="admin-agent-register",
        throttle_classes=[AgentAdminEnrollmentThrottle],
    )
    def admin_register(self, request):
        """Store a manager-authorized agent reference from a signed grant."""

        if _is_companion(request):
            return _error("companion_not_allowed", status.HTTP_403_FORBIDDEN)

        serializer = AdminAgentEnrollmentSerializer(data=request.data)
        if not serializer.is_valid():
            return _agent_input_error(serializer)

        data = serializer.validated_data
        try:
            result = enroll_agent_face_admin_assisted(
                request.user.uid,
                data["grant"],
                data.get("face_feature"),
            )
        except EncryptionNotConfigured:
            logger.error("Agent enrollment blocked: encryption not configured")
            return _error("service_unavailable", status.HTTP_503_SERVICE_UNAVAILABLE)
        except AgentEnrollmentTokenError as exc:
            return _error(exc.code, _AGENT_ENROLLMENT_STATUS.get(exc.code, 403))
        except ServiceError as exc:
            return _error(exc.code, _AGENT_ENROLLMENT_STATUS.get(exc.code, 422))
        except Exception:
            logger.exception("Unexpected admin-assisted agent enrollment error")
            return _error("internal_error", status.HTTP_500_INTERNAL_SERVER_ERROR)

        return Response(
            {
                "ok": True,
                "enrolled": True,
                "enrollment_method": "admin_assisted",
                "reconciled": result.reconciled,
                "receipt": result.completion_receipt,
                "receipt_expires_at": result.receipt_expires_at,
            },
            status=status.HTTP_201_CREATED,
        )
