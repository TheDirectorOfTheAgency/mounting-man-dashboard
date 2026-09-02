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
    SocialIndeterminateError,
    SocialPublisher,
    SocialRetryableError,
    already_posted,
    assert_mountingmantv,
    is_instagram_media_not_ready,
    is_linkedin_post_receipt,
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


IG_9007_ERROR = {
    "error": {
        "message": "Media ID is not available",
        "type": "OAuthException",
        "code": 9007,
        "error_subcode": 2207027,
        "error_user_title": "Cannot Publish",
    }
}
IG_9007_TEXT = (
    '{"error":{"message":"Media ID is not available","type":"OAuthException",'
    '"code":9007,"error_subcode":2207027,"error_user_title":"Cannot Publish"}}'
)


def _ig_9007():
    return FakeResponse(status_code=400, json_data=IG_9007_ERROR, text=IG_9007_TEXT)


def _ig_published(media_id="ig-media-1"):
    return FakeResponse(json_data={"id": media_id})


class RecordingHttp:
    def __init__(
        self,
        verify_user=None,
        *,
        linkedin_receipt="urn:li:ugcPost:7499800000000000000",
        linkedin_post_status=201,
        linkedin_post_exception=None,
        instagram_lookup_images=None,
        instagram_statuses=None,
        instagram_publish_responses=None,
    ):
        self.calls = []
        self.verify_user = verify_user or {"screen_name": MOUNTINGMANTV_SCREEN_NAME, "id_str": "1"}
        self.linkedin_receipt = linkedin_receipt
        self.linkedin_post_status = linkedin_post_status
        self.linkedin_post_exception = linkedin_post_exception
        self.instagram_lookup_images = instagram_lookup_images
        self.instagram_statuses = list(instagram_statuses) if instagram_statuses is not None else ["FINISHED"]
        self.instagram_status_index = 0
        self.instagram_publish_responses = (
            list(instagram_publish_responses) if instagram_publish_responses is not None else None
        )
        self.instagram_publish_index = 0

    def _record(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})

    def _next_ig_status(self):
        if not self.instagram_statuses:
            return "IN_PROGRESS"
        if self.instagram_status_index < len(self.instagram_statuses):
            status = self.instagram_statuses[self.instagram_status_index]
            self.instagram_status_index += 1
            return status
        return self.instagram_statuses[-1]

    def get(self, url, **kwargs):
        self._record("GET", url, **kwargs)
        if "verify_credentials" in url:
            return FakeResponse(json_data=self.verify_user)
        if "fb-unpub-1" in url:
            images = self.instagram_lookup_images
            if images is None:
                images = [{"source": "https://scontent.xx.fbcdn.net/install.jpg"}]
            return FakeResponse(json_data={"images": images})
        if "graph.facebook.com" in url:
            return FakeResponse(json_data={"status_code": self._next_ig_status()})
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
            if self.instagram_publish_responses is not None:
                if self.instagram_publish_index >= len(self.instagram_publish_responses):
                    raise AssertionError("unexpected extra Instagram media_publish")
                response = self.instagram_publish_responses[self.instagram_publish_index]
                self.instagram_publish_index += 1
                return response
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
            if self.linkedin_post_exception is not None:
                raise self.linkedin_post_exception
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


def _instagram_host_upload(http):
    return next(
        call for call in http.calls
        if call["method"] == "POST"
        and str(call.get("url", "")).endswith("/photos")
        and call.get("files")
    )


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
    host = _instagram_host_upload(http)
    filename, body, content_type = host["files"]["source"]
    assert filename == "install.jpg"
    assert content_type == "image/jpeg"
    assert body.startswith(b"\xff\xd8\xff")
    assert body != IMAGE_BYTES


def test_instagram_jpeg_host_needs_bound_photo_bytes():
    http = RecordingHttp()
    publisher = SocialPublisher(env=_full_env(), http=http)
    with pytest.raises(SocialRetryableError, match="Instagram JPEG rendition needs the bound photo bytes"):
        publisher._host_jpeg_rendition(
            page_id="page-1",
            token="page-token",
            image_bytes=b"",
            fallback_url=IMAGE_URL,
        )
    assert http.calls == []


def test_instagram_host_uploads_actual_jpeg_bytes():
    jpeg_bytes = social_module.instagram_jpeg_bytes(IMAGE_BYTES)
    assert jpeg_bytes.startswith(b"\xff\xd8\xff")
    from PIL import Image
    with Image.open(io.BytesIO(jpeg_bytes)) as image:
        assert image.format == "JPEG"

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
    filename, body, content_type = _instagram_host_upload(http)["files"]["source"]
    assert filename == "install.jpg"
    assert content_type == "image/jpeg"
    assert body == jpeg_bytes
    assert not IMAGE_BYTES.startswith(b"\xff\xd8\xff")


