"""Social destination contract for the cloud runner.

Never Reddit. Never GBP. Skip destinations already posted for the slug.
X fails closed unless the verified screen_name is MountingManTV.
"""

from __future__ import annotations

import base64
import io
import sys
from pathlib import Path

import pytest

RUNNER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNNER_DIR))
sys.path.insert(0, str(RUNNER_DIR / "publisher"))

import social as social_module  # noqa: E402
from social import (  # noqa: E402
    FORBIDDEN_DESTINATIONS,
    MOUNTINGMANTV_SCREEN_NAME,
    SOCIAL_DESTINATIONS,
    SocialBlockedError,
    SocialPublisher,
    SocialRetryableError,
    already_posted,
    assert_mountingmantv,
    refuse_forbidden_destination,
    require_linkedin_person_author,
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
IMAGE_BYTES = base64.b64decode(
    "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
)

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
    def __init__(
        self,
        verify_user=None,
        *,
        linkedin_receipt="urn:li:ugcPost:7499800000000000000",
        linkedin_post_status=201,
    ):
        self.calls = []
        self.verify_user = verify_user or {"screen_name": MOUNTINGMANTV_SCREEN_NAME, "id_str": "1"}
        self.linkedin_receipt = linkedin_receipt
        self.linkedin_post_status = linkedin_post_status

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
        if url.endswith("/rest/images?action=initializeUpload"):
            return FakeResponse(json_data={
                "value": {
                    "image": "urn:li:image:image-1",
                    "uploadUrl": "https://linkedin.example/upload",
                }
            })
        if url.endswith("/rest/posts"):
            headers = {"x-restli-id": self.linkedin_receipt} if self.linkedin_receipt is not None else {}
            return FakeResponse(status_code=self.linkedin_post_status, headers=headers)
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
        "LINKEDIN_AUTHOR_URN": "urn:li:person:person-1",
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


SHARE_URN = "urn:li:share:7499851525402308608"
UGC_URN = "urn:li:ugcPost:7499800000000000000"


def _publish_linkedin(http, env=None):
    return SocialPublisher(env=env or _full_env(), http=http)._linkedin(
        post_data=POST_DATA,
        live_url=LIVE_URL,
        image_url=IMAGE_URL,
        image_bytes=IMAGE_BYTES,
    )


def test_linkedin_webp_becomes_real_jpeg_bytes():
    jpeg_bytes = social_module.linkedin_jpeg_bytes(IMAGE_BYTES)
    assert jpeg_bytes.startswith(b"\xff\xd8\xff")

    from PIL import Image

    with Image.open(io.BytesIO(jpeg_bytes)) as image:
        assert image.format == "JPEG"


def test_linkedin_company_page_author_is_blocked():
    with pytest.raises(SocialBlockedError, match="person"):
        require_linkedin_person_author("urn:li:organization:1")
    http = RecordingHttp()
    env = _full_env()
    env["LINKEDIN_AUTHOR_URN"] = "urn:li:organization:1"
    with pytest.raises(SocialBlockedError, match="person"):
        _publish_linkedin(http, env)
    assert http.calls == []


def test_linkedin_uses_current_images_and_posts_contract_without_readback():
    http = RecordingHttp()
    assert _publish_linkedin(http) == UGC_URN

    assert [(call["method"], call["url"]) for call in http.calls] == [
        ("POST", "https://api.linkedin.com/rest/images?action=initializeUpload"),
        ("PUT", "https://linkedin.example/upload"),
        ("POST", "https://api.linkedin.com/rest/posts"),
    ]
    assert not any(call["method"] == "GET" for call in http.calls)

    initialize, upload, create = http.calls
    expected_headers = {
        "Authorization": "Bearer li-token",
        "Content-Type": "application/json",
        "Linkedin-Version": "202608",
        "X-Restli-Protocol-Version": "2.0.0",
    }
    assert initialize["headers"] == expected_headers
    assert initialize["json"] == {
        "initializeUploadRequest": {"owner": "urn:li:person:person-1"}
    }
    assert upload["headers"]["Content-Type"] == "image/jpeg"
    assert upload["headers"]["Content-Disposition"].endswith('filename="install.jpg"')
    assert upload["data"].startswith(b"\xff\xd8\xff")
    assert create["headers"] == expected_headers
    body = create["json"]
    assert body["author"] == "urn:li:person:person-1"
    assert body["commentary"]
    assert body["lifecycleState"] == "PUBLISHED"
    assert body["visibility"] == "PUBLIC"
    assert body["distribution"] == {"feedDistribution": "MAIN_FEED"}
    assert body["content"]["media"]["id"] == "urn:li:image:image-1"
    assert body["isReshareDisabledByAuthor"] is False


@pytest.mark.parametrize("receipt", [SHARE_URN, UGC_URN])
def test_linkedin_accepts_documented_201_post_id_receipts(receipt):
    assert _publish_linkedin(RecordingHttp(linkedin_receipt=receipt)) == receipt
    assert already_posted("linkedin", [
        {"name": "linkedin", "status": "PUBLISHED", "detail": receipt},
    ]) is True


@pytest.mark.parametrize(
    ("receipt", "status"),
    [
        (None, 201),
        ("urn:li:image:not-a-post", 201),
        (UGC_URN, 200),
    ],
)
def test_linkedin_rejects_missing_malformed_or_non_201_receipts(receipt, status):
    http = RecordingHttp(linkedin_receipt=receipt, linkedin_post_status=status)
    with pytest.raises(SocialRetryableError, match="201|x-restli-id"):
        _publish_linkedin(http)
