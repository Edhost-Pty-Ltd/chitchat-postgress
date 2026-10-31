"""
Tests for the FaceAISDK-powered facial-recognition service.

These exercise the REAL integration (models, service layer, encrypted storage,
views, error mapping, concurrency guards). S3 is a real in-memory bucket via
``moto``, so encryption + upload + download + delete are genuinely executed.
Only two things are mocked: Firebase token verification (we obviously cannot
sign real tokens here) and the on-device SDK (which lives in the mobile app).

Run with:
  FACE_TEST_SQLITE=1 \\
  FERNET_KEYS="$(python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')" \\
  python manage.py test accounts
"""

import math
import uuid
from unittest import mock

from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from accounts import agent_enrollment, face_service, storage
from accounts.face_engine import InvalidFaceFeature, validate_feature
from accounts.models import AdminAgentEnrollmentGrant, FaceProfile

S3_BUCKET = "chitchat-media"


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _feature(seed: int, length: int = 1024) -> str:
    """A deterministic, length-correct SDK-style feature string.

    The real SDK returns an L2-normalised 192-dim float32 embedding encoded as
    base64url (768 bytes → 1024 chars). We reproduce that layout exactly so the
    server's decode-and-cosine matcher behaves as it does in production:
    identical seeds → cosine 1.0, different seeds → ~0.0.
    """
    import base64
    import random
    import struct

    rng = random.Random(seed)
    dims = 192
    vector = [rng.gauss(0.0, 1.0) for _ in range(dims)]
    norm = math.sqrt(sum(x * x for x in vector)) or 1.0
    vector = [x / norm for x in vector]
    raw = struct.pack("<%df" % dims, *vector)
    encoded = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    assert len(encoded) == length, f"expected {length} chars, got {len(encoded)}"
    return encoded


