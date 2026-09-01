"""THE-205: stamp TV mounting Minneapolis only on Minneapolis-proper jobs."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "publisher"))

from content import (  # noqa: E402
    MINNEAPOLIS_CITY_STAMP,
    city_mounting_stamp,
    ensure_city_stamp,
    generate_post_body,
    generate_post_summary,
    is_exact_minneapolis_city,
    job_used_frame,
    job_used_mantel,
)
from social import build_social_caption  # noqa: E402

SUBURBS = ("Minnetonka", "Plymouth", "Edina", "Woodbury", "Richfield")
LIVE_URL = "https://www.themountingman.com/installations/test-install"


def _seed(city: str, **overrides) -> dict:
    seed = {
        "city": city,
        "tv-size": '65"',
        "tv-brand": "Samsung",
        "wall-surface": "Drywall",
        "street-name": "Lake Street",
        "price": "$250",
        "gallery-style": False,
        "mantelmount": False,
    }
    seed.update(overrides)
    return seed


def test_exact_minneapolis_city_rejects_metro_and_suburbs():
    assert is_exact_minneapolis_city("Minneapolis") is True
    assert is_exact_minneapolis_city("minneapolis") is True
    assert is_exact_minneapolis_city("Minneapolis ") is True
    assert is_exact_minneapolis_city("Minneapolis–St. Paul") is False
    assert is_exact_minneapolis_city("Minneapolis-St. Paul") is False
    assert is_exact_minneapolis_city("Twin Cities") is False
    assert is_exact_minneapolis_city("Greater Minneapolis") is False
    for suburb in SUBURBS:
        assert is_exact_minneapolis_city(suburb) is False


def test_minneapolis_body_and_summary_stamp_once():
    seed = _seed("Minneapolis")
    body = generate_post_body(seed, "Minneapolis")
    summary = generate_post_summary(seed, "Minneapolis")
    assert body.count(MINNEAPOLIS_CITY_STAMP) == 1
    assert summary.count(MINNEAPOLIS_CITY_STAMP) == 1
    assert summary.startswith(MINNEAPOLIS_CITY_STAMP)


def test_minneapolis_standard_job_does_not_invent_frame_or_mantel():
    seed = _seed("Minneapolis")
    assert job_used_frame(seed) is False
    assert job_used_mantel(seed) is False
    body = generate_post_body(seed, "Minneapolis")
    summary = generate_post_summary(seed, "Minneapolis")
    caption = build_social_caption(seed, LIVE_URL)
    for text in (body, summary, caption):
        assert "Samsung Frame" not in text
        assert "MantelMount" not in text
        assert text.count(MINNEAPOLIS_CITY_STAMP) == 1


def test_minneapolis_frame_job_keeps_existing_frame_tagging():
    seed = _seed("Minneapolis", **{"tv-brand": "Samsung Frame", "gallery-style": True})
    assert job_used_frame(seed) is True
    assert job_used_mantel(seed) is False
    body = generate_post_body(seed, "Minneapolis")
    summary = generate_post_summary(seed, "Minneapolis")
    assert body.count(MINNEAPOLIS_CITY_STAMP) == 1
    assert summary.count(MINNEAPOLIS_CITY_STAMP) == 1
    assert "Samsung Frame" in body
    assert "Samsung Frame" in summary
    assert "samsung-frame-installation" in body
    assert "MantelMount" not in body


def test_minneapolis_mantel_job_keeps_existing_mantel_tagging():
    seed = _seed(
        "Minneapolis",
        mantelmount=True,
        **{"mount-type": "MantelMount MM700", "tv-brand": "Sony"},
    )
    assert job_used_mantel(seed) is True
    assert job_used_frame(seed) is False
    body = generate_post_body(seed, "Minneapolis")
    summary = generate_post_summary(seed, "Minneapolis")
    assert body.count(MINNEAPOLIS_CITY_STAMP) == 1
    assert summary.count(MINNEAPOLIS_CITY_STAMP) == 1
    assert "MantelMount" in body
    assert "mantelmount-installation" in body
    assert "Samsung Frame" not in body


def test_suburbs_use_their_own_city_and_never_stamp_minneapolis():
    for suburb in SUBURBS:
        seed = _seed(suburb)
        body = generate_post_body(seed, suburb)
        summary = generate_post_summary(seed, suburb)
        caption = build_social_caption({**seed, "post-summary": summary}, LIVE_URL)
        stamp = city_mounting_stamp(suburb)
        assert stamp in body
        assert stamp in summary
        assert stamp in caption
        assert MINNEAPOLIS_CITY_STAMP not in body
        assert MINNEAPOLIS_CITY_STAMP not in summary
        assert MINNEAPOLIS_CITY_STAMP not in caption
        assert body.count(stamp) == 1
        assert summary.count(stamp) == 1


def test_metro_labels_do_not_get_the_minneapolis_stamp():
    for metro in ("Minneapolis–St. Paul", "Minneapolis-St. Paul", "Twin Cities"):
        seed = _seed(metro)
        body = generate_post_body(seed, metro)
        summary = generate_post_summary(seed, metro)
        assert MINNEAPOLIS_CITY_STAMP not in body
        assert MINNEAPOLIS_CITY_STAMP not in summary
        assert city_mounting_stamp(metro) in body


def test_caption_fallback_stamps_city_when_summary_is_empty():
    minneapolis = build_social_caption({"city": "Minneapolis"}, LIVE_URL)
    edina = build_social_caption({"city": "Edina"}, LIVE_URL)
    assert minneapolis.count(MINNEAPOLIS_CITY_STAMP) == 1
    assert MINNEAPOLIS_CITY_STAMP not in edina
    assert city_mounting_stamp("Edina") in edina


def test_ensure_city_stamp_is_idempotent():
    once = ensure_city_stamp("Completed near Lake Street.", "Minneapolis")
    twice = ensure_city_stamp(once, "Minneapolis")
    assert once.count(MINNEAPOLIS_CITY_STAMP) == 1
    assert twice.count(MINNEAPOLIS_CITY_STAMP) == 1


def test_soundbar_frame_bracket_notes_do_not_count_as_a_frame_job():
    seed = _seed(
        "Minneapolis",
        **{"job-notes": "Soundbar Bracket (Frame / Gallery) Yes - Premium Bracket"},
    )
    assert job_used_frame(seed) is False
    summary = generate_post_summary(seed, "Minneapolis")
    assert "Samsung Frame" not in summary
