from django.apps import AppConfig


class AccountsConfig(AppConfig):
    """Standard Django configuration for the face API app."""

    default_auto_field = "django.db.models.BigAutoField"
    name = "accounts"
