"""
Server-side InsightFace (ArcFace) face-recognition engine.

This module is the one place that loads a neural network. It gives the service
an AUTHORITATIVE identity decision computed from the actual face image, rather
than trusting a client-asserted match or comparing two device-produced SDK
features. FaceAISDK on the device still owns LIVENESS/anti-spoofing; this engine
owns the MATCH.

Pipeline:
  base64/raw image bytes
    -> decode to BGR ndarray (OpenCV)
    -> InsightFace FaceAnalysis (detect + ArcFace embedding)
    -> L2-normalised 512-d float32 embedding
    -> cosine similarity against a stored embedding

Design choices:
  • Lazy, process-wide singleton. The ~300MB buffalo_l model is loaded once on
    first use and reused. Loading is guarded by a lock so concurrent requests
    don't each build their own analyzer.
  • CPU by default (onnxruntime CPUExecutionProvider). GPU is opt-in via
    INSIGHTFACE_PROVIDERS if the host has CUDA.
  • Never raises raw third-party errors to callers. Every failure becomes a
    typed InsightFaceError / NoFaceDetected the view layer already knows how to
    map, or is logged and surfaced as a stable code.
  • The embedding is stored as little-endian float32 bytes (same on-the-wire
    shape the Fernet envelope already carries), so storage.py / models.py need
    no new binary format — only a second object key.

If the heavy wheels are not installed (e.g. a dev box that only runs the SDK
feature path), importing insightface/cv2 fails lazily inside the loader, and
`is_available()` returns False so callers can degrade gracefully instead of
crashing at import time.
"""

from __future__ import annotations

import base64
import binascii
import logging
import struct
import threading
from typing import Optional

import numpy as np
from django.conf import settings

logger = logging.getLogger("accounts.insightface_engine")


class InsightFaceError(RuntimeError):
    """Operational failure (model load, decode, inference)."""


class InsightFaceNotInstalled(InsightFaceError):
    """The insightface/onnxruntime/opencv wheels are not available."""


class NoFaceDetected(InsightFaceError):
    """The image decoded, but no (or too many) faces were found."""


# InsightFace ArcFace embeddings are 512-d float32.
EMBEDDING_DIM = 512

_analyzer = None
_analyzer_lock = threading.Lock()
_load_error: Optional[str] = None


def _provider_list() -> list[str]:
    raw = getattr(settings, "INSIGHTFACE_PROVIDERS", "") or ""
    providers = [p.strip() for p in raw.split(",") if p.strip()]
    return providers or ["CPUExecutionProvider"]


def _load_analyzer():
    """Build the process-wide FaceAnalysis once. Raises a typed error on failure."""
    global _analyzer, _load_error
    if _analyzer is not None:
        return _analyzer
    with _analyzer_lock:
        if _analyzer is not None:
            return _analyzer
        if _load_error is not None:
            # A previous attempt already failed; don't hammer the loader.
            raise InsightFaceNotInstalled(_load_error)
        try:
            from insightface.app import FaceAnalysis  # type: ignore
        except Exception as exc:  # ImportError or a transitive dep failure
            _load_error = f"insightface is not installed: {exc}"
            logger.error("%s", _load_error)
            raise InsightFaceNotInstalled(_load_error) from exc

        model_name = getattr(settings, "INSIGHTFACE_MODEL_NAME", "buffalo_l")
        det_size = int(getattr(settings, "INSIGHTFACE_DET_SIZE", 640))
        try:
            app = FaceAnalysis(
                name=model_name,
                providers=_provider_list(),
                # Only the detector + recognition modules are needed for a
                # match. Dropping landmark/attribute modules speeds load + infer.
                allowed_modules=["detection", "recognition"],
            )
            app.prepare(ctx_id=0, det_size=(det_size, det_size))
        except Exception as exc:
            _load_error = f"could not prepare InsightFace model '{model_name}': {exc}"
            logger.exception("InsightFace model preparation failed")
            raise InsightFaceError(_load_error) from exc

        _analyzer = app
        logger.info(
            "InsightFace ready: model=%s providers=%s det_size=%d",
            model_name,
            _provider_list(),
            det_size,
        )
        return _analyzer


def is_available() -> bool:
    """True when the model can be (or already is) loaded. Never raises."""
    if _analyzer is not None:
        return True
    try:
        _load_analyzer()
        return True
    except InsightFaceError:
        return False


def warm_up() -> dict:
    """Readiness probe for health checks. Never raises."""
    try:
        _load_analyzer()
        return {"insightface_ok": True, "insightface_error": None}
    except InsightFaceError as exc:
        return {"insightface_ok": False, "insightface_error": str(exc)}


def _base64_to_bytes(payload: str, max_bytes: int) -> bytes:
    """Decode the SDK's base64 face image into raw bytes.

    iOS sends standard base64. Android's encoder may wrap lines, use the
    URL-safe alphabet or drop padding, so normalise all of those before a
    strict decode. A data URL prefix ("data:image/jpeg;base64,") is accepted.
    """
    # Base64 is ~4/3 of the decoded size; bound the input before any work.
    if len(payload) > max_bytes * 2:
        raise InsightFaceError("image_too_large")
    if payload.startswith("data:"):
        comma = payload.find(",")
        if comma != -1:
            payload = payload[comma + 1 :]
    payload = "".join(payload.split())  # drop newlines/whitespace from wrapping
    payload = payload.replace("-", "+").replace("_", "/")  # URL-safe → standard
    payload = payload.rstrip("=")
    payload += "=" * (-len(payload) % 4)  # restore stripped padding
    try:
        return base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise InsightFaceError(f"image is not valid base64: {exc}") from exc