def _moto_s3():
    from moto import mock_aws

    m = mock_aws()
    m.start()
    import boto3

    storage._client = None
    c = boto3.client(
        "s3",
        endpoint_url=None,
        region_name="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )
    c.create_bucket(Bucket=S3_BUCKET)
    return m


from cryptography.fernet import Fernet  # noqa: E402

_TEST_KEY = Fernet.generate_key().decode()

_BASE_SETTINGS = dict(
    FERNET_KEYS=[_TEST_KEY],
    S3_BUCKET=S3_BUCKET,
    S3_ENDPOINT=None,
    S3_ACCESS_KEY_ID="test",
    S3_SECRET_ACCESS_KEY="test",
    S3_FORCE_PATH_STYLE=False,
    FACE_FEATURE_LENGTH=1024,
    FACE_MATCH_THRESHOLD=0.5,
    FACE_MAX_FAILED_ATTEMPTS=3,
    FACE_MIN_LIVENESS_SCORE=0.5,
    FACE_ACCEPTED_LIVENESS_CODES={1, 10},
    FACE_VERIFICATION_RECEIPT_SECRET=("x" * 48),
    FACE_VERIFICATION_RECEIPT_TTL_SEC=120,
    AGENT_FACE_ENROLLMENT_SECRET=("y" * 48),
    AGENT_FACE_ENROLLMENT_RECEIPT_TTL_SEC=120,
)


class _FakeUser:
    uid = "uidA"
    claims = {}
    is_authenticated = True
    is_anonymous = False


# ─────────────────────────────────────────────────────────────────────────────
# Encryption + feature math
# ─────────────────────────────────────────────────────────────────────────────

@override_settings(**_BASE_SETTINGS)
class FeatureValidationTests(TestCase):
    def test_valid_feature_accepted(self):
        feature = _feature(1)
        self.assertEqual(validate_feature(feature), feature)

    def test_wrong_length_rejected(self):
        with self.assertRaises(InvalidFaceFeature):
            validate_feature("x" * 10)

    def test_control_characters_rejected(self):
        bad = _feature(1)
        bad = "\x00" + bad[1:]
        with self.assertRaises(InvalidFaceFeature):
            validate_feature(bad)

    def test_non_string_rejected(self):
        with self.assertRaises(InvalidFaceFeature):
            validate_feature(b"x" * 1024)

    def test_cosine_identity_equals_one(self):
        from accounts.face_engine import cosine_similarity

        same = _feature(42)
        self.assertAlmostEqual(cosine_similarity(same, same), 1.0, places=6)

    def test_cosine_mismatch_below_threshold(self):
        from accounts.face_engine import cosine_similarity

        a = _feature(1)
        b = _feature(1000)
        # Different seeds are different embeddings — decoded float cosine is ~0.
        self.assertLess(cosine_similarity(a, b), 0.5)


# ─────────────────────────────────────────────────────────────────────────────
# Enrollment service
# ─────────────────────────────────────────────────────────────────────────────

@override_settings(**_BASE_SETTINGS)
class EnrollmentServiceTests(TestCase):
    def setUp(self):
        self._moto = _moto_s3()

    def tearDown(self):
        self._moto.stop()
        storage._client = None

    def test_store_and_restore_round_trip(self):
        feature = _feature(7)
        result = face_service.store_enrollment(
            "uidA", feature, liveness_score=0.95, liveness_code=1, sdk_version="1.7.4"
        )
        self.assertTrue(result.ok)

        profile = FaceProfile.objects.get(external_user_id="uidA")
        self.assertEqual(profile.feature_length, 1024)
        self.assertTrue(profile.enrolled_with_liveness)

        restored = face_service.fetch_enrollment_feature("uidA")
        self.assertTrue(restored.enrolled)
        self.assertEqual(restored.face_feature, feature)

    def test_duplicate_enrollment_rejected(self):
        feature = _feature(7)
        face_service.store_enrollment("uidA", feature, liveness_code=1)
        with self.assertRaises(face_service.ServiceError) as ctx:
            face_service.store_enrollment("uidA", _feature(8), liveness_code=1)
        self.assertEqual(ctx.exception.code, "already_enrolled")

    def test_bad_feature_rejected(self):
        with self.assertRaises(face_service.ServiceError) as ctx:
            face_service.store_enrollment("uidA", "too-short", liveness_code=1)
        self.assertEqual(ctx.exception.code, "bad_feature")

    def test_liveness_rejected_when_code_zero(self):
        with self.assertRaises(face_service.ServiceError) as ctx:
            face_service.store_enrollment("uidA", _feature(7), liveness_code=0)
        self.assertEqual(ctx.exception.code, "liveness_rejected")

    def test_liveness_rejected_when_score_below_threshold_for_code_10(self):
        with self.assertRaises(face_service.ServiceError) as ctx:
            face_service.store_enrollment(
                "uidA", _feature(7), liveness_score=0.1, liveness_code=10
            )
        self.assertEqual(ctx.exception.code, "liveness_rejected")

    def test_restore_when_not_enrolled(self):
        result = face_service.fetch_enrollment_feature("uidZ")
        self.assertFalse(result.enrolled)
        self.assertIsNone(result.face_feature)


# ─────────────────────────────────────────────────────────────────────────────
# Reported-account verification service
# ─────────────────────────────────────────────────────────────────────────────

@override_settings(**_BASE_SETTINGS)
class ReportedVerificationTests(TestCase):
    def setUp(self):
        self._moto = _moto_s3()
        self.feature = _feature(123)
        face_service.store_enrollment(
            "uidA", self.feature, liveness_score=0.95, liveness_code=1
        )
        self.generation = str(uuid.uuid4())

    def tearDown(self):
        self._moto.stop()
        storage._client = None

    def _verify(self, feature, liveness_code=1, liveness_score=0.95, generation=None):
        return face_service.verify_reported_account(
            "uidA",
            generation or self.generation,
            feature,
            liveness_score,
            liveness_code,
        )

    def test_happy_path_mints_receipt(self):
        result = self._verify(self.feature)
        self.assertTrue(result.ok)
        self.assertTrue(result.matched)
        self.assertIsNotNone(result.receipt)
        self.assertIn(".", result.receipt)  # two-segment format

        profile = FaceProfile.objects.get(external_user_id="uidA")
        self.assertIsNotNone(profile.last_verified_at)
        self.assertEqual(profile.failed_attempts, 0)

    def test_server_match_failure_returns_matched_false_and_increments_attempts(self):
        # Liveness passes, but the live face is a DIFFERENT person than the
        # enrolled reference — the server-side cosine rejects the match.
        result = self._verify(_feature(1), liveness_code=10, liveness_score=0.9)
        self.assertTrue(result.ok)
        self.assertFalse(result.matched)
        self.assertIsNone(result.receipt)

        profile = FaceProfile.objects.get(external_user_id="uidA")
        self.assertEqual(profile.failed_attempts, 1)

    def test_liveness_only_code_10_with_matching_face_mints_receipt(self):
        # Production flow: SDK proves liveness (code=10); the server matches the
        # live feature against the stored reference and mints the receipt.
        result = self._verify(self.feature, liveness_code=10, liveness_score=0.9)
        self.assertTrue(result.ok)
        self.assertTrue(result.matched)
        self.assertIsNotNone(result.receipt)

    def test_lockout_after_configured_failures(self):
        # Three live-but-not-matching attempts lock verification.
        for _ in range(3):
            self._verify(_feature(2), liveness_code=10, liveness_score=0.9)
        locked = self._verify(self.feature)
        self.assertFalse(locked.ok)
        self.assertEqual(locked.error, "locked")

    def test_liveness_rejected_blocks_match_and_counts_attempt(self):
        # Codes outside {1, 2, 10} are liveness/motion failures.
        result = self._verify(self.feature, liveness_code=5)
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "liveness_failed")
        profile = FaceProfile.objects.get(external_user_id="uidA")
        self.assertEqual(profile.failed_attempts, 1)

    def test_low_liveness_score_for_code_10_rejected(self):
        result = self._verify(self.feature, liveness_code=10, liveness_score=0.1)
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "liveness_failed")

    def test_bad_generation_rejected(self):
        with self.assertRaises(face_service.ServiceError) as ctx:
            self._verify(self.feature, generation="not-a-uuid")
        self.assertEqual(ctx.exception.code, "report_generation_invalid")

    def test_bad_feature_rejected(self):
        with self.assertRaises(face_service.ServiceError) as ctx:
            self._verify("too-short")
        self.assertEqual(ctx.exception.code, "bad_feature")

    def test_not_enrolled_user_cannot_recover(self):
        result = face_service.verify_reported_account(
            "uidZ", self.generation, self.feature, 0.95, 1
        )
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "not_enrolled")

    def test_admin_assisted_profile_is_not_recovery_eligible(self):
        # Replace the self-liveness profile with an admin-assisted one.
        FaceProfile.objects.filter(external_user_id="uidA").update(
            enrollment_method="admin_assisted",
            enrolled_with_liveness=False,
        )
        result = self._verify(self.feature)
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "reference_not_recovery_eligible")


