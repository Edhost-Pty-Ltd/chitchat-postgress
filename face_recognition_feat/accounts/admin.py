"""Django admin registrations for the face service's tables.

Both models are viewable in the admin. Biometric data itself is never shown:
the encrypted SDK feature and the InsightFace embedding live in private S3
objects, and only their object keys are stored in these rows.

Rules enforced here:
  • Nothing can be created from the admin. Face profiles come from the
    liveness-checked API, and agent grants are signed by Node.
  • Biometric pointers, signed-grant data and audit fields are read-only, so
    an admin edit cannot point a user at someone else's face data.
  • Deleting a face profile goes through ``face_service.delete_enrollment``,
    which removes the encrypted S3 objects as well as the row. The admin's
    default delete would leave those objects orphaned in storage.
  • Locked-out users can be unlocked with a bulk action (or by editing
    ``failed_attempts`` / ``locked_until``), and a stale profile can be deleted
    so the user can enroll again.

Django's own User and Group tables are registered automatically by
``django.contrib.auth``.
"""

from django.conf import settings
from django.contrib import admin, messages
from django.utils import timezone

from . import face_service
from .models import AdminAgentEnrollmentGrant, FaceProfile

admin.site.site_header = "ChitChat Face Service"
admin.site.site_title = "ChitChat Face Service admin"
admin.site.index_title = "Face service data"


class LockStatusFilter(admin.SimpleListFilter):
    title = "verification lock"
    parameter_name = "lock"

    def lookups(self, request, model_admin):
        return (("locked", "Locked"), ("unlocked", "Not locked"))

    def queryset(self, request, queryset):
        max_fail = settings.FACE_MAX_FAILED_ATTEMPTS
        locked_ids = [
            profile.pk
            for profile in queryset.only("pk", "failed_attempts", "locked_until")
            if _is_locked(profile, max_fail)
        ]
        if self.value() == "locked":
            return queryset.filter(pk__in=locked_ids)
        if self.value() == "unlocked":
            return queryset.exclude(pk__in=locked_ids)
        return queryset


class InsightFaceReferenceFilter(admin.SimpleListFilter):
    title = "InsightFace reference"
    parameter_name = "insightface"

    def lookups(self, request, model_admin):
        return (("yes", "Has reference"), ("no", "No reference (SDK only)"))

    def queryset(self, request, queryset):
        if self.value() == "yes":
            return queryset.exclude(arcface_object_key="")
        if self.value() == "no":
            return queryset.filter(arcface_object_key="")
        return queryset


def _is_locked(profile: FaceProfile, max_fail: int) -> bool:
    # Mirrors face_service.enrollment_status, which is what the API enforces.
    return profile.failed_attempts >= max_fail or (
        profile.locked_until is not None and profile.locked_until > timezone.now()
    )


