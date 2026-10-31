"""
S3/MinIO storage for ENCRYPTED EMBEDDINGS only.

Replaces the Firebase Storage helpers from supplied Source-C. The mandatory
requirement is to reuse the Node backend's existing bucket (MinIO locally,
`chitchat-media`) via boto3 with the same credentials/endpoint. We store the
encrypted embedding bytes (never a raw photo) under a private key prefix and
return only the object key.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from django.conf import settings

logger = logging.getLogger("accounts.storage")


class StorageError(RuntimeError):
    pass


_client = None
_client_lock = threading.Lock()


def _s3():
    global _client
    if _client is not None:
        return _client
    with _client_lock:
        if _client is not None:
            return _client
        _client = boto3.client(
            "s3",
            endpoint_url=settings.S3_ENDPOINT,
            region_name=settings.S3_REGION,
            aws_access_key_id=settings.S3_ACCESS_KEY_ID,
            aws_secret_access_key=settings.S3_SECRET_ACCESS_KEY,
            # Path-style addressing is required for MinIO.
            config=Config(s3={"addressing_style": "path" if settings.S3_FORCE_PATH_STYLE else "auto"}),
        )
        return _client


def put_embedding(object_key: str, ciphertext: bytes) -> None:
    """Upload encrypted embedding bytes. Private object; no ACL made public."""
    try:
        _s3().put_object(
            Bucket=settings.S3_BUCKET,
            Key=object_key,
            Body=ciphertext,
            ContentType="application/octet-stream",
        )
    except ClientError as exc:
        # Do not leak bucket internals / credentials to callers.
        logger.error("S3 put_object failed for key=%s: %s", object_key, exc.response.get("Error", {}).get("Code"))
        raise StorageError("Could not store encrypted embedding.") from exc


def get_embedding(object_key: str) -> Optional[bytes]:
    """Download encrypted embedding bytes, or None if the object is missing."""
    try:
        res = _s3().get_object(Bucket=settings.S3_BUCKET, Key=object_key)
        return res["Body"].read()
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code in ("NoSuchKey", "404", "NotFound"):
            return None
        logger.error("S3 get_object failed for key=%s: %s", object_key, code)
        raise StorageError("Could not read encrypted embedding.") from exc


def delete_embedding(object_key: str) -> bool:
    """Best-effort delete. Returns True on success; logs (privacy-safe) on failure."""
    try:
        _s3().delete_object(Bucket=settings.S3_BUCKET, Key=object_key)
        return True
    except ClientError as exc:
        logger.error(
            "S3 delete_object failed for key=%s: %s — object may need manual cleanup",
            object_key,
            exc.response.get("Error", {}).get("Code"),
        )
        return False
