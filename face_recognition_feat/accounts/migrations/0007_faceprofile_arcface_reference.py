"""Add a server-side InsightFace (ArcFace) reference embedding to FaceProfile.

The 1024-char SDK feature stays as-is (cross-device restore + legacy fallback).
These additive fields point at a SECOND encrypted S3 object that holds the
ArcFace embedding computed on the server from the enrollment face image, so the
reported-account match can be made authoritatively from the real image rather
than from a client-supplied verdict.

Purely additive: existing rows get empty ``arcface_object_key`` and keep the
SDK cosine fallback until they re-enroll with an image.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0006_sdk_native_liveness"),
    ]

    operations = [
        migrations.AddField(
            model_name="faceprofile",
            name="arcface_object_key",
            field=models.CharField(blank=True, default="", max_length=512),
        ),
        migrations.AddField(
            model_name="faceprofile",
            name="arcface_key_version",
            field=models.PositiveSmallIntegerField(default=0),
        ),
        migrations.AddField(
            model_name="faceprofile",
            name="arcface_dim",
            field=models.PositiveSmallIntegerField(default=0),
        ),
    ]
