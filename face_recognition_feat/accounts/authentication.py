"""
Firebase authentication for DRF.

The existing React Native app authenticates with Firebase (phone OTP) and the
Node backend verifies those ID tokens with the Firebase Admin SDK, mapping the
uid to its Postgres users.id. This service verifies the SAME ID tokens and
resolves the identity to that uid. We never trust a client-supplied user id.

Because Django does not own the users, `request.user` is a lightweight
principal (`FirebaseUser`) carrying the verified uid — not a django.contrib.auth
User. It satisfies DRF's `IsAuthenticated` (is_authenticated == True).

Firebase Admin is initialized ONCE, lazily, and will reuse an already-created
default app if one exists (so running inside a process that already initialized
it does not double-initialize).
"""

from __future__ import annotations

import json
import logging
import threading

from django.conf import settings
from rest_framework import authentication, exceptions

logger = logging.getLogger("accounts.authentication")

_init_lock = threading.Lock()
_initialized = False


class FirebaseUser:
    """Minimal authenticated principal backed by a verified Firebase uid."""

    def __init__(self, uid: str, claims: dict):
        self.uid = uid
        self.claims = claims

    # DRF / Django duck-typing
    @property
    def is_authenticated(self) -> bool:
        return True

    @property
    def is_anonymous(self) -> bool:
        return False

    def __str__(self):  # pragma: no cover
        return f"FirebaseUser({self.uid})"


def _ensure_firebase():
    global _initialized
    if _initialized:
        return
    with _init_lock:
        if _initialized:
            return
        import firebase_admin
        from firebase_admin import credentials

        # Reuse an existing default app if the process already created one.
        try:
            firebase_admin.get_app()
            _initialized = True
            return
        except ValueError:
            pass

        cred = None
        if settings.FIREBASE_SERVICE_ACCOUNT_JSON:
            cred = credentials.Certificate(json.loads(settings.FIREBASE_SERVICE_ACCOUNT_JSON))
        elif settings.FIREBASE_SERVICE_ACCOUNT_PATH:
            cred = credentials.Certificate(settings.FIREBASE_SERVICE_ACCOUNT_PATH)

        options = {}
        if settings.FIREBASE_PROJECT_ID:
            options["projectId"] = settings.FIREBASE_PROJECT_ID

        if cred is not None:
            firebase_admin.initialize_app(cred, options or None)
        else:
            # Application Default Credentials (e.g. GOOGLE_APPLICATION_CREDENTIALS).
            firebase_admin.initialize_app(options=options or None)
        _initialized = True


class FirebaseAuthentication(authentication.BaseAuthentication):
    keyword = "Bearer"

    def authenticate(self, request):
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if not header:
            return None  # no credentials → let IsAuthenticated produce 401
        parts = header.split()
        if len(parts) != 2 or parts[0].lower() != self.keyword.lower():
            raise exceptions.AuthenticationFailed("Invalid Authorization header")
        token = parts[1]

        try:
            _ensure_firebase()
            from firebase_admin import auth as fb_auth

            decoded = fb_auth.verify_id_token(token, check_revoked=True)
        except Exception as exc:
            # Do not leak internal details; log server-side only.
            logger.warning("Firebase token verification failed: %s", type(exc).__name__)
            raise exceptions.AuthenticationFailed("Invalid or expired token")

        uid = decoded.get("uid")
        if not uid:
            raise exceptions.AuthenticationFailed("Token missing uid")
        return (FirebaseUser(uid, decoded), token)

    def authenticate_header(self, request):
        return self.keyword