# ─────────────────────────────────────────────────────────────────────────────
# Admin-assisted agent enrollment
# ─────────────────────────────────────────────────────────────────────────────

def _issue_agent_grant(manager_uid: str, agent_uid: str, business_id: str) -> str:
    import base64
    import hashlib
    import hmac
    import json
    import time

    payload = {
        "v": 1,
        "purpose": "admin_assisted_agent_enrollment_grant",
        "managerId": manager_uid,
        "agentId": agent_uid,
        "businessId": business_id,
        "jti": str(uuid.uuid4()),
        "iat": int(time.time()),
        "exp": int(time.time()) + 300,
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).rstrip(b"=").decode("ascii")
    secret = ("y" * 48).encode("utf-8")
    signature = hmac.new(secret, encoded.encode("ascii"), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{encoded}.{sig_b64}"


@override_settings(**_BASE_SETTINGS)
class AdminAssistedEnrollmentTests(TestCase):
    def setUp(self):
        self._moto = _moto_s3()
        self.business_id = str(uuid.uuid4())
        self.feature = _feature(55)

    def tearDown(self):
        self._moto.stop()
        storage._client = None

    def test_happy_path_stores_feature_and_mints_receipt(self):
        from accounts.agent_service import enroll_agent_face_admin_assisted

        grant = _issue_agent_grant("mgr-1", "agent-1", self.business_id)
        result = enroll_agent_face_admin_assisted("mgr-1", grant, self.feature)
        self.assertTrue(result.ok)
        self.assertFalse(result.reconciled)
        self.assertEqual(result.agent_external_user_id, "agent-1")

        profile = FaceProfile.objects.get(external_user_id="agent-1")
        self.assertEqual(profile.enrollment_method, "admin_assisted")
        self.assertFalse(profile.enrolled_with_liveness)

    def test_replay_within_receipt_ttl_returns_stored_receipt(self):
        from accounts.agent_service import enroll_agent_face_admin_assisted

        grant = _issue_agent_grant("mgr-1", "agent-1", self.business_id)
        first = enroll_agent_face_admin_assisted("mgr-1", grant, self.feature)
        second = enroll_agent_face_admin_assisted("mgr-1", grant, self.feature)
        # The second call reuses the stored receipt rather than re-storing the
        # feature or raising — so a dropped mobile response is recoverable.
        self.assertEqual(first.completion_receipt, second.completion_receipt)
        self.assertTrue(second.reconciled)

    def test_replay_after_receipt_expiry_rejected(self):
        from accounts.agent_service import enroll_agent_face_admin_assisted
        from accounts.agent_enrollment import AgentEnrollmentTokenError

        grant = _issue_agent_grant("mgr-1", "agent-1", self.business_id)
        enroll_agent_face_admin_assisted("mgr-1", grant, self.feature)
        # Expire the stored receipt the way time would.
        AdminAgentEnrollmentGrant.objects.filter(
            agent_external_user_id="agent-1"
        ).update(completion_receipt_expires_at=timezone.now())
        with self.assertRaises(AgentEnrollmentTokenError) as ctx:
            enroll_agent_face_admin_assisted("mgr-1", grant, self.feature)
        self.assertEqual(ctx.exception.code, "agent_grant_used")

    def test_bad_feature_rejected(self):
        from accounts.agent_service import enroll_agent_face_admin_assisted

        grant = _issue_agent_grant("mgr-1", "agent-1", self.business_id)
        with self.assertRaises(face_service.ServiceError) as ctx:
            enroll_agent_face_admin_assisted("mgr-1", grant, "too-short")
        self.assertEqual(ctx.exception.code, "bad_feature")

    def test_wrong_manager_rejected(self):
        from accounts.agent_service import enroll_agent_face_admin_assisted
        from accounts.agent_enrollment import AgentEnrollmentTokenError

        grant = _issue_agent_grant("mgr-1", "agent-1", self.business_id)
        with self.assertRaises(AgentEnrollmentTokenError) as ctx:
            enroll_agent_face_admin_assisted("other-mgr", grant, self.feature)
        self.assertEqual(ctx.exception.code, "agent_grant_invalid")


# ─────────────────────────────────────────────────────────────────────────────
# HTTP surface (DRF)
# ─────────────────────────────────────────────────────────────────────────────

@override_settings(
    **_BASE_SETTINGS,
    REST_FRAMEWORK={
        "DEFAULT_AUTHENTICATION_CLASSES": ["accounts.authentication.FirebaseAuthentication"],
        "DEFAULT_PERMISSION_CLASSES": ["accounts.permissions.IsFirebaseAuthenticated"],
        "UNAUTHENTICATED_USER": None,
    },
)
class FaceViewTests(TestCase):
    def setUp(self):
        self._moto = _moto_s3()
        self.client = APIClient()
        patcher = mock.patch(
            "accounts.authentication.FirebaseAuthentication.authenticate",
            return_value=(_FakeUser(), "tok"),
        )
        self.addCleanup(patcher.stop)
        patcher.start()

    def tearDown(self):
        self._moto.stop()
        storage._client = None

    def test_enroll_endpoint_happy_path(self):
        feature = _feature(1)
        res = self.client.post(
            "/api/face/enroll/",
            {"face_feature": feature, "liveness_score": 0.95, "liveness_code": 1},
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.content)
        self.assertTrue(res.json()["ok"])

    def test_enroll_endpoint_rejects_bad_feature(self):
        res = self.client.post(
            "/api/face/enroll/",
            {"face_feature": "nope", "liveness_code": 1},
            format="json",
        )
        self.assertEqual(res.status_code, 422)
        self.assertEqual(res.json()["error"], "bad_feature")

    def test_enroll_endpoint_rejects_missing_feature(self):
        res = self.client.post("/api/face/enroll/", {}, format="json")
        self.assertEqual(res.status_code, 400)

    def test_feature_endpoint_returns_stored_value(self):
        feature = _feature(2)
        self.client.post(
            "/api/face/enroll/",
            {"face_feature": feature, "liveness_score": 0.9, "liveness_code": 1},
            format="json",
        )
        res = self.client.get("/api/face/feature/")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["enrolled"])
        self.assertEqual(body["face_feature"], feature)

    def test_feature_endpoint_reports_not_enrolled(self):
        res = self.client.get("/api/face/feature/")
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.json()["enrolled"])

    def test_verify_live_mints_receipt_on_match(self):
        feature = _feature(3)
        self.client.post(
            "/api/face/enroll/",
            {"face_feature": feature, "liveness_score": 0.95, "liveness_code": 1},
            format="json",
        )
        generation = str(uuid.uuid4())
        res = self.client.post(
            "/api/face/verify-live/",
            {
                "face_feature": feature,
                "liveness_score": 0.95,
                "liveness_code": 1,
                "report_generation": generation,
            },
            format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertTrue(body["ok"])
        self.assertTrue(body["matched"])
        self.assertIn("receipt", body)

    def test_verify_live_returns_matched_false_for_a_different_face(self):
        # Liveness passes (code=10), but the live face is a different person —
        # the server's embedding comparison returns matched: false.
        self.client.post(
            "/api/face/enroll/",
            {"face_feature": _feature(1), "liveness_score": 0.95, "liveness_code": 1},
            format="json",
        )
        res = self.client.post(
            "/api/face/verify-live/",
            {
                "face_feature": _feature(99),
                "liveness_score": 0.95,
                "liveness_code": 10,
                "report_generation": str(uuid.uuid4()),
            },
            format="json",
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["ok"])
        self.assertFalse(body["matched"])
        self.assertNotIn("receipt", body)

    def test_status_endpoint(self):
        self.client.post(
            "/api/face/enroll/",
            {"face_feature": _feature(1), "liveness_score": 0.95, "liveness_code": 1},
            format="json",
        )
        res = self.client.get("/api/face/status/")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertTrue(body["enrolled"])
        self.assertFalse(body["locked"])


@override_settings(
    **_BASE_SETTINGS,
    REST_FRAMEWORK={
        "DEFAULT_AUTHENTICATION_CLASSES": ["accounts.authentication.FirebaseAuthentication"],
        "DEFAULT_PERMISSION_CLASSES": ["accounts.permissions.IsFirebaseAuthenticated"],
        "UNAUTHENTICATED_USER": None,
    },
)
class AdminAgentViewTests(TestCase):
    def setUp(self):
        self._moto = _moto_s3()
        self.client = APIClient()
        patcher = mock.patch(
            "accounts.authentication.FirebaseAuthentication.authenticate",
            return_value=(_FakeUser(), "tok"),
        )
        self.addCleanup(patcher.stop)
        patcher.start()

    def tearDown(self):
        self._moto.stop()
        storage._client = None

    def test_admin_register_happy_path(self):
        grant = _issue_agent_grant("uidA", "agent-x", str(uuid.uuid4()))
        res = self.client.post(
            "/api/face/admin-register/",
            {"grant": grant, "face_feature": _feature(10)},
            format="json",
        )
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        self.assertTrue(body["ok"])
        self.assertIn("receipt", body)
        self.assertEqual(body["enrollment_method"], "admin_assisted")

    def test_admin_register_rejects_missing_grant(self):
        res = self.client.post(
            "/api/face/admin-register/",
            {"face_feature": _feature(10)},
            format="json",
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["error"], "agent_grant_invalid")

    def test_admin_register_rejects_bad_feature(self):
        grant = _issue_agent_grant("uidA", "agent-x", str(uuid.uuid4()))
        res = self.client.post(
            "/api/face/admin-register/",
            {"grant": grant, "face_feature": "too-short"},
            format="json",
        )
        self.assertEqual(res.status_code, 422)
        self.assertEqual(res.json()["error"], "bad_feature")


# ─────────────────────────────────────────────────────────────────────────────
# Self registration: enrollment + live verification → receipt for Node
# ─────────────────────────────────────────────────────────────────────────────

def _decode_receipt(receipt: str, secret: str) -> dict:
    """Verify the HMAC exactly as Node does, then return the payload."""
    import base64
    import hashlib
    import hmac
    import json

    encoded, signature = receipt.split(".")
    expected = hmac.new(secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
    supplied = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
    if not hmac.compare_digest(expected, supplied):
        raise AssertionError("receipt signature does not verify")
    return json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))


