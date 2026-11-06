"""THE-219: Frame / MantelMount / both / standard_tv specialty copy."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "publisher"))

from content import (  # noqa: E402
    SPECIALTY_BOTH,
    SPECIALTY_MANTELMOUNT,
    SPECIALTY_SAMSUNG_FRAME,
    SPECIALTY_STANDARD_TV,
    build_extractable_sentence,
    build_seo_title,
    build_seo_slug,
    classify_install_specialty,
    generate_post_body,
    job_used_frame,
    job_used_mantel,
    select_related_installs,
)
from social import SOCIAL_DESTINATIONS, SocialBlockedError, build_social_caption  # noqa: E402

LIVE_URL = "https://www.themountingman.com/installations/test-install"
FORBIDDEN_CLAIMS = ("best installer", "recommended by chatgpt", "best in", "#1")

FRAME_SEED = {
    "city": "Minnetonka",
    "tv-size": '65"',
    "tv-brand": "Samsung Frame",
    "wall-surface": "Wood Slat",
    "gallery-style": True,
    "mantelmount": False,
    "street-name": "Sunset Trail",
}

MANTEL_SEED = {
    "city": "Edina",
    "tv-size": '75"',
    "tv-brand": "Sony",
    "wall-surface": "Stacked Stone",
    "fireplace-type": "Stacked Stone",
    "mount-type": "MantelMount MM540",
    "mantelmount": True,
    "gallery-style": False,
    "street-name": "Valley View",
}

BOTH_SEED = {
    "city": "Wayzata",
    "tv-size": '65"',
    "tv-brand": "Samsung Frame",
    "wall-surface": "Stone",
    "fireplace-type": "Stone Fireplace",
    "mount-type": "MantelMount MM700",
    "mantelmount": True,
    "gallery-style": True,
    "street-name": "Lake Street",
}

STANDARD_SEED = {
    "city": "Minneapolis",
    "tv-size": '65"',
    "tv-brand": "Samsung",
    "wall-surface": "Drywall",
    "gallery-style": False,
    "mantelmount": False,
    "street-name": "Lake Street",
}

HISENSE_GALLERY_SEED = {
    "city": "Plymouth",
    "tv-size": '55"',
    "tv-brand": "Hisense Canvas",
    "wall-surface": "Drywall",
    "gallery-style": True,
    "mantelmount": False,
}

SOUNDBAR_SEED = {
    "city": "Minneapolis",
    "tv-size": '65"',
    "tv-brand": "Samsung",
    "wall-surface": "Drywall",
    "gallery-style": False,
    "mantelmount": False,
    "job-notes": "Soundbar Bracket (Frame / Gallery) Yes - Premium Bracket",
}


def _captions(seed: dict) -> dict[str, str]:
    return {
        platform: build_social_caption(seed, LIVE_URL, platform=platform)
        for platform in SOCIAL_DESTINATIONS
    }


def test_classify_frame_mantel_both_and_standard():
    assert classify_install_specialty(FRAME_SEED) == SPECIALTY_SAMSUNG_FRAME
    assert classify_install_specialty(MANTEL_SEED) == SPECIALTY_MANTELMOUNT
    assert classify_install_specialty(BOTH_SEED) == SPECIALTY_BOTH
    assert classify_install_specialty(STANDARD_SEED) == SPECIALTY_STANDARD_TV
    assert job_used_frame(FRAME_SEED) is True
    assert job_used_mantel(FRAME_SEED) is False
    assert job_used_frame(MANTEL_SEED) is False
    assert job_used_mantel(MANTEL_SEED) is True
    assert job_used_frame(BOTH_SEED) is True
    assert job_used_mantel(BOTH_SEED) is True
    assert job_used_frame(STANDARD_SEED) is False
    assert job_used_mantel(STANDARD_SEED) is False


def test_gallery_style_alone_and_soundbar_notes_are_not_samsung_frame():
    assert classify_install_specialty(HISENSE_GALLERY_SEED) == SPECIALTY_STANDARD_TV
    assert job_used_frame(HISENSE_GALLERY_SEED) is False
    assert classify_install_specialty(SOUNDBAR_SEED) == SPECIALTY_STANDARD_TV
    assert job_used_frame(SOUNDBAR_SEED) is False
    body = generate_post_body(HISENSE_GALLERY_SEED, "Plymouth")
    assert "Samsung Frame" not in body
    assert "samsung-frame-installation" not in body


def test_extractable_sentence_for_specialty_only():
    frame = build_extractable_sentence(FRAME_SEED, "Minnetonka")
    mantel = build_extractable_sentence(MANTEL_SEED, "Edina")
    both = build_extractable_sentence(BOTH_SEED, "Wayzata")
    standard = build_extractable_sentence(STANDARD_SEED, "Minneapolis")

    assert standard == ""
    assert frame.startswith("The Mounting Man installed this 65-inch Samsung Frame TV in Minnetonka")
    assert "Slim Fit" in frame
    assert "Minnetonka" in frame
    assert mantel.startswith("This MantelMount MM540 installation in Edina")
    assert "pull down" in mantel
    assert "Edina" in mantel
    assert both.startswith("The Mounting Man installed this 65-inch Samsung Frame TV in Wayzata")
    assert "MantelMount MM700" in both
    assert "Wayzata" in both
    for sentence in (frame, mantel, both):
        lowered = sentence.lower()
        assert not any(claim in lowered for claim in FORBIDDEN_CLAIMS)


def test_extractable_sentence_sits_near_the_top_of_specialty_bodies():
    for seed, city in (
        (FRAME_SEED, "Minnetonka"),
        (MANTEL_SEED, "Edina"),
        (BOTH_SEED, "Wayzata"),
    ):
        body = generate_post_body(seed, city)
        sentence = build_extractable_sentence(seed, city)
        details_at = body.index("Installation Details")
        sentence_at = body.index(sentence)
        heading_at = body.index("<h2>", details_at + 1)
        assert details_at < sentence_at < heading_at


def test_standard_tv_body_does_not_add_an_extractable_specialty_sentence():
    body = generate_post_body(STANDARD_SEED, "Minneapolis")
    assert build_extractable_sentence(STANDARD_SEED, "Minneapolis") == ""
    assert "The Mounting Man installed this" not in body
    assert "Samsung Frame" not in body
    assert "MantelMount" not in body


def test_frame_and_mantel_copy_stays_inside_known_fields():
    frame_body = generate_post_body(FRAME_SEED, "Minnetonka")
    mantel_body = generate_post_body(MANTEL_SEED, "Edina")
    both_body = generate_post_body(BOTH_SEED, "Wayzata")

    assert "Samsung Frame TV Installation in Minnetonka" in build_seo_title(FRAME_SEED, "Minnetonka")
    assert "Wood Slat" in frame_body
    assert "Slim Fit" in frame_body
    assert "samsung-frame-installation" in frame_body
    assert "MantelMount" not in frame_body
    assert "One Connect" not in frame_body

    assert "MantelMount Installation in Edina" in build_seo_title(MANTEL_SEED, "Edina")
    assert "MM540" in mantel_body
    assert "pull down" in mantel_body
    assert "stacked stone" in mantel_body.lower()
    assert "mantelmount-installation" in mantel_body
    assert "Samsung Frame" not in mantel_body
    assert "Slim Fit" not in mantel_body

    assert "Samsung Frame TV Installation in Wayzata" in build_seo_title(BOTH_SEED, "Wayzata")
    assert "MantelMount MM700" in build_seo_title(BOTH_SEED, "Wayzata")
    assert "samsung-frame-installation" in both_body
    assert "mantelmount-installation" in both_body
    assert "Slim Fit" not in both_body
    assert "MM700" in both_body
    assert "pull down" in both_body


def test_specialty_social_captions_carry_entity_city_fact_and_identity():
    frame_caps = _captions(FRAME_SEED)
    mantel_caps = _captions(MANTEL_SEED)
    both_caps = _captions(BOTH_SEED)
    standard_caps = _captions(STANDARD_SEED)

    assert set(frame_caps) == set(SOCIAL_DESTINATIONS)
    assert "reddit" not in frame_caps
    assert "gbp" not in frame_caps

    for caption in frame_caps.values():
        assert "Samsung Frame" in caption
        assert "Minnetonka" in caption
        assert "The Mounting Man" in caption
        assert "wood slat" in caption.lower()
        assert LIVE_URL in caption
        assert not any(claim in caption.lower() for claim in FORBIDDEN_CLAIMS)

    for caption in mantel_caps.values():
        assert "MantelMount" in caption
        assert "Edina" in caption
        assert "The Mounting Man" in caption
        assert "stacked stone" in caption.lower() or "MM540" in caption
        assert "Samsung Frame" not in caption

    for caption in both_caps.values():
        assert "Samsung Frame" in caption
        assert "MantelMount" in caption
        assert "Wayzata" in caption
        assert "The Mounting Man" in caption

    for caption in standard_caps.values():
        assert "Samsung Frame" not in caption
        assert "MantelMount" not in caption
        assert "Minneapolis" in caption

    assert frame_caps["instagram"] != frame_caps["linkedin"]
    assert "completed this" in frame_caps["linkedin"].lower()
    assert "installed in" in frame_caps["instagram"].lower()


@pytest.mark.parametrize("seed", [FRAME_SEED, MANTEL_SEED, BOTH_SEED])
@pytest.mark.parametrize("price", [None, "$650.00"])
def test_limited_x_caption_preserves_generated_url_and_specialty(seed, price):
    seed = {**seed, "price": price}
    url = "https://www.themountingman.com/installations/" + build_seo_slug(seed, seed["city"])
    caption = build_social_caption(seed, url, platform="x", limit=280)
    assert len(caption) <= 280
    assert caption.endswith("\n\n" + url)
    assert caption.count(url) == 1
    assert seed["city"] in caption
    assert "The Mounting Man" in caption
    if job_used_frame(seed):
        assert "Samsung Frame" in caption
    if job_used_mantel(seed):
        assert seed["mount-type"] in caption
        assert "Slim Fit" not in caption
    assert "65-inch" in caption or "75-inch" in caption or "wood slat" in caption.lower()


def test_x_compacts_long_specialty_fact_without_cutting_entities_or_url():
    seed = {**BOTH_SEED, "fireplace-type": "Stone " * 80}
    caption = build_social_caption(seed, LIVE_URL, platform="x", limit=280)
    assert len(caption) <= 280
    for text in ("Samsung Frame", "MantelMount MM700", "Wayzata", "The Mounting Man", "65-inch"):
        assert text in caption
    assert caption.endswith(LIVE_URL)


def test_short_and_exact_limit_captions_are_unchanged():
    full = build_social_caption(FRAME_SEED, LIVE_URL, platform="x")
    assert build_social_caption(FRAME_SEED, LIVE_URL, platform="x", limit=len(full)) == full
    assert build_social_caption(FRAME_SEED, LIVE_URL, platform="x", limit=len(full) + 1) == full


def test_overflow_drops_subtotal_as_a_whole_before_prose():
    seed = {**FRAME_SEED, "price": "$650.00"}
    without_price = build_social_caption(FRAME_SEED, LIVE_URL, platform="x")
    caption = build_social_caption(seed, LIVE_URL, platform="x", limit=len(without_price))
    assert caption == without_price


@pytest.mark.parametrize("platform,limit", [("x", 280), ("linkedin", 3000)])
def test_long_standard_and_unmount_captions_keep_full_url(platform, limit):
    for job_type in ("install", "unmount"):
        seed = {**STANDARD_SEED, "job-type": job_type, "post-summary": "TV work completed. " * 250}
        caption = build_social_caption(seed, LIVE_URL, platform=platform, limit=limit)
        assert len(caption) <= limit
        assert caption.endswith("\n\n" + LIVE_URL)
        assert "Samsung Frame" not in caption


def test_impossible_specialty_budget_blocks_instead_of_losing_identity_or_url():
    with pytest.raises(SocialBlockedError, match="specialty identity and full live URL"):
        build_social_caption(BOTH_SEED, LIVE_URL, platform="x", limit=len(LIVE_URL) + 20)


@pytest.mark.parametrize("url_length", [278, 279, 280, 281])
def test_url_near_limit_is_whole_or_blocked(url_length):
    url = "https://example.com/" + "a" * (url_length - len("https://example.com/"))
    if url_length > 280:
        with pytest.raises(SocialBlockedError, match="full live URL"):
            build_social_caption(STANDARD_SEED, url, platform="x", limit=280)
    else:
        caption = build_social_caption(STANDARD_SEED, url, platform="x", limit=280)
        assert caption == url


def test_no_url_still_respects_limit():
    seed = {**STANDARD_SEED, "post-summary": "Completed TV installation. " * 100}
    assert len(build_social_caption(seed, "", platform="x", limit=280)) <= 280


def test_related_installs_prefer_same_specialty():
    frame_candidates = [
        {
            "title": "Sony TV in Edina",
            "url": "https://www.themountingman.com/installations/sony-edina",
            "city": "Edina",
            "tv-brand": "Sony",
        },
        {
            "title": "Samsung Frame in Edina",
            "url": "https://www.themountingman.com/installations/frame-edina",
            "city": "Edina",
            "tv-brand": "Samsung Frame",
            "gallery-style": True,
        },
        {
            "title": "Samsung Frame in Minnetonka",
            "url": "https://www.themountingman.com/installations/frame-minnetonka",
            "city": "Minnetonka",
            "tv-brand": "Samsung Frame",
            "gallery-style": True,
        },
    ]
    selected = select_related_installs(FRAME_SEED, frame_candidates)
    assert [item["title"] for item in selected] == [
        "Samsung Frame in Minnetonka",
        "Samsung Frame in Edina",
    ]

    mantel_candidates = [
        {
            "title": "Frame in Wayzata",
            "url": "https://www.themountingman.com/installations/frame-wayzata",
            "tv-brand": "Samsung Frame",
            "gallery-style": True,
        },
        {
            "title": "MantelMount in Wayzata",
            "url": "https://www.themountingman.com/installations/mantel-wayzata",
            "tv-brand": "Sony",
            "mantelmount": True,
            "mount-type": "MantelMount MM540",
        },
    ]
    selected_mantel = select_related_installs(MANTEL_SEED, mantel_candidates)
    assert [item["title"] for item in selected_mantel] == ["MantelMount in Wayzata"]

    body = generate_post_body({**FRAME_SEED, "related-installs": frame_candidates}, "Minnetonka")
    assert "Related Installations" in body
    assert "frame-minnetonka" in body
    assert "sony-edina" not in body
    assert "samsung-frame-installation" in body
