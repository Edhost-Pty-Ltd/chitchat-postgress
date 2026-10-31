from rest_framework.permissions import BasePermission


class IsFirebaseAuthenticated(BasePermission):
    """
    Allow only requests carrying a verified Firebase identity. Equivalent to
    DRF's IsAuthenticated for our FirebaseUser principal, but explicit so the
    intent is clear on the biometric endpoints.
    """

    message = "Authentication required."

    def has_permission(self, request, view):
        user = getattr(request, "user", None)
        return bool(user and getattr(user, "is_authenticated", False) and getattr(user, "uid", None))
