"""Preview image decoding / limiting / compression.

The service never stores the uploaded file: bytes are decoded, orientation is
normalised from EXIF, metadata (EXIF/ICC/XMP/comments) is dropped by
re-encoding, and only the small WebP result is kept.

Hard limits (enforced here, independent of the HTTP layer):

* input ≤ 5 MiB raw bytes
* ≤ 16 megapixels decoded, single frame, static PNG / JPEG / WebP only
* output long edge ≤ 480 px and ≤ 64 KiB

Anything else is a controlled :class:`ImageError` (mapped to ``400`` by the
API layer); the message never contains image content.
"""

from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass

from PIL import Image, ImageFile, ImageOps, UnidentifiedImageError

MIN_INPUT_BYTES = 1
MAX_INPUT_BYTES = 5 * 1024 * 1024
MAX_PIXELS = 16_000_000
MAX_OUTPUT_EDGE = 480
MAX_OUTPUT_BYTES = 64 * 1024
OUTPUT_MIME = "image/webp"

ALLOWED_FORMATS = frozenset({"PNG", "JPEG", "WEBP"})
# Uploads may declare these; anything else is rejected before decoding.
ALLOWED_INPUT_MIME = frozenset(
    {"image/png", "image/jpeg", "image/jpg", "image/webp", "application/octet-stream"}
)

# Never silently decode partial files: truncated uploads must be rejected.
ImageFile.LOAD_TRUNCATED_IMAGES = False

_QUALITY_STEPS = (82, 74, 66, 58, 50, 42, 34)
_SHRINK_STEP = 0.85


class ImageError(ValueError):
    """Invalid/unsupported upload; the message is safe to return to clients."""


@dataclass(frozen=True)
class ProcessedImage:
    data: bytes
    width: int
    height: int
    bytes: int
    mime: str
    sha256: str

    def as_asset(self) -> dict:
        return {
            "sha256": self.sha256,
            "mime": self.mime,
            "width": self.width,
            "height": self.height,
            "bytes": self.bytes,
            "data": self.data,
        }


def _decode(raw: bytes) -> Image.Image:
    if len(raw) < MIN_INPUT_BYTES:
        raise ImageError("image body is empty")
    if len(raw) > MAX_INPUT_BYTES:
        raise ImageError(f"image exceeds {MAX_INPUT_BYTES} bytes")
    try:
        # Hard cap on decoding; the strict 16 MP policy is checked below, this
        # only turns obvious decompression bombs into a controlled rejection.
        Image.MAX_IMAGE_PIXELS = MAX_PIXELS * 2
        image = Image.open(io.BytesIO(raw))
        fmt = (image.format or "").upper()
        if fmt not in ALLOWED_FORMATS:
            raise ImageError("image must be a static PNG, JPEG or WebP")
        if getattr(image, "is_animated", False) or getattr(image, "n_frames", 1) > 1:
            raise ImageError("animated images are not supported")
        width, height = image.size
        if width <= 0 or height <= 0:
            raise ImageError("image has no pixels")
        if width * height > MAX_PIXELS:
            raise ImageError(f"image exceeds {MAX_PIXELS} pixels")
        image.load()
    except ImageError:
        raise
    except Image.DecompressionBombError:
        raise ImageError("image is too large to decode")
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, MemoryError):
        raise ImageError("image is not a valid PNG, JPEG or WebP")
    return image


def _flatten(image: Image.Image) -> Image.Image:
    """Normalise orientation, drop alpha and force a WebP-friendly mode."""
    try:
        image = ImageOps.exif_transpose(image) or image
    except (OSError, ValueError):
        raise ImageError("image EXIF metadata is invalid")
    if image.mode in ("RGBA", "LA", "PA") or (
        image.mode == "P" and "transparency" in image.info
    ):
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.split()[-1])
        return background
    if image.mode != "RGB":
        return image.convert("RGB")
    return image


def _fit(image: Image.Image) -> Image.Image:
    if max(image.size) <= MAX_OUTPUT_EDGE:
        return image
    fitted = image.copy()
    fitted.thumbnail((MAX_OUTPUT_EDGE, MAX_OUTPUT_EDGE), Image.LANCZOS)
    return fitted


def _encode(image: Image.Image) -> tuple[bytes, int, int]:
    """Return ``(webp_bytes, width, height)`` of the bytes actually produced.

    Shrinking may change the size, so callers must use the returned dimensions
    rather than the input image's.
    """
    current = image
    for _ in range(8):
        for quality in _QUALITY_STEPS:
            buffer = io.BytesIO()
            current.save(buffer, format="WEBP", quality=quality, method=6)
            data = buffer.getvalue()
            if len(data) <= MAX_OUTPUT_BYTES:
                return data, current.width, current.height
        width = max(1, int(current.width * _SHRINK_STEP))
        height = max(1, int(current.height * _SHRINK_STEP))
        if (width, height) == current.size:
            break
        current = current.resize((width, height), Image.LANCZOS)
    raise ImageError("image cannot be compressed below the size limit")


def process_image(raw: bytes) -> ProcessedImage:
    """Decode, normalise and re-encode ``raw`` into the stored WebP preview."""
    image = _decode(raw)
    prepared = _fit(_flatten(image))
    data, width, height = _encode(prepared)
    return ProcessedImage(
        data=data,
        width=width,
        height=height,
        bytes=len(data),
        mime=OUTPUT_MIME,
        sha256=hashlib.sha256(data).hexdigest(),
    )


__all__ = [
    "ALLOWED_INPUT_MIME",
    "MAX_INPUT_BYTES",
    "MAX_OUTPUT_BYTES",
    "MAX_OUTPUT_EDGE",
    "MAX_PIXELS",
    "OUTPUT_MIME",
    "ImageError",
    "ProcessedImage",
    "process_image",
]