@override_settings(**_BASE_SETTINGS)
class SelfRegistrationServiceTests(TestCase):
    def setUp(self):
        self._moto = _moto_s3()

    def tearDown(self):
        self._moto.stop()
        storage._client = None

    def test_stores_reference_and_mints_a_registration_receipt(self):
        result = face_service.register_self_enrollment(
            "newbie", _feature(5), liveness_code=1, liveness_score=0.93
        )
        self.assertTrue(result.ok)
        self.assertFalse(result.reconciled)

        payload = _decode_receipt(result.receipt, "x" * 48)
        self.assertEqual(payload["sub"], "newbie")
        self.assertEqual(payload["purpose"], "self_registration_face_enrollment")
        self.assertEqual(payload["v"], 1)
        self.assertLessEqual(payload["exp"] - payload["iat"], 300)

        profile = FaceProfile.objects.get(external_user_id="newbie")
        self.assertEqual(profile.enrollment_method, "self_liveness")
        self.assertTrue(profile.enrolled_with_liveness)
        self.assertEqual(face_service.fetch_enrollment_feature("newbie").face_feature, _feature(5))

    def test_requires_a_passed_live_verification(self):
        for code in (0, 2, 4, 10, 11, 13):
            with self.assertRaises(face_service.ServiceError) as ctx:
                face_service.register_self_enrollment("newbie", _feature(5), liveness_code=code)
            self.assertEqual(ctx.exception.code, "liveness_rejected")
        self.assertFalse(FaceProfile.objects.filter(external_user_id="newbie").exists())

    def test_rejects_a_malformed_feature(self):
        with self.assertRaises(face_service.ServiceError) as ctx:
            face_service.register_self_enrollment("newbie", "too-short", liveness_code=1)
        self.assertEqual(ctx.exception.code, "bad_feature")

    def test_retry_keeps_the_reference_and_mints_a_fresh_receipt(self):
        first = face_service.register_self_enrollment("newbie", _feature(5), liveness_code=1)
        second = face_service.register_self_enrollment("newbie", _feature(6), liveness_code=1)
        self.assertTrue(second.reconciled)
        self.assertNotEqual(first.receipt, second.receipt)
        self.assertEqual(FaceProfile.objects.filter(external_user_id="newbie").count(), 1)
        # The original reference is immutable through this path.
        self.assertEqual(face_service.fetch_enrollment_feature("newbie").face_feature, _feature(5))

    def test_admin_assisted_reference_is_not_a_self_registration(self):
        face_service.store_enrollment("agent-1", _feature(7), enrollment_method="admin_assisted")
        with self.assertRaises(face_service.ServiceError) as ctx:
            face_service.register_self_enrollment("agent-1", _feature(7), liveness_code=1)
        self.assertEqual(ctx.exception.code, "already_enrolled")

    @override_settings(FACE_VERIFICATION_RECEIPT_SECRET="too-short")
    def test_unconfigured_secret_is_reported_not_swallowed(self):
        with self.assertRaises(face_service.ServiceError) as ctx:
            face_service.register_self_enrollment("newbie", _feature(5), liveness_code=1)
        self.assertEqual(ctx.exception.code, "receipt_not_configured")


