"""URL routing for the accounts API.

A DRF router keeps the public paths grouped under ``/api/face/`` while
``FaceViewSet`` keeps each action close to the others in ``views.py``.
"""

from rest_framework.routers import SimpleRouter

from .views import FaceViewSet

# SimpleRouter adds only the explicit ViewSet actions below. It does not add a
# browsable API root or model CRUD endpoints, so every current mobile path is
# preserved exactly and no biometric profile listing route is exposed.
router = SimpleRouter()
router.register(r"api/face", FaceViewSet, basename="face")

urlpatterns = router.urls