@pytest.mark.parametrize("images", [
    [],
    [{"source": "https://scontent.xx.fbcdn.net/v/t39.30808-6/photo.webp"}],
    [{"source": "https://scontent.xx.fbcdn.net/v/t39.30808-6/photo.WEBP?_nc_cat=1"}],
])
def test_instagram_jpeg_lookup_miss_is_retryable(images):
    http = RecordingHttp(instagram_lookup_images=images)
    publisher = SocialPublisher(env=_full_env(), http=http)
    results = publisher.publish(
        post_data=POST_DATA,
        live_url=LIVE_URL,
        image_url=IMAGE_URL,
        image_bytes=IMAGE_BYTES,
        slug=POST_DATA["slug"],
    )
    instagram = next(entry for entry in results if entry["name"] == "instagram")
    assert instagram["status"] == "RETRYABLE_FAILURE"
    assert instagram["detail"] == "Instagram JPEG lookup returned no JPEG URL"
    filename, body, content_type = _instagram_host_upload(http)["files"]["source"]
    assert filename == "install.jpg"
    assert content_type == "image/jpeg"
    assert body.startswith(b"\xff\xd8\xff")
    facebook = next(entry for entry in results if entry["name"] == "facebook")
    assert facebook["status"] == "PUBLISHED"


def _publisher(http, **overrides):
    slept = []
    defaults = {
        "ig_container_poll_interval": 0,
        "ig_publish_retry_wait": 0,
    }
    defaults.update(overrides)
    publisher = SocialPublisher(
        env=_full_env(),
        http=http,
        sleep=slept.append,
        **defaults,
    )
    return publisher, slept


def _publish(publisher):
    return publisher.publish(
        post_data=POST_DATA,
        live_url=LIVE_URL,
        image_url=IMAGE_URL,
        image_bytes=IMAGE_BYTES,
        slug=POST_DATA["slug"],
    )


def _calls_ending(http, suffix):
    return [call for call in http.calls if str(call.get("url", "")).endswith(suffix)]


def test_instagram_media_not_ready_detects_9007_and_2207027():
    assert is_instagram_media_not_ready(_ig_9007()) is True
    assert is_instagram_media_not_ready(FakeResponse(status_code=400, json_data={"error": {"code": 10}})) is False
    assert is_instagram_media_not_ready(FakeResponse(json_data={"id": "ig-media-1"})) is False


def test_instagram_waits_for_finished_then_publishes():
    http = RecordingHttp(instagram_statuses=["IN_PROGRESS", "FINISHED"])
    publisher, slept = _publisher(http, ig_container_poll_interval=3)
    results = _publish(publisher)

    instagram = next(entry for entry in results if entry["name"] == "instagram")
    assert instagram["status"] == "PUBLISHED"
    assert instagram["detail"] == "ig-media-1"

    status_gets = _calls_ending(http, "/ig-container-1")
    assert [call["method"] for call in status_gets] == ["GET", "GET"]
    assert all((call.get("params") or {}).get("fields") == "status_code" for call in status_gets)
    publish_calls = _calls_ending(http, "/media_publish")
    assert len(publish_calls) == 1
    first_status = next(
        index for index, call in enumerate(http.calls)
        if call["method"] == "GET" and str(call.get("url", "")).endswith("/ig-container-1")
    )
    first_publish = next(
        index for index, call in enumerate(http.calls)
        if str(call.get("url", "")).endswith("/media_publish")
    )
    assert first_status < first_publish
    assert slept == [3]

    filename, body, content_type = _instagram_host_upload(http)["files"]["source"]
    assert filename == "install.jpg"
    assert content_type == "image/jpeg"
    assert body.startswith(b"\xff\xd8\xff")


def test_instagram_9007_retries_publish_then_succeeds():
    http = RecordingHttp(
        instagram_statuses=["FINISHED"],
        instagram_publish_responses=[_ig_9007(), _ig_published()],
    )
    publisher, slept = _publisher(http, ig_publish_attempts=4, ig_publish_retry_wait=7)
    results = _publish(publisher)

    instagram = next(entry for entry in results if entry["name"] == "instagram")
    assert instagram["status"] == "PUBLISHED"
    assert instagram["detail"] == "ig-media-1"
    publish_calls = _calls_ending(http, "/media_publish")
    assert len(publish_calls) == 2
    assert all((call.get("data") or {}).get("creation_id") == "ig-container-1" for call in publish_calls)
    assert slept == [7]
    assert next(entry for entry in results if entry["name"] == "facebook")["status"] == "PUBLISHED"
    assert next(entry for entry in results if entry["name"] == "linkedin")["status"] == "PUBLISHED"
    assert next(entry for entry in results if entry["name"] == "x")["status"] == "PUBLISHED"
    filename, body, content_type = _instagram_host_upload(http)["files"]["source"]
    assert content_type == "image/jpeg"
    assert body.startswith(b"\xff\xd8\xff")