@admin.register(FaceProfile)
class FaceProfileAdmin(admin.ModelAdmin):
    list_display = (
        "external_user_id",
        "enrollment_method",
        "has_insightface_reference",
        "is_locked",
        "failed_attempts",
        "last_verified_at",
        "created_at",
    )
    list_filter = (
        "enrollment_method",
        InsightFaceReferenceFilter,
        LockStatusFilter,
        "enrolled_with_liveness",
        "created_at",
    )
    search_fields = (
        "external_user_id",
        "enrolled_by_external_user_id",
        "enrollment_business_id",
    )
    ordering = ("-created_at",)
    date_hierarchy = "created_at"
    list_per_page = 50
    actions = ("unlock_profiles", "delete_profiles_and_face_data")

    # Only the verification-lock fields are editable.
    readonly_fields = (
        "external_user_id",
        "enrollment_method",
        "enrolled_with_liveness",
        "enrolled_by_external_user_id",
        "enrollment_business_id",
        "liveness_code",
        "liveness_score",
        "sdk_version",
        "embedding_object_key",
        "key_version",
        "feature_length",
        "arcface_object_key",
        "arcface_key_version",
        "arcface_dim",
        "last_verified_at",
        "created_at",
        "updated_at",
    )
    fieldsets = (
        ("User", {"fields": ("external_user_id",)}),
        (
            "Enrollment",
            {
                "fields": (
                    "enrollment_method",
                    "enrolled_with_liveness",
                    "enrolled_by_external_user_id",
                    "enrollment_business_id",
                    "liveness_code",
                    "liveness_score",
                    "sdk_version",
                )
            },
        ),
        (
            "Verification lock",
            {
                "fields": ("failed_attempts", "locked_until", "last_verified_at"),
                "description": (
                    "Verification is locked when failed attempts reach the "
                    "configured limit or 'locked until' is in the future. To "
                    "unlock, set failed attempts to 0 and clear 'locked until', "
                    "or use the 'Unlock' action on the list page."
                ),
            },
        ),
        (
            "Encrypted face data (stored in S3)",
            {
                "fields": (
                    "embedding_object_key",
                    "key_version",
                    "feature_length",
                    "arcface_object_key",
                    "arcface_key_version",
                    "arcface_dim",
                ),
                "description": (
                    "These are storage keys for encrypted objects, not the "
                    "face data itself. They cannot be changed here."
                ),
            },
        ),
        ("Timestamps", {"fields": ("created_at", "updated_at")}),
    )

    @admin.display(boolean=True, description="InsightFace ref")
    def has_insightface_reference(self, obj):
        return bool(obj.arcface_object_key)

    @admin.display(boolean=True, description="Locked")
    def is_locked(self, obj):
        return _is_locked(obj, settings.FACE_MAX_FAILED_ATTEMPTS)

    def has_add_permission(self, request):
        return False

    def get_actions(self, request):
        actions = super().get_actions(request)
        # Replaced by delete_profiles_and_face_data, which also cleans S3.
        actions.pop("delete_selected", None)
        return actions

    def delete_model(self, request, obj):
        # Remove the encrypted S3 objects too, not just the row.
        face_service.delete_enrollment(obj.external_user_id)

    def delete_queryset(self, request, queryset):
        for profile in queryset:
            face_service.delete_enrollment(profile.external_user_id)

    @admin.action(description="Unlock verification for selected profiles")
    def unlock_profiles(self, request, queryset):
        updated = 0
        for profile in queryset:
            profile.failed_attempts = 0
            profile.locked_until = None
            # save() rather than queryset.update() so updated_at is refreshed.
            profile.save(update_fields=["failed_attempts", "locked_until", "updated_at"])
            updated += 1
        self.message_user(request, f"Unlocked {updated} profile(s).", messages.SUCCESS)

    @admin.action(
        description="Delete selected profiles and their encrypted face data",
        permissions=["delete"],
    )
    def delete_profiles_and_face_data(self, request, queryset):
        deleted = 0
        for profile in queryset:
            if face_service.delete_enrollment(profile.external_user_id):
                deleted += 1
        self.message_user(
            request,
            f"Deleted {deleted} profile(s) and their encrypted face data. "
            "Those users must enroll their face again.",
            messages.SUCCESS,
        )


@admin.register(AdminAgentEnrollmentGrant)
class AdminAgentEnrollmentGrantAdmin(admin.ModelAdmin):
    """Signed one-time grants. Read-only: they are an audit trail and replay
    guard, so editing one could reopen a consumed grant."""

    list_display = (
        "id",
        "manager_external_user_id",
        "agent_external_user_id",
        "business_id",
        "status",
        "expires_at",
        "created_at",
    )
    list_filter = ("created_at", "expires_at")
    search_fields = (
        "id",
        "manager_external_user_id",
        "agent_external_user_id",
        "business_id",
    )
    ordering = ("-created_at",)
    date_hierarchy = "created_at"
    list_per_page = 50
    exclude = ("completion_receipt",)
    readonly_fields = (
        "id",
        "manager_external_user_id",
        "agent_external_user_id",
        "business_id",
        "status",
        "expires_at",
        "created_at",
        "consumed_at",
        "enrollment_succeeded_at",
        "completion_receipt_expires_at",
        "has_completion_receipt",
    )

    @admin.display(description="Status")
    def status(self, obj):
        if obj.enrollment_succeeded_at:
            return "Enrollment completed"
        if obj.consumed_at:
            return "Used"
        if obj.expires_at <= timezone.now():
            return "Expired (unused)"
        return "Active (unused)"

    @admin.display(boolean=True, description="Completion receipt stored")
    def has_completion_receipt(self, obj):
        return bool(obj.completion_receipt)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        # The detail page still opens, but every field is read-only.
        return False
