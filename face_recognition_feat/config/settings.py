"""
Django settings for the ChitChat facial-recognition service.

This standalone service does not own application users. It verifies the same
Firebase ID tokens as Node and stores encrypted reference features in the
existing private S3/MinIO bucket. The on-device FaceAISDK handles capture and
anti-spoofing/liveness; this service stores the encrypted references and makes
the authoritative identity match with InsightFace (ArcFace) before minting a
signed verification receipt.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def _bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _csv(name: str, default: str = "") -> list[str]:
    return [p.strip() for p in os.environ.get(name, default).split(",") if p.strip()]


# ── Core ──────────────────────────────────────────────────────────────────────
SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "dev-insecure-change-me")
DEBUG = _bool("DJANGO_DEBUG", False)
ALLOWED_HOSTS = _csv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1")

FACE_ALLOW_ADMIN_ASSISTED_RECOVERY = True
if DEBUG:
    # In local dev the mobile client reaches this service over the LAN by the
    # Mac's IPv4, which DHCP can change. Auto-allow the host's own addresses so
    # on-device enrollment does not fail with DisallowedHost after an IP change.
    # DEBUG-only: production keeps the explicit allowlist above.
    import socket

    try:
        _candidates = {"localhost", "127.0.0.1", "0.0.0.0"}
        _hostname = socket.gethostname()
        _candidates.update(socket.gethostbyname_ex(_hostname)[2])
        try:
            _s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            _s.connect(("8.8.8.8", 80))
            _candidates.add(_s.getsockname()[0])
            _s.close()
        except OSError:
            pass
        for _ip in _candidates:
            if _ip and _ip not in ALLOWED_HOSTS:
                ALLOWED_HOSTS.append(_ip)
    except OSError:
        pass

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
    "rest_framework",
    "django.contrib.auth",
    "django.contrib.sessions",

    "django.contrib.messages",
    "accounts.apps.AccountsConfig", 

]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": [

            "django.template.context_processors.debug",
            "django.template.context_processors.request",
            "django.contrib.auth.context_processors.auth",
            "django.contrib.messages.context_processors.messages",
        ]},
    }
]

# ── This service's own DB ─────────────────────────────────────────────────────
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("FACE_DB_NAME", "chitchat_face"),
        "USER": os.environ.get("FACE_DB_USER", "chitchat"),
        "PASSWORD": os.environ.get("FACE_DB_PASSWORD", "chitchat"),
        "HOST": os.environ.get("FACE_DB_HOST", "localhost"),
        "PORT": os.environ.get("FACE_DB_PORT", "5432"),
    }
}
# ── The Node app's own database (read/write, admin only) ─────────────────────
# Lets the Django admin show and manage the main app's tables (users, chats,
# calls, businesses, ...). The `appdata` app's models are unmanaged, and
# config.db_routers.AppDataRouter sends them here and blocks migrations, so
# Django never creates or alters these tables; the Node migrations own them.
# Same Postgres server and login as the face DB unless APP_DB_* says otherwise.
DATABASES["app"] = {
    "ENGINE": "django.db.backends.postgresql",
    "NAME": os.environ.get("APP_DB_NAME", "chitchat"),
    "USER": os.environ.get("APP_DB_USER", DATABASES["default"]["USER"]),
    "PASSWORD": os.environ.get("APP_DB_PASSWORD", DATABASES["default"]["PASSWORD"]),
    "HOST": os.environ.get("APP_DB_HOST", DATABASES["default"]["HOST"]),
    "PORT": os.environ.get("APP_DB_PORT", DATABASES["default"]["PORT"]),
}
DATABASE_ROUTERS = ["config.db_routers.AppDataRouter"]

if os.environ.get("FACE_TEST_SQLITE") == "1":
    DATABASES["default"] = {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}
    # Tests must never touch the real app database.
    DATABASES["app"] = {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True
TIME_ZONE = "UTC"
STATIC_URL = "static/"

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"plain": {"format": "%(asctime)s %(levelname)s %(name)s %(message)s"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "plain"}},
    "root": {"handlers": ["console"], "level": os.environ.get("DJANGO_LOG_LEVEL", "INFO")},
}

# ── DRF ───────────────────────────────────────────────────────────────────────
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["accounts.authentication.FirebaseAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "UNAUTHENTICATED_USER": None,
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.ScopedRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {
        "face_enroll": os.environ.get("FACE_RATE_ENROLL", "5/hour"),
        # Registration retries (network drops, expired receipts) must not lock
        # a new user out, so this is looser than plain enrollment.
        "face_register": os.environ.get("FACE_RATE_REGISTER", "20/hour"),
        "face_feature": os.environ.get("FACE_RATE_FEATURE", "20/hour"),
        "face_verify": os.environ.get("FACE_RATE_VERIFY", "20/hour"),
        "face_status": os.environ.get("FACE_RATE_STATUS", "60/hour"),
        # One image/feature per admin-assisted staff enrollment; keep tight.
        "face_agent_register": os.environ.get("FACE_RATE_AGENT_REGISTER", "10/hour"),
    },
}

# ── Encryption / auth / object store ─────────────────────────────────────────
FERNET_KEYS = _csv("FERNET_KEYS")
FIREBASE_SERVICE_ACCOUNT_PATH = os.environ.get("FIREBASE_SERVICE_ACCOUNT_PATH")
FIREBASE_SERVICE_ACCOUNT_JSON = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID")

S3_ENDPOINT = os.environ.get("S3_ENDPOINT", "http://localhost:9000")
S3_REGION = os.environ.get("S3_REGION", "us-east-1")
S3_BUCKET = os.environ.get("S3_BUCKET", "chitchat-media")
S3_ACCESS_KEY_ID = os.environ.get("S3_ACCESS_KEY_ID", "")
S3_SECRET_ACCESS_KEY = os.environ.get("S3_SECRET_ACCESS_KEY", "")
S3_FORCE_PATH_STYLE = _bool("S3_FORCE_PATH_STYLE", True)
FACE_S3_PREFIX = os.environ.get("FACE_S3_PREFIX", "face-embeddings")

# ── Face feature / matching ──────────────────────────────────────────────────
# The FaceAISDK returns a fixed 1024-char reference feature. Deployments must
# not change this.
FACE_FEATURE_LENGTH = int(os.environ.get("FACE_FEATURE_LENGTH", "1024"))
# Cosine similarity threshold for a server-side cross-check. The SDK already
# accepts/rejects on-device at `threshold` (default 0.83). The server uses a
# looser threshold because the two features come from different frames and
# some drift is normal.
FACE_MATCH_THRESHOLD = float(os.environ.get("FACE_MATCH_THRESHOLD", "0.6"))
FACE_MAX_FAILED_ATTEMPTS = int(os.environ.get("FACE_MAX_FAILED_ATTEMPTS", "5"))

# ── InsightFace (server-side ArcFace identity match) ─────────────────────────
# The authoritative identity match is computed on the server with InsightFace
# from the actual live face image, not asserted by the client. FaceAISDK still
# owns on-device liveness/anti-spoofing. A profile enrolled before InsightFace
# (no ArcFace reference) transparently falls back to the SDK cosine check.
#   INSIGHTFACE_MODEL_NAME   buffalo_l (default) is the standard ArcFace pack.
#   INSIGHTFACE_PROVIDERS    comma-sep onnxruntime providers; default CPU.
#                            e.g. "CUDAExecutionProvider,CPUExecutionProvider"
#   INSIGHTFACE_DET_SIZE     detector input square size (px).
#   INSIGHTFACE_MATCH_THRESHOLD  cosine threshold on ArcFace embeddings. ~0.42
#                            balances false accept/reject for buffalo_l; tune per
#                            deployment. (SDK-cosine fallback keeps its own
#                            FACE_MATCH_THRESHOLD.)
INSIGHTFACE_MODEL_NAME = os.environ.get("INSIGHTFACE_MODEL_NAME", "buffalo_l")
INSIGHTFACE_PROVIDERS = os.environ.get("INSIGHTFACE_PROVIDERS", "CPUExecutionProvider")
INSIGHTFACE_DET_SIZE = int(os.environ.get("INSIGHTFACE_DET_SIZE", "640"))
INSIGHTFACE_MATCH_THRESHOLD = float(os.environ.get("INSIGHTFACE_MATCH_THRESHOLD", "0.42"))
INSIGHTFACE_MAX_IMAGE_BYTES = int(
    os.environ.get("INSIGHTFACE_MAX_IMAGE_BYTES", str(8 * 1024 * 1024))
)
INSIGHTFACE_REJECT_MULTIPLE_FACES = _bool("INSIGHTFACE_REJECT_MULTIPLE_FACES", True)
# Minimum SDK liveness score (0..1) accepted in reported-account recovery.
FACE_MIN_LIVENESS_SCORE = float(os.environ.get("FACE_MIN_LIVENESS_SCORE", "0.5"))
# SDK result codes we accept as "the live person was confirmed":
#   1  = verify success (1:1 match + liveness, used by faceVerify)
#   10 = ALL_LIVENESS_SUCCESS (standalone liveness, no match)
FACE_ACCEPTED_LIVENESS_CODES = {1, 10}

# ── Reported-user verification receipt ───────────────────────────────────────
# Shared with the Node backend. Node verifies the HMAC before clearing a
# reported account's verification generation. Never expose through EXPO_PUBLIC_*.
FACE_VERIFICATION_RECEIPT_SECRET = os.environ.get(
    "FACE_VERIFICATION_RECEIPT_SECRET",
    "dev-insecure-face-verification-receipt-secret-change-me",
)
FACE_VERIFICATION_RECEIPT_TTL_SEC = int(
    os.environ.get("FACE_VERIFICATION_RECEIPT_TTL_SEC", "120")
)

# ── Administrator-assisted agent enrollment ──────────────────────────────────
# Separate from report recovery and self-enrollment. Node grants this only to an
# active business owner/admin; Django consumes it exactly once. It stores an
# encrypted agent feature extracted by the SDK on-device.
AGENT_FACE_ENROLLMENT_SECRET = os.environ.get(
    "AGENT_FACE_ENROLLMENT_SECRET",
    "dev-insecure-agent-face-enrollment-secret-change-me",
)
AGENT_FACE_ENROLLMENT_RECEIPT_TTL_SEC = int(
    os.environ.get("AGENT_FACE_ENROLLMENT_RECEIPT_TTL_SEC", "120")
)
