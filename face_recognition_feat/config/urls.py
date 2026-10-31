from django.urls import include, path
from django.contrib import admin

# The accounts app owns the /api/face/* routes. We mount it at the root so the
# app's own paths ("api/face/...") are the full paths — no accidental double
# "/api/" prefix.
urlpatterns = [
    path("admin/",admin.site.urls),
    path("", include("accounts.urls")),
]
