"""Drop server-side liveness/challenge/attestation state after moving liveness
to the on-device FaceAISDK."""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0005_adminagentenrollmentgrant_completion_receipt_and_more"),
    ]

    operations = [
        # ── Rename the old constraint to match the new field name ────────────
        migrations.RemoveConstraint(
            model_name="faceprofile",
            name="face_profile_embedding_dim_positive",
        ),
        # ── Replace embedding_dim with feature_length (1024 chars, 512 bytes).
        migrations.RemoveField(
            model_name="faceprofile",
            name="embedding_dim",
        ),
        migrations.RemoveField(
            model_name="faceprofile",
            name="embedding_model",
        ),
        migrations.AddField(
            model_name="faceprofile",
            name="feature_length",
            field=models.PositiveSmallIntegerField(default=1024),
        ),
        migrations.AddField(
            model_name="faceprofile",
            name="sdk_version",
            field=models.CharField(blank=True, default="", max_length=32),
        ),
        # ── Replace the FacePing attestation fields with the SDK's own result.
        migrations.RemoveField(
            model_name="faceprofile",
            name="faceping_outcome",
        ),
        migrations.RemoveField(
            model_name="faceprofile",
            name="faceping_liveness_score",
        ),
        migrations.RemoveField(
            model_name="faceprofile",
            name="faceping_sdk_version",
        ),
        migrations.RemoveField(
            model_name="faceprofile",
            name="liveness_actions",
        ),
        migrations.AddField(
            model_name="faceprofile",
            name="liveness_code",
            field=models.PositiveSmallIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="faceprofile",
            name="liveness_score",
            field=models.FloatField(default=0.0),
        ),
        migrations.AddConstraint(
            model_name="faceprofile",
            constraint=models.CheckConstraint(
                check=models.Q(feature_length__gt=0),
                name="face_profile_feature_length_positive",
            ),
        ),
        # ── The LivenessChallenge table is gone — SDK handles challenges. ─────
        migrations.DeleteModel(name="LivenessChallenge"),
    ]
