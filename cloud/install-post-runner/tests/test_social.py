"""Social destination contract for the cloud runner.

Never Reddit. Never GBP. Skip destinations already posted for the slug.
X fails closed unless the verified screen_name is MountingManTV.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

RUNNER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNNER_DIR))
sys.path.insert(0, str(RUNNER_DIR / "publisher"))

from social import (  # noqa: E402
    FORBIDDEN_DESTINATIONS,
    MOUNTINGMANTV_SCREEN_NAME,
    SOCIAL_DESTINATIONS,
    SocialBlockedError,
    SocialPublisher,
    already_posted,
    assert_mountingmantv,
    refuse_forbidden_destination,
)

POST_DATA = {
    "title": "65 inch Samsung TV Installation in Edina",
    "post-summary": "We mounted a 65 inch Samsung on stone in Edina.",
    "city": "Edina",
    "price": "$450",
    "slug": "65-inch-samsung-tv-installation-edina",
}
LIVE_URL = "https://www.themountingman.com/installations/65-inch-samsung-tv-installation-edina"
IMAGE_URL = "https://cdn.example.com/photo.webp"
IMAGE_BYTES = b"RIFF\x00\x00\x00\x00WEBP" + b"pixels" * 40

X_ENV = {
    "TWITTER_API_KEY": "mm-key",
    "TWITTER_API_SECRET": "mm-secret",
    "TWITTER_ACCESS_TOKEN": "mm-token",
    "TWITTER_ACCESS_TOKEN_SECRET": "mm-token-secret",
}


class FakeResponse:
    def __init__(self, *, status_code=200, json_data=None, text="", headers=None):
        self.status_code = status_code
        self._json = json_data if json_data is not None else {}
        self.text = text
        self.headers = headers or {}

    def json(self):
        return self._json


class RecordingHttp:
    def __init__(self, verify_user=None):
        self.calls = []
        self.verify_user = verify_user or {"screen_name": MOUNTINGMANTV_SCREEN_NAME, "id_str": "1"}

    def _record(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})

    def get(self, url, **kwargs):
        self._record("GET", url, **kwargs)
        if "verify_credentials" in url:
            return FakeResponse(json_data=self.verify_user)
        if "fb-unpub-1" in url:
            return FakeResponse(json_data={
                "images": [{"source": "https://scontent.xx.fbcdn.net/install.jpg"}],
            })
        raise AssertionError(f"unexpected GET {url}")

    def post(self, url, **kwargs):
        self._record("POST", url, **kwargs)
        if "media/upload" in url:
            return FakeResponse(json_data={"media_id_string": "media-1"})
        if url.endswith("/tweets"):
            return FakeResponse(json_data={"data": {"id": "tweet-1"}})
        if url.endswith("/media"):
            return FakeResponse(json_data={"id": "ig-container-1"})
        if url.endswith("/media_publish"):
            return FakeResponse(json_data={"id": "ig-media-1"})
        if url.endswith("/photos"):
            data = kwargs.get("data") or {}
            if kwargs.get("files") or data.get("published") == "false":
                return FakeResponse(json_data={"id": "fb-unpub-1"})
            return FakeResponse(json_data={"post_id": "fb-1"})
        if "assets" in url:
            return FakeResponse(json_data={
                "value": {
                    "asset": "urn:li:digitalmediaAsset:asset-1",
                    "uploadMechanism": {
                        "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
                            "uploadUrl": "https://linkedin.example/upload",
                        }
                    },
                }
            })
        if "ugcPosts" in url:
            return FakeResponse(headers={"x-restli-id": "urn:li:share:1"})
        raise AssertionError(f"unexpected POST {url}")

    def put(self, url, **kwargs):
        self._record("PUT", url, **kwargs)
        return FakeResponse()


def _full_env():
    return {
        **X_ENV,
        "FACEBOOK_PAGE_ID": "page-1",
        "FACEBOOK_PAGE_ACCESS_TOKEN": "page-token",
        "INSTAGRAM_BUSINESS_ACCOUNT_ID": "ig-1",
        "LINKEDIN_ACCESS_TOKEN": "li-token",
        "LINKEDIN_AUTHOR_URN": "urn:li:organization:1",
    }


def test_social_destinations_never_include_reddit_or_gbp():
    assert "reddit" not in SOCIAL_DESTINATIONS
    assert "gbp" not in SOCIAL_DESTINATIONS
    assert "reddit" in FORBIDDEN_DESTINATIONS
    with pytest.raises(SocialBlockedError, match="Reddit"):
        refuse_forbidden_destination("reddit")
    with pytest.raises(SocialBlockedError):
        refuse_forbidden_destination("gbp")


def test_publish_never_calls_reddit():
    http = RecordingHttp()
    publisher = SocialPublisher(env=_full_env(), http=http)
    results = publisher.publish(
        post_data=POST_DATA,
        live_url=LIVE_URL,
        image_url=IMAGE_URL,
        image_bytes=IMAGE_BYTES,
        slug=POST_DATA["slug"],
    )
    names = {entry["name"] for entry in results}
    assert names == {"instagram", "facebook", "linkedin", "x"}
    assert "reddit" not in names
    blob = str(http.calls)
    assert "reddit" not in blob.lower()
    assert all("reddit.com" not in call["url"] for call in http.calls)


def test_skip_destination_already_posted_for_slug():
    http = RecordingHttp()
    publisher = SocialPublisher(env=_full_env(), http=http)
    posted = [
        {"name": "instagram", "status": "PUBLISHED", "detail": "ig-old"},
        {"name": "website", "status": "PUBLISHED", "detail": LIVE_URL},
    ]
    results = publisher.publish(
        post_data=POST_DATA,
        live_url=LIVE_URL,
        image_url=IMAGE_URL,
        image_bytes=IMAGE_BYTES,
        slug=POST_DATA["slug"],
        posted_destinations=posted,
    )
    instagram = next(entry for entry in results if entry["name"] == "instagram")
    assert instagram["status"] == "PUBLISHED"
    assert "already posted" in instagram["detail"]
    assert not any("media_publish" in call["url"] for call in http.calls)
    assert any(call["url"].endswith("/photos") for call in http.calls)


def test_x_refuses_wrong_account():
    http = RecordingHttp(verify_user={"screen_name": "MarshallWayne", "id_str": "99"})
    publisher = SocialPublisher(env=_full_env(), http=http)
    results = publisher.publish(
        post_data=POST_DATA,
        live_url=LIVE_URL,
        image_url=IMAGE_URL,
        image_bytes=IMAGE_BYTES,
        slug=POST_DATA["slug"],
    )
    x_result = next(entry for entry in results if entry["name"] == "x")
    assert x_result["status"] == "BLOCKED"
    assert "MountingManTV" in x_result["detail"]
    assert not any(call["url"].endswith("/tweets") for call in http.calls)


def test_assert_mountingmantv_fails_closed():
    with pytest.raises(SocialBlockedError, match="MountingManTV"):
        assert_mountingmantv({"screen_name": "notTheBrand"})
    assert assert_mountingmantv({"screen_name": "MountingManTV", "id_str": "1"})["screen_name"] == "MountingManTV"


def test_already_posted_requires_published_status():
    assert already_posted("x", [{"name": "x", "status": "PUBLISHED"}]) is True
    assert already_posted("x", [{"name": "x", "status": "RETRYABLE_FAILURE"}]) is False
    assert already_posted("x", [{"name": "instagram", "status": "PUBLISHED"}]) is False


def test_instagram_uses_a_jpeg_rendition_not_the_webp_asset():
    http = RecordingHttp()
    publisher = SocialPublisher(env=_full_env(), http=http)
    results = publisher.publish(
        post_data=POST_DATA,
        live_url=LIVE_URL,
        image_url=IMAGE_URL,
        image_bytes=IMAGE_BYTES,
        slug=POST_DATA["slug"],
    )
    instagram = next(entry for entry in results if entry["name"] == "instagram")
    assert instagram["status"] == "PUBLISHED"
    media_create = next(
        call for call in http.calls
        if call["method"] == "POST" and str(call.get("url", "")).endswith("/media")
        and "ig-1" in str(call.get("url", ""))
    )
    sent_url = (media_create.get("data") or {}).get("image_url")
    assert sent_url == "https://scontent.xx.fbcdn.net/install.jpg"
    assert "webp" not in sent_url.lower()
    assert sent_url != IMAGE_URL
    assert any(call.get("files") for call in http.calls if str(call.get("url", "")).endswith("/photos"))


def test_missing_social_credentials_are_skipped_not_invented():
    http = RecordingHttp()
    publisher = SocialPublisher(env={}, http=http)
    results = publisher.publish(
        post_data=POST_DATA,
        live_url=LIVE_URL,
        image_url=IMAGE_URL,
        image_bytes=IMAGE_BYTES,
        slug=POST_DATA["slug"],
    )
    assert {entry["status"] for entry in results} == {"SKIPPED"}
    assert http.calls == []