class _FakeCompanion(_FakeUser):
    claims = {"companion": True}


@override_settings(
    **_BASE_SETTINGS,
    REST_FRAMEWORK={
        "DEFAULT_AUTHENTICATION_CLASSES": ["accounts.authentication.FirebaseAuthentication"],
        "DEFAULT_PERMISSION_CLASSES": ["accounts.permissions.IsFirebaseAuthenticated"],
        "UNAUTHENTICATED_USER": None,
    },
)
class RegisterFaceViewTests(TestCase):
    def setUp(self):
        self._moto = _moto_s3()
        self.client = APIClient()
        self._auth = mock.patch(
            "accounts.authentication.FirebaseAuthentication.authenticate",
            return_value=(_FakeUser(), "tok"),
        )
        self._auth.start()
        self.addCleanup(self._auth.stop)

    def tearDown(self):
        self._moto.stop()
        storage._client = None

    def _post(self, **body):
        return self.client.post("/api/face/register/", body, format="json")

    def test_returns_a_receipt_for_a_passed_live_verification(self):
        res = self._post(face_feature=_feature(9), liveness_code=1, liveness_score=0.9)
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        self.assertTrue(body["ok"])
        self.assertFalse(body["reconciled"])
        self.assertEqual(_decode_receipt(body["receipt"], "x" * 48)["sub"], "uidA")

    def test_rejects_a_failed_live_verification(self):
        res = self._post(face_feature=_feature(9), liveness_code=2, liveness_score=0.9)
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.json()["error"], "liveness_rejected")

    def test_rejects_a_missing_feature(self):
        res = self._post(liveness_code=1)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["error"], "empty_feature")

    def test_rejects_companion_devices(self):
        self._auth.stop()
        companion = mock.patch(
            "accounts.authentication.FirebaseAuthentication.authenticate",
            return_value=(_FakeCompanion(), "tok"),
        )
        companion.start()
        self.addCleanup(companion.stop)
        res = self._post(face_feature=_feature(9), liveness_code=1)
        self.assertEqual(res.status_code, 403)