def test_instagram_container_error_does_not_hang_and_others_still_publish():
    http = RecordingHttp(instagram_statuses=["IN_PROGRESS", "ERROR"])
    publisher, slept = _publisher(http, ig_container_poll_attempts=8, ig_container_poll_interval=2)
    results = _publish(publisher)

    instagram = next(entry for entry in results if entry["name"] == "instagram")
    assert instagram["status"] == "BLOCKED"
    assert "ERROR" in instagram["detail"]
    assert _calls_ending(http, "/media_publish") == []
    assert slept == [2]
    assert {entry["name"]: entry["status"] for entry in results} == {
        "instagram": "BLOCKED",
        "facebook": "PUBLISHED",
        "linkedin": "PUBLISHED",
        "x": "PUBLISHED",
    }


def test_instagram_container_timeout_does_not_hang():
    http = RecordingHttp(instagram_statuses=["IN_PROGRESS"])
    publisher, slept = _publisher(http, ig_container_poll_attempts=3, ig_container_poll_interval=2)
    results = _publish(publisher)

    instagram = next(entry for entry in results if entry["name"] == "instagram")
    assert instagram["status"] == "RETRYABLE_FAILURE"
    assert "not ready after 3 polls" in instagram["detail"]
    assert len(_calls_ending(http, "/ig-container-1")) == 3
    assert slept == [2, 2]
    assert _calls_ending(http, "/media_publish") == []
    assert next(entry for entry in results if entry["name"] == "facebook")["status"] == "PUBLISHED"
    assert next(entry for entry in results if entry["name"] == "linkedin")["status"] == "PUBLISHED"
    assert next(entry for entry in results if entry["name"] == "x")["status"] == "PUBLISHED"


def test_instagram_9007_exhausted_stays_blocked():
    http = RecordingHttp(
        instagram_publish_responses=[_ig_9007(), _ig_9007(), _ig_9007()],
    )
    publisher, slept = _publisher(http, ig_publish_attempts=3, ig_publish_retry_wait=1)
    results = _publish(publisher)

    instagram = next(entry for entry in results if entry["name"] == "instagram")
    assert instagram["status"] == "BLOCKED"
    assert "9007" in instagram["detail"] or "2207027" in instagram["detail"]
    assert len(_calls_ending(http, "/media_publish")) == 3
    assert slept == [1, 1]
    assert next(entry for entry in results if entry["name"] == "facebook")["status"] == "PUBLISHED"


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


@pytest.mark.parametrize("receipt", [None, "urn:li:image:not-a-post"])
def test_linkedin_missing_or_malformed_201_receipt_is_indeterminate(receipt):
    http = RecordingHttp(linkedin_receipt=receipt, linkedin_post_status=201)
    with pytest.raises(SocialIndeterminateError, match="x-restli-id"):
        _publish_linkedin(http)


def test_linkedin_post_read_timeout_and_server_error_are_indeterminate():
    timeout_http = RecordingHttp(
        linkedin_post_exception=__import__("requests").exceptions.ReadTimeout("after send")
    )
    with pytest.raises(SocialIndeterminateError, match="outcome is unknown"):
        _publish_linkedin(timeout_http)

    with pytest.raises(SocialIndeterminateError, match="HTTP 503"):
        _publish_linkedin(RecordingHttp(linkedin_post_status=503))


def test_linkedin_legacy_activity_receipt_is_preserved_without_reposting():
    legacy = "https://www.linkedin.com/posts/themountingman_install-activity-7499800000000000000-AbCd"
    assert is_linkedin_post_receipt(legacy) is True
    http = RecordingHttp()
    results = SocialPublisher(env=_full_env(), http=http).publish(
        post_data=POST_DATA,
        live_url=LIVE_URL,
        image_url=IMAGE_URL,
        image_bytes=IMAGE_BYTES,
        slug=POST_DATA["slug"],
        posted_destinations=[{"name": "linkedin", "status": "PUBLISHED", "detail": legacy}],
    )
    linkedin = next(entry for entry in results if entry["name"] == "linkedin")
    assert linkedin == {"name": "linkedin", "status": "PUBLISHED", "detail": legacy}
    assert not any("linkedin.com/rest" in call["url"] for call in http.calls)


def test_linkedin_indeterminate_create_is_a_no_retry_barrier():
    http = RecordingHttp()
    results = SocialPublisher(
        env={
            "LINKEDIN_ACCESS_TOKEN": "token",
            "LINKEDIN_AUTHOR_URN": "urn:li:person:123",
        },
        http=http,
    ).publish(
        post_data=POST_DATA,
        live_url=LIVE_URL,
        image_url=IMAGE_URL,
        image_bytes=IMAGE_BYTES,
        slug=POST_DATA["slug"],
        posted_destinations=[{
            "name": "linkedin",
            "status": "INDETERMINATE",
            "detail": "prior create outcome unknown",
        }],
    )
    linkedin = next(entry for entry in results if entry["name"] == "linkedin")
    assert linkedin["status"] == "INDETERMINATE"
    assert "manual reconciliation" in linkedin["detail"].lower()
    assert not any("linkedin.com/rest" in call["url"] for call in http.calls)
