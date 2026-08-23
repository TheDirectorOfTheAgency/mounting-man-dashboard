"""Unmount copy stays unmount copy. Mount CTA policy is unchanged."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "publisher"))

from content import (  # noqa: E402
    build_seo_slug,
    build_seo_title,
    enrich_post_data,
    generate_post_body,
    generate_post_summary,
)


MOUNT_SEED = {
    "city": "Edina",
    "tv-size": '65"',
    "tv-brand": "Samsung",
    "wall-surface": "Stone",
    "street-name": "Elm Street",
}

UNMOUNT_SEED = {
    "city": "Oakdale",
    "state": "Minnesota",
    "job-type": "unmount",
    "tv-size": '86"',
    "street-name": "2nd Street North Unit 4",
    "local-reference": "2nd Street North Apt 4",
    "seed-index": 1,
    "seed-count": 1,
}


def test_unmount_title_and_body_read_as_unmounting_not_a_mount():
    city = "Oakdale"
    title = build_seo_title(UNMOUNT_SEED, city)
    slug = build_seo_slug(UNMOUNT_SEED, city)
    body = generate_post_body(UNMOUNT_SEED, city)
    summary = generate_post_summary(UNMOUNT_SEED, city)

    assert "TV Unmounting" in title
    assert "TV Mounting" not in title
    assert "tv-unmounting" in slug
    assert "tv-mounting" not in slug
    assert "took down" in body.lower() or "unmount" in body.lower()
    assert "We mounted this" not in body
    assert "before shot" in body.lower()
    assert "unmounting" in summary.lower()


def test_unmount_copy_never_emits_a_unit_number():
    enriched = enrich_post_data(dict(UNMOUNT_SEED), {})
    blob = " ".join(str(enriched.get(key) or "") for key in ("title", "slug", "post-summary", "post-body"))
    for forbidden in ("Unit 4", "Apt 4", "Apartment", "#4"):
        assert forbidden.lower() not in blob.lower(), blob
    assert "2nd Street North" in enriched["title"]


def test_unmount_does_not_invent_wall_type():
    body = generate_post_body(UNMOUNT_SEED, "Oakdale")
    title = build_seo_title(UNMOUNT_SEED, "Oakdale")
    assert "Drywall" not in body
    assert "Drywall" not in title
    assert "Wall Type" not in body


def test_unmount_keeps_the_famous_mounter_cta():
    body = generate_post_body(UNMOUNT_SEED, "Oakdale")
    assert "professional TV mounting services" in body
    assert "themountingman.com/tv-mounting" in body
    assert "TV Mounting in Oakdale" in body


def test_mount_copy_and_cta_are_unchanged():
    title = build_seo_title(MOUNT_SEED, "Edina")
    body = generate_post_body(MOUNT_SEED, "Edina")
    assert title.startswith("Samsung TV Installation in Edina") or "TV Mounting" in title or "Installation" in title
    assert "We mounted this" in body
    assert "professional TV mounting services" in body
    assert "TV Unmounting" not in title
    assert "took down" not in body.lower()