# ─────────────────────────────────────────────────────────────────────────────
# InsightFace server-side ArcFace match
# ─────────────────────────────────────────────────────────────────────────────

import numpy as np  # noqa: E402

from accounts import insightface_engine  # noqa: E402


def _arcface_vec(seed: int, dim: int = 512) -> "np.ndarray":
    """A deterministic L2-normalised ArcFace-shaped embedding."""
    rng = np.random.default_rng(seed)
    v = rng.standard_normal(dim).astype(np.float32)
    n = float(np.linalg.norm(v)) or 1.0
    return (v / n).astype(np.float32)


class InsightFaceEngineTests(TestCase):
    """The pure math/serialisation layer — no model, no network."""

    def test_embedding_bytes_round_trip(self):
        vec = _arcface_vec(1)
        raw = insightface_engine.embedding_to_bytes(vec)
        back = insightface_engine.embedding_from_bytes(raw)
        self.assertEqual(back.shape[0], 512)
        self.assertTrue(np.allclose(vec, back, atol=1e-6))

    def test_cosine_identity_equals_one(self):
        vec = _arcface_vec(5)
        self.assertAlmostEqual(
            insightface_engine.cosine_similarity(vec, vec), 1.0, places=5
        )

    def test_cosine_distinct_identities_low(self):
        a = _arcface_vec(1)
        b = _arcface_vec(9999)
        self.assertLess(insightface_engine.cosine_similarity(a, b), 0.42)

    def test_invalid_stored_bytes_rejected(self):
        with self.assertRaises(insightface_engine.InsightFaceError):
            insightface_engine.embedding_from_bytes(b"\x00\x00\x00")  # not /4

    def test_dimensionality_mismatch_rejected(self):
        with self.assertRaises(insightface_engine.InsightFaceError):
            insightface_engine.cosine_similarity(_arcface_vec(1, 512), _arcface_vec(1, 128))