def _detect(app, bgr: "np.ndarray") -> list:
    try:
        return app.get(bgr)
    except Exception as exc:
        logger.exception("InsightFace inference failed")
        raise InsightFaceError(f"inference failed: {exc}") from exc


def _pad_for_detection(bgr: "np.ndarray") -> "np.ndarray":
    """Add a black border of 30% of the longer side on every edge.

    FaceAISDK's enrollment image is a cropped face (``croppedFaceImage``).
    Face detectors are trained on faces with surrounding context and can miss
    a face that fills the whole frame, so a padded copy is used as a one-time
    retry when the first detection finds nothing.
    """
    h, w = bgr.shape[:2]
    pad = int(round(max(h, w) * 0.3))
    return np.pad(bgr, ((pad, pad), (pad, pad), (0, 0)), mode="constant", constant_values=0)


def _decode_image(image: object) -> "np.ndarray":
    """Decode a base64 string or raw bytes into a BGR uint8 ndarray.

    Accepts a data URL ("data:image/jpeg;base64,...") or a bare base64 string
    or raw bytes. Rejects anything that is not a decodable image. Enforces a
    byte-size ceiling BEFORE decoding so a hostile client can't exhaust memory.
    """
    try:
        import cv2  # type: ignore
    except Exception as exc:
        raise InsightFaceNotInstalled(f"opencv is not installed: {exc}") from exc

    max_bytes = int(getattr(settings, "INSIGHTFACE_MAX_IMAGE_BYTES", 8 * 1024 * 1024))

    if isinstance(image, (bytes, bytearray)):
        raw = bytes(image)
    elif isinstance(image, str):
        raw = _base64_to_bytes(image, max_bytes)
    else:
        raise InsightFaceError("image must be base64 string or bytes")

    if not raw:
        raise InsightFaceError("image payload was empty")
    if len(raw) > max_bytes:
        raise InsightFaceError("image_too_large")

    arr = np.frombuffer(raw, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise InsightFaceError("image could not be decoded")
    return bgr


def embedding_from_image(image: object) -> "np.ndarray":
    """Detect the single most prominent face and return its ArcFace embedding.

    Returns an L2-normalised 512-d float32 ndarray. Raises NoFaceDetected when
    the image has no face (or, in strict mode, more than one).
    """
    app = _load_analyzer()
    bgr = _decode_image(image)
    faces = _detect(app, bgr)
    if not faces:
        # Tight SDK crops can defeat the detector; retry once with margin.
        faces = _detect(app, _pad_for_detection(bgr))

    if not faces:
        raise NoFaceDetected("no_face_detected")

    strict_single = bool(getattr(settings, "INSIGHTFACE_REJECT_MULTIPLE_FACES", True))
    if strict_single and len(faces) > 1:
        # A verification frame must contain exactly one subject; more than one
        # is either a spoof attempt or a bad capture.
        raise NoFaceDetected("multiple_faces_detected")

    # Largest detected box = closest/most prominent subject.
    def _area(face) -> float:
        x1, y1, x2, y2 = face.bbox
        return float(max(0.0, x2 - x1) * max(0.0, y2 - y1))

    face = max(faces, key=_area)
    # `normed_embedding` is already L2-normalised in modern insightface; guard
    # for older builds that only expose the raw `embedding`.
    emb = getattr(face, "normed_embedding", None)
    if emb is None:
        emb = getattr(face, "embedding", None)
    if emb is None:
        raise InsightFaceError("model returned no embedding")
    vec = np.asarray(emb, dtype=np.float32).reshape(-1)
    if vec.shape[0] != EMBEDDING_DIM:
        # Not fatal for the math, but a strong signal the wrong model loaded.
        logger.warning("Unexpected embedding dim %d (expected %d)", vec.shape[0], EMBEDDING_DIM)
    return _l2_normalize(vec)


def _l2_normalize(vec: "np.ndarray") -> "np.ndarray":
    norm = float(np.linalg.norm(vec))
    if norm == 0.0:
        return vec
    return (vec / norm).astype(np.float32)


# ── Embedding (de)serialisation for storage ──────────────────────────────────
def embedding_to_bytes(vec: "np.ndarray") -> bytes:
    """Little-endian float32 bytes, ready for the Fernet envelope."""
    v = np.asarray(vec, dtype="<f4").reshape(-1)
    return v.tobytes()


def embedding_from_bytes(raw: bytes) -> "np.ndarray":
    if not raw or len(raw) % 4 != 0:
        raise InsightFaceError("stored embedding has an invalid byte length")
    n = len(raw) // 4
    vec = np.frombuffer(raw, dtype="<f4", count=n).astype(np.float32)
    return vec


def cosine_similarity(a: "np.ndarray", b: "np.ndarray") -> float:
    """Cosine similarity between two embeddings (both assumed finite)."""
    va = np.asarray(a, dtype=np.float32).reshape(-1)
    vb = np.asarray(b, dtype=np.float32).reshape(-1)
    if va.shape != vb.shape:
        raise InsightFaceError("embedding dimensionality mismatch")
    na = float(np.linalg.norm(va))
    nb = float(np.linalg.norm(vb))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return float(np.dot(va, vb) / (na * nb))
