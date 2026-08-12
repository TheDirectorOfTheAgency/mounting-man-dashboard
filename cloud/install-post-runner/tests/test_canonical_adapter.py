from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

import pytest

PUBLISHER_DIR = Path(__file__).resolve().parents[1] / "publisher"
sys.path.insert(0, str(PUBLISHER_DIR))

from canonical_adapter import CanonicalPublisherAdapter, CanonicalPublisherError


CANONICAL_DIR = Path(
    os.environ.get(
        "CANONICAL_INSTALL_POST_SCRIPTS",
        "/Users/thedirector/.hermes/skills/business-ops/"
        "mounting-man-installation-posts-hermes/scripts",
    )
)
CANONICAL_SOURCE = CANONICAL_DIR / "fast_install_post.py"
PINNED_SHA256 = "82c310f51098161df35be3658f8e1131e012594c1e5d4e9811e5dd636b0fb7ab"


def canonical_adapter() -> CanonicalPublisherAdapter:
    assert CANONICAL_SOURCE.is_file(), (
        "Canonical publisher source is required for parity testing; set "
        "CANONICAL_INSTALL_POST_SCRIPTS to its packaged scripts directory"
    )
    return CanonicalPublisherAdapter(
        scripts_dir=CANONICAL_DIR,
        expected_sha256=PINNED_SHA256,
    )


def test_pinned_source_is_the_actual_canonical_publisher() -> None:
    adapter = canonical_adapter()
    actual = hashlib.sha256(CANONICAL_SOURCE.read_bytes()).hexdigest()
    assert actual == PINNED_SHA256 == adapter.source_sha256


def test_hash_mismatch_and_missing_source_fail_closed(tmp_path: Path) -> None:
    with pytest.raises(CanonicalPublisherError, match="source is missing"):
        CanonicalPublisherAdapter(scripts_dir=tmp_path, expected_sha256="a" * 64)
    with pytest.raises(CanonicalPublisherError, match="source mismatch"):
        CanonicalPublisherAdapter(scripts_dir=CANONICAL_DIR, expected_sha256="a" * 64)


def test_preview_uses_canonical_builders_for_every_v1_destination() -> None:
    preview = canonical_adapter().preview(
        {
            "city": "Austin",
            "state": "TX",
            "location-id": "test-location-id",
            "tv-size": '65"',
            "tv-brand": "Samsung Frame",
            "wall-surface": "Drywall",
            "mount-type": "Slim fixed mount",
            "gallery-style": True,
            "price": "$425.00",
            "street-name": "Susan Drive",
        }
    )
    assert preview["website"]["title"]
    assert preview["website"]["body"]
    assert set(preview["destinations"]) == {
        "facebook",
        "instagram",
        "linkedin",
        "x",
        "google_business_profile",
        "reddit_mountingman",
        "reddit_samsung_frame_mounting",
    }
    assert preview["destinations"]["x"]["expectedHandle"] == "@MountingManTV"
    assert preview["destinations"]["reddit_mountingman"]["subreddit"] == "TheMountingMan"
    assert preview["destinations"]["reddit_samsung_frame_mounting"]["expected"] is True
    serialized = repr(preview)
    assert "preview.invalid" in serialized
    assert "1234 Susan Drive" not in serialized
    assert "owner@example.com" not in serialized


def test_complete_publish_cannot_degrade_to_webflow_only() -> None:
    with pytest.raises(CanonicalPublisherError, match="complete publisher unavailable"):
        canonical_adapter().publish({"manifestId": "manifest_test"})
