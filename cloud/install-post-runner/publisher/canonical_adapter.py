"""Version-pinned, no-network preview adapter for the canonical publisher.

Complete publishing is intentionally unavailable here. The existing cloud
runner is Webflow-only; allowing this adapter to call it would make partial
publication look complete.
"""

from __future__ import annotations

import hashlib
import importlib.util
import re
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any


class CanonicalPublisherError(RuntimeError):
    """The canonical source or complete-publisher contract is unavailable."""


class CanonicalPublisherAdapter:
    EXPECTED_X_HANDLE = "@MountingManTV"

    def __init__(
        self,
        *,
        scripts_dir: Path | str,
        expected_sha256: str,
        location_ids_path: Path | str | None = None,
    ):
        self.scripts_dir = Path(scripts_dir).expanduser().resolve()
        self.source_path = (self.scripts_dir / "fast_install_post.py").resolve()
        self.expected_sha256 = str(expected_sha256 or "").strip().lower()
        self.location_ids_path = Path(
            location_ids_path or self.scripts_dir.parent / "references" / "location-ids.md"
        ).expanduser().resolve()
        if not self.source_path.is_relative_to(self.scripts_dir):
            raise CanonicalPublisherError("canonical source escapes configured directory")
        if not self.source_path.is_file():
            raise CanonicalPublisherError("canonical publisher source is missing")
        if not re.fullmatch(r"[0-9a-f]{64}", self.expected_sha256):
            raise CanonicalPublisherError("canonical publisher SHA-256 is not configured")
        actual = hashlib.sha256(self.source_path.read_bytes()).hexdigest()
        if actual != self.expected_sha256:
            raise CanonicalPublisherError(
                f"canonical publisher source mismatch: expected {self.expected_sha256}, got {actual}"
            )
        self.source_sha256 = actual
        self.module = self._load_module()
        self._verify_contract()

    def _load_module(self) -> ModuleType:
        module_name = f"mounting_man_canonical_{self.source_sha256[:16]}"
        spec = importlib.util.spec_from_file_location(module_name, self.source_path)
        if spec is None or spec.loader is None:
            raise CanonicalPublisherError("canonical publisher could not be imported")
        module = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(self.scripts_dir))
        try:
            spec.loader.exec_module(module)
        except Exception as exc:  # pragma: no cover - exact import error is environment-specific
            raise CanonicalPublisherError(f"canonical publisher import failed: {exc}") from exc
        finally:
            try:
                sys.path.remove(str(self.scripts_dir))
            except ValueError:
                pass
        return module

    def _verify_contract(self) -> None:
        required = (
            "normalize_seed_post_data",
            "resolve_location_id",
            "load_location_id_city_map",
            "enrich_post_data",
            "build_platform_captions",
            "build_gbp_caption",
            "_reddit_title_builder",
            "_get_nearby_cities",
        )
        missing = [name for name in required if not callable(getattr(self.module, name, None))]
        if missing:
            raise CanonicalPublisherError(
                f"canonical publisher preview contract is missing: {', '.join(missing)}"
            )

    def preview(
        self,
        seed: dict[str, Any],
        *,
        live_url: str = "https://preview.invalid/installations/pending",
        image_url: str = "https://preview.invalid/installations/photo.webp",
    ) -> dict[str, Any]:
        if not isinstance(seed, dict):
            raise CanonicalPublisherError("canonical preview seed must be an object")
        if not live_url.startswith("https://preview.invalid/"):
            raise CanonicalPublisherError("canonical preview URL must use the non-routable preview host")
        if not image_url.startswith("https://preview.invalid/"):
            raise CanonicalPublisherError("canonical preview image must use the non-routable preview host")

        module = self.module
        post_data = module.normalize_seed_post_data(dict(seed))
        city = str(post_data.get("city") or "Twin Cities")
        location_id = str(post_data.get("location-id") or "").strip()
        if not location_id:
            location_id = str(module.resolve_location_id(
                city, SimpleNamespace(location_ids_path=self.location_ids_path)
            ))
        post_data["location-id"] = location_id
        post_data["nearby-cities"] = module._get_nearby_cities(city)
        location_map = module.load_location_id_city_map(self.location_ids_path)
        post_data = module.enrich_post_data(post_data, location_map)

        captions = module.build_platform_captions(post_data, live_url)
        gbp_caption = module.build_gbp_caption(post_data, live_url)
        reddit_title = module._reddit_title_builder(post_data)
        linkedin_without_tags = re.sub(
            r"\n\n#[^\n]+(\n#[^\n]+)*\s*$", "", captions["linkedin"]
        ).rstrip()
        reddit_comment = (
            linkedin_without_tags
            + "\n\n---\n\nMore photos and details on this install: "
            + live_url
        )
        reddit_common = {
            "title": reddit_title,
            "imageUrl": image_url,
            "commentBody": reddit_comment,
        }

        return {
            "canonicalSourceSha256": self.source_sha256,
            "website": {
                "title": post_data.get("title", ""),
                "slug": post_data.get("slug", ""),
                "summary": post_data.get("post-summary", ""),
                "body": post_data.get("post-body", ""),
                "city": city,
                "locationId": location_id,
            },
            "destinations": {
                "facebook": captions["facebook"],
                "instagram": captions["facebook"],
                "linkedin": captions["linkedin"],
                "x": {
                    "copy": captions["x"],
                    "expectedHandle": self.EXPECTED_X_HANDLE,
                },
                "google_business_profile": gbp_caption,
                "reddit_mountingman": {
                    **reddit_common,
                    "subreddit": "TheMountingMan",
                },
                "reddit_samsung_frame_mounting": {
                    **reddit_common,
                    "subreddit": "SamsungFrameMounting",
                    "expected": bool(post_data.get("gallery-style")),
                },
            },
        }

    def publish(self, *_args: Any, **_kwargs: Any) -> None:
        raise CanonicalPublisherError(
            "complete publisher unavailable: cloud destination receipts and workers are not configured"
        )