@override_settings(**{**_BASE_SETTINGS, "INSIGHTFACE_MATCH_THRESHOLD": 0.42})
class InsightFaceMatchServiceTests(TestCase):
    """verify_reported_account's InsightFace path, with the engine mocked so no
    model/image decoding is needed. Confirms the server — not the client —
    decides the match, and that legacy profiles still fall back to SDK cosine."""

    def setUp(self):
        self._moto = _moto_s3()
        self._auth = mock.patch(
            "accounts.authentication.FirebaseAuthentication.authenticate",
            return_value=(_FakeUser(), "tok"),
        )
        self._auth.start()

    def tearDown(self):
        self._auth.stop()
        self._moto.stop()
        storage._client = None

    def _enroll_with_arcface(self, uid: str, seed: int) -> None:
        """Enroll a profile whose stored ArcFace reference is _arcface_vec(seed)."""
        with mock.patch.object(
            insightface_engine, "embedding_from_image", return_value=_arcface_vec(seed)
        ):
            face_service.store_enrollment(
                uid,
                _feature(seed),
                liveness_score=0.95,
                liveness_code=1,
                sdk_version="1.7.4",
                enrollment_image="data:image/jpeg;base64,AAAA",
            )
        profile = FaceProfile.objects.get(external_user_id=uid)
        self.assertTrue(profile.arcface_object_key, "ArcFace reference was not stored")
        self.assertEqual(profile.arcface_dim, 512)

    def test_insightface_match_mints_receipt(self):
        self._enroll_with_arcface("uidA", seed=11)
        # Live image yields the SAME ArcFace embedding → cosine 1.0 → match.
        with mock.patch.object(
            insightface_engine, "embedding_from_image", return_value=_arcface_vec(11)
        ):
            result = face_service.verify_reported_account(
                "uidA",
                str(uuid.uuid4()),
                _feature(11),
                liveness_score=0.9,
                liveness_code=10,
                live_image="data:image/jpeg;base64,BBBB",
            )
        self.assertTrue(result.ok)
        self.assertTrue(result.matched)
        self.assertEqual(result.match_engine, "insightface")
        self.assertIsNotNone(result.receipt)

    def test_insightface_different_person_no_match(self):
        self._enroll_with_arcface("uidA", seed=11)
        # A live image of a DIFFERENT person → low cosine → no match, even though
        # the client sends a valid SDK feature. The server overrides the client.
        with mock.patch.object(
            insightface_engine, "embedding_from_image", return_value=_arcface_vec(22222)
        ):
            result = face_service.verify_reported_account(
                "uidA",
                str(uuid.uuid4()),
                _feature(11),
                liveness_score=0.9,
                liveness_code=10,
                live_image="data:image/jpeg;base64,CCCC",
            )
        self.assertTrue(result.ok)
        self.assertFalse(result.matched)
        self.assertEqual(result.match_engine, "insightface")
        self.assertIsNone(result.receipt)

    def test_no_face_in_live_image_is_recoverable_error(self):
        self._enroll_with_arcface("uidA", seed=11)
        with mock.patch.object(
            insightface_engine,
            "embedding_from_image",
            side_effect=insightface_engine.NoFaceDetected("no_face_detected"),
        ):
            result = face_service.verify_reported_account(
                "uidA",
                str(uuid.uuid4()),
                _feature(11),
                liveness_score=0.9,
                liveness_code=10,
                live_image="data:image/jpeg;base64,DDDD",
            )
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "no_face_detected")

    def test_legacy_profile_without_arcface_falls_back_to_sdk_cosine(self):
        # Enroll WITHOUT an image → no ArcFace reference stored.
        face_service.store_enrollment(
            "uidA", _feature(7), liveness_score=0.95, liveness_code=1
        )
        profile = FaceProfile.objects.get(external_user_id="uidA")
        self.assertFalse(profile.arcface_object_key)
        # Even if a live image is supplied, with no ArcFace reference the server
        # uses the SDK cosine path on the matching feature → match.
        result = face_service.verify_reported_account(
            "uidA",
            str(uuid.uuid4()),
            _feature(7),
            liveness_score=0.9,
            liveness_code=10,
            live_image="data:image/jpeg;base64,EEEE",
        )
        self.assertTrue(result.ok)
        self.assertTrue(result.matched)
        self.assertEqual(result.match_engine, "sdk_cosine")

    def test_insightface_unavailable_at_enroll_still_stores_sdk_feature(self):
        with mock.patch.object(
            insightface_engine,
            "embedding_from_image",
            side_effect=insightface_engine.InsightFaceNotInstalled("not installed"),
        ):
            result = face_service.store_enrollment(
                "uidA",
                _feature(7),
                liveness_score=0.95,
                liveness_code=1,
                enrollment_image="data:image/jpeg;base64,FFFF",
            )
        self.assertTrue(result.ok)
        profile = FaceProfile.objects.get(external_user_id="uidA")
        # SDK feature stored; no ArcFace reference because the model was absent.
        self.assertTrue(profile.embedding_object_key)
        self.assertFalse(profile.arcface_object_key)


class InsightFaceImageDecodeTests(TestCase):
    """The SDK's base64 face image decodes the same way from iOS and Android."""

    RAW = bytes(range(256)) * 4  # includes bytes that encode to '+' and '/'

    def _decode(self, encoded: str) -> bytes:
        return insightface_engine._base64_to_bytes(encoded, 10_000_000)

    def test_standard_base64(self):
        import base64

        self.assertEqual(self._decode(base64.b64encode(self.RAW).decode("ascii")), self.RAW)

    def test_line_wrapped_base64(self):
        import base64

        encoded = base64.encodebytes(self.RAW).decode("ascii")
        self.assertIn("\n", encoded)
        self.assertEqual(self._decode(encoded), self.RAW)

    def test_url_safe_unpadded_base64(self):
        import base64

        encoded = base64.urlsafe_b64encode(self.RAW).decode("ascii").rstrip("=")
        self.assertIn("-", encoded)
        self.assertEqual(self._decode(encoded), self.RAW)

    def test_data_url_prefix(self):
        import base64

        encoded = "data:image/jpeg;base64," + base64.b64encode(self.RAW).decode("ascii")
        self.assertEqual(self._decode(encoded), self.RAW)

    def test_garbage_rejected(self):
        with self.assertRaises(insightface_engine.InsightFaceError):
            self._decode("not*base64!")

    def test_oversized_payload_rejected_before_decoding(self):
        with self.assertRaises(insightface_engine.InsightFaceError):
            insightface_engine._base64_to_bytes("A" * 101, 50)


class _FakeFace:
    def __init__(self, emb):
        self.bbox = (10.0, 10.0, 90.0, 90.0)
        self.normed_embedding = emb


class _FakeAnalyzer:
    """Finds no face for the first ``misses`` calls, then one face."""

    def __init__(self, emb, misses: int):
        self.emb = emb
        self.misses = misses
        self.shapes = []

    def get(self, bgr):
        self.shapes.append(bgr.shape)
        if len(self.shapes) <= self.misses:
            return []
        return [_FakeFace(self.emb)]


