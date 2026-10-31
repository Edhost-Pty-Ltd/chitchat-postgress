"""Compatibility import for the former standalone agent enrollment view.

The API is now organised in the conventional ``FaceViewSet`` in ``views.py``.
Keeping this alias avoids breaking a direct Python import while the URL router
uses the ViewSet action at ``POST /api/face/admin-register/``.
"""

from .views import FaceViewSet

admin_register_agent_face = FaceViewSet.as_view({"post": "admin_register"})