class InsightFaceDetectionRetryTests(TestCase):
    """A tight face crop gets one padded retry before the image is rejected."""

    def _embed(self, analyzer):
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        with mock.patch.object(insightface_engine, "_load_analyzer", return_value=analyzer), \
                mock.patch.object(insightface_engine, "_decode_image", return_value=frame):
            return insightface_engine.embedding_from_image("ignored")

    def test_face_found_first_time_is_not_padded(self):
        analyzer = _FakeAnalyzer(_arcface_vec(1), misses=0)
        emb = self._embed(analyzer)
        self.assertEqual(analyzer.shapes, [(100, 100, 3)])
        self.assertAlmostEqual(
            insightface_engine.cosine_similarity(emb, _arcface_vec(1)), 1.0, places=5
        )

    def test_tight_crop_is_retried_with_padding(self):
        analyzer = _FakeAnalyzer(_arcface_vec(1), misses=1)
        emb = self._embed(analyzer)
        # 30% of the longer side (100px) on every edge -> 160x160.
        self.assertEqual(analyzer.shapes, [(100, 100, 3), (160, 160, 3)])
        self.assertAlmostEqual(
            insightface_engine.cosine_similarity(emb, _arcface_vec(1)), 1.0, places=5
        )

    def test_no_face_even_with_padding_is_rejected(self):
        with self.assertRaises(insightface_engine.NoFaceDetected):
            self._embed(_FakeAnalyzer(_arcface_vec(1), misses=2))


@override_settings(
    **_BASE_SETTINGS,
    REST_FRAMEWORK={
        "DEFAULT_AUTHENTICATION_CLASSES": ["accounts.authentication.FirebaseAuthentication"],
        "DEFAULT_PERMISSION_CLASSES": ["accounts.permissions.IsFirebaseAuthenticated"],
        "UNAUTHENTICATED_USER": None,
    },
)
class InsightFaceRegistrationViewTests(TestCase):
    """POST /api/face/register/ carrying the face image, as the app now sends it."""

    IMAGE = "data:image/jpeg;base64," + "A" * 64  # never decoded: the model is mocked

    def setUp(self):
        self._moto = _moto_s3()
        self.client = APIClient()
        self._auth = mock.patch(
            "accounts.authentication.FirebaseAuthentication.authenticate",
            return_value=(_FakeUser(), "tok"),
        )
        self._auth.start()
        self.addCleanup(self._auth.stop)

    def tearDown(self):
        self._moto.stop()
        storage._client = None

    def _register(self, face_image, embedding=None, side_effect=None):
        with mock.patch.object(
            insightface_engine,
            "embedding_from_image",
            return_value=embedding,
            side_effect=side_effect,
        ) as engine:
            res = self.client.post(
                "/api/face/register/",
                {
                    "face_feature": _feature(9),
                    "liveness_code": 1,
                    "liveness_score": 0.9,
                    "face_image": face_image,
                },
                format="json",
            )
        return res, engine

    def test_registration_builds_insightface_reference_from_the_image(self):
        res, engine = self._register(self.IMAGE, embedding=_arcface_vec(3))
        self.assertEqual(res.status_code, 201, res.content)
        engine.assert_called_once_with(self.IMAGE)
        profile = FaceProfile.objects.get(external_user_id="uidA")
        self.assertTrue(profile.arcface_object_key)
        self.assertEqual(profile.arcface_dim, 512)
        # The stored object is the encrypted embedding, not the image.
        stored = face_service._load_arcface_reference(profile)
        self.assertAlmostEqual(
            insightface_engine.cosine_similarity(stored, _arcface_vec(3)), 1.0, places=5
        )

    def test_image_without_a_face_rejects_registration_and_cleans_up(self):
        res, _ = self._register(
            self.IMAGE, side_effect=insightface_engine.NoFaceDetected("no_face_detected")
        )
        self.assertEqual(res.status_code, 422, res.content)
        self.assertEqual(res.json()["error"], "no_face_detected")
        self.assertFalse(FaceProfile.objects.filter(external_user_id="uidA").exists())
        listing = storage._s3().list_objects_v2(Bucket=S3_BUCKET)
        self.assertEqual(listing.get("KeyCount", 0), 0)

    @override_settings(DEBUG=True)
    def test_registered_account_is_matched_with_insightface_on_recovery(self):
        res, _ = self._register(self.IMAGE, embedding=_arcface_vec(3))
        self.assertEqual(res.status_code, 201, res.content)
        with mock.patch.object(
            insightface_engine, "embedding_from_image", return_value=_arcface_vec(3)
        ):
            res = self.client.post(
                "/api/face/verify-live/",
                {
                    "report_generation": str(uuid.uuid4()),
                    "face_feature": _feature(9),
                    "liveness_code": 10,
                    "liveness_score": 0.9,
                    "face_image": self.IMAGE,
                },
                format="json",
            )
        self.assertEqual(res.status_code, 200, res.content)
        body = res.json()
        self.assertTrue(body["matched"])
        self.assertEqual(body["engine"], "insightface")
        self.assertIn("receipt", body)

    def test_full_size_image_payload_is_accepted(self):
        # A full-resolution JPEG can be several MB once base64-encoded, which
        # is above Django's 2.5 MB default in-memory request limit.
        big = "data:image/jpeg;base64," + "A" * (3 * 1024 * 1024)
        res, engine = self._register(big, embedding=_arcface_vec(3))
        self.assertEqual(res.status_code, 201, res.content[:300])
        engine.assert_called_once_with(big)
