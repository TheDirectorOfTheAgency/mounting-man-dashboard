"""Social destinations for the cloud installation-post runner.

Vendored from the Hermes publisher's Graph / LinkedIn / X clients (clients.py
patterns on the M1 at ~/.hermes/skills/business-ops/
mounting-man-installation-posts-hermes/ — not in this repo): Instagram,
Facebook, LinkedIn, and X/Twitter. Never Reddit. Never Google Business
Profile. X fails closed unless the authenticated screen_name is
MountingManTV.

LinkedIn uses the versioned Images and Posts APIs with a personal author
(urn:li:person: / w_member_social). The Posts API may return either a
urn:li:share or urn:li:ugcPost ID; both are documented success receipts.
The write-only token must never be used for image or post GET readback.

Credential names match GitHub Actions secrets / Vercel env (names only):
  FACEBOOK_PAGE_ID
  FACEBOOK_PAGE_ACCESS_TOKEN
  INSTAGRAM_BUSINESS_ACCOUNT_ID
  LINKEDIN_ACCESS_TOKEN
  LINKEDIN_AUTHOR_URN
  TWITTER_API_KEY
  TWITTER_API_SECRET
  TWITTER_ACCESS_TOKEN
  TWITTER_ACCESS_TOKEN_SECRET
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import os
import re
import time
import urllib.parse
from typing import Callable
from uuid import uuid4

import requests
from PIL import Image, UnidentifiedImageError

from content import display_price_subtotal, ensure_city_stamp

SOCIAL_DESTINATIONS = ("instagram", "facebook", "linkedin", "x")
FORBIDDEN_DESTINATIONS = frozenset({"reddit", "gbp", "google-business-profile"})
MOUNTINGMANTV_SCREEN_NAME = "MountingManTV"

STATUS_PUBLISHED = "PUBLISHED"
STATUS_SKIPPED = "SKIPPED"
STATUS_BLOCKED = "BLOCKED"
STATUS_RETRYABLE = "RETRYABLE_FAILURE"
STATUS_INDETERMINATE = "INDETERMINATE"

GRAPH_BASE = "https://graph.facebook.com/v21.0"
# Instagram containers are not publishable until status_code is FINISHED.
# Publishing immediately after /media create is Meta 9007 / 2207027.
IG_MEDIA_NOT_READY_CODE = 9007
IG_MEDIA_NOT_READY_SUBCODE = 2207027
IG_CONTAINER_READY = frozenset({"FINISHED", "PUBLISHED"})
IG_CONTAINER_FAILED = frozenset({"ERROR", "EXPIRED"})
IG_CONTAINER_POLL_ATTEMPTS = 20
IG_CONTAINER_POLL_INTERVAL_SECONDS = 3.0
# Wall-clock cap so stalled Graph GETs cannot burn the 10-minute workflow
# before Facebook, LinkedIn, and X. Status GET timeout is short; a transport
# timeout stops polling and proceeds to publish / 9007 retry.
IG_CONTAINER_WAIT_SECONDS = 60
IG_CONTAINER_STATUS_TIMEOUT_SECONDS = 10
IG_CONTAINER_TRANSPORT_TIMEOUT = "TRANSPORT_TIMEOUT"
IG_PUBLISH_ATTEMPTS = 4
IG_PUBLISH_RETRY_WAIT_SECONDS = 5.0
LINKEDIN_IMAGES_URL = "https://api.linkedin.com/rest/images?action=initializeUpload"
LINKEDIN_POSTS_URL = "https://api.linkedin.com/rest/posts"
LINKEDIN_VERSION_DEFAULT = "202608"
LINKEDIN_RECEIPT_FAILURE = (
    "LinkedIn success requires a Posts API x-restli-id share or ugcPost URN"
)
_LINKEDIN_POST_ID_RE = re.compile(r"^urn:li:(?:share|ugcPost):\d+$", re.IGNORECASE)
_LINKEDIN_LEGACY_RECEIPT_RE = re.compile(
    r"^(?:"
    r"https://www\.linkedin\.com/posts/themountingman_[^\s]*-activity-\d+(?:-[A-Za-z0-9_-]+)?"
    r"|https://www\.linkedin\.com/feed/update/urn:li:activity:\d+/?"
    r"|urn:li:activity:\d+"
    r")$",
    re.IGNORECASE,
)
X_VERIFY_URL = "https://api.twitter.com/1.1/account/verify_credentials.json"
X_MEDIA_UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json"
X_CREATE_TWEET_URL = "https://api.twitter.com/2/tweets"

FACEBOOK_ENV = ("FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN")
# Page id is required so the runner can host a JPEG rendition. Instagram's
# image container rejects the dashboard's WebP asset URL.
INSTAGRAM_ENV = ("INSTAGRAM_BUSINESS_ACCOUNT_ID", "FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN")
LINKEDIN_ENV = ("LINKEDIN_ACCESS_TOKEN", "LINKEDIN_AUTHOR_URN")
X_ENV = (
    "TWITTER_API_KEY",
    "TWITTER_API_SECRET",
    "TWITTER_ACCESS_TOKEN",
    "TWITTER_ACCESS_TOKEN_SECRET",
)


class SocialBlockedError(RuntimeError):
    """Permanent refusal. Do not retry this destination as-is."""


class SocialRetryableError(RuntimeError):
    """Transient failure. Safe to retry; the destination was not confirmed."""


class SocialIndeterminateError(RuntimeError):
    """The create may have landed. Reconcile manually; never retry blindly."""


class SocialSkip(RuntimeError):
    """Destination is not configured. Not a failure."""


def _env(name: str, env: dict | None = None) -> str:
    source = env if env is not None else os.environ
    return str(source.get(name) or "").strip()


def require_env(names: tuple[str, ...], env: dict | None = None) -> dict[str, str]:
    values = {name: _env(name, env) for name in names}
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise SocialSkip(f"credentials unset: {', '.join(missing)}")
    return values


def is_linkedin_post_id(detail: object) -> bool:
    """Return whether detail is a documented Posts API creation receipt."""
    return bool(_LINKEDIN_POST_ID_RE.fullmatch(str(detail or "").strip()))


def is_linkedin_post_receipt(detail: object) -> bool:
    value = str(detail or "").strip()
    return is_linkedin_post_id(value) or bool(_LINKEDIN_LEGACY_RECEIPT_RE.fullmatch(value))


def classify_linkedin_destination(status: object, detail: object) -> tuple[str, str]:
    """Fail closed unless a PUBLISHED LinkedIn result has a Posts API ID."""
    status_text = str(status or "")
    detail_text = str(detail or "")
    if status_text != STATUS_PUBLISHED:
        return status_text, detail_text
    if is_linkedin_post_receipt(detail_text):
        return STATUS_PUBLISHED, detail_text
    return STATUS_RETRYABLE, LINKEDIN_RECEIPT_FAILURE


def require_linkedin_person_author(author: object) -> str:
    value = str(author or "").strip()
    if not value.startswith("urn:li:person:"):
        raise SocialBlockedError(
            "LinkedIn token is w_member_social / person URN only; "
            "refusing a company page. Set LINKEDIN_AUTHOR_URN to urn:li:person:..."
        )
    return value


def already_posted_detail(name: str, posted_destinations) -> str | None:
    for entry in posted_destinations or []:
        if not isinstance(entry, dict):
            continue
        entry_name = str(entry.get("name") or "").strip().lower()
        if entry_name != name or str(entry.get("status") or "") != STATUS_PUBLISHED:
            continue
        detail = str(entry.get("detail") or "").strip()
        if name == "linkedin" and not is_linkedin_post_receipt(detail):
            continue
        return detail
    return None


def prior_linkedin_indeterminate(posted_destinations) -> bool:
    for entry in posted_destinations or []:
        if not isinstance(entry, dict):
            continue
        if (
            str(entry.get("name") or "").strip().lower() == "linkedin"
            and str(entry.get("status") or "") == STATUS_INDETERMINATE
        ):
            return True
    return False


def already_posted(name: str, posted_destinations) -> bool:
    return already_posted_detail(name, posted_destinations) is not None


def refuse_forbidden_destination(name: str) -> None:
    key = str(name or "").strip().lower()
    if key in FORBIDDEN_DESTINATIONS or key == "reddit":
        raise SocialBlockedError(
            "Reddit is banned; never queue or post Reddit"
            if key == "reddit"
            else f"{name} is not a cloud-runner destination"
        )


def build_social_caption(post_data: dict, live_url: str, *, limit: int | None = None) -> str:
    city = str(post_data.get("city") or "").strip()
    summary = ensure_city_stamp(
        str(post_data.get("post-summary") or post_data.get("title") or "").strip(),
        city,
        post_data,
    )
    price = display_price_subtotal(post_data)
    parts = [summary]
    if price:
        parts.append(f"Install subtotal: {price}.")
    if live_url:
        parts.append(live_url)
    caption = "\n\n".join(parts)
    if limit and len(caption) > limit:
        caption = caption[: max(0, limit - 1)].rstrip() + "…"
    return caption


def _destination(name: str, status: str, detail: str = "") -> dict:
    return {"name": name, "status": status, "detail": str(detail or "")[:300]}


def jpeg_bytes(image_bytes: bytes, *, purpose: str) -> bytes:
    """Decode the bound image and return a real RGB JPEG rendition."""
    if not image_bytes:
        raise SocialRetryableError(f"{purpose} rendition needs the bound photo bytes")
    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            image.load()
            rgb_image = image.convert("RGB")
            output = io.BytesIO()
            rgb_image.save(output, format="JPEG", quality=90)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise SocialRetryableError(f"{purpose} rendition failed: {exc}") from exc
    rendered = output.getvalue()
    if not rendered.startswith(b"\xff\xd8\xff"):
        raise SocialRetryableError(f"{purpose} rendition did not produce JPEG bytes")
    return rendered


def linkedin_jpeg_bytes(image_bytes: bytes) -> bytes:
    """Decode the bound image and return a real RGB JPEG rendition."""
    return jpeg_bytes(image_bytes, purpose="LinkedIn JPEG")


def instagram_jpeg_bytes(image_bytes: bytes) -> bytes:
    """Decode the bound dashboard WebP and return a real RGB JPEG rendition."""
    return jpeg_bytes(image_bytes, purpose="Instagram JPEG")


def _as_int(value) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def graph_error_fields(response) -> dict:
    try:
        payload = response.json()
    except Exception:  # noqa: BLE001
        payload = None
    error = payload.get("error") if isinstance(payload, dict) else None
    return error if isinstance(error, dict) else {}


def is_instagram_media_not_ready(response) -> bool:
    """True for Meta 9007 / 2207027 — container exists but is not publishable yet."""
    if getattr(response, "status_code", 0) != 400:
        return False
    error = graph_error_fields(response)
    if _as_int(error.get("code")) == IG_MEDIA_NOT_READY_CODE:
        return True
    if _as_int(error.get("error_subcode")) == IG_MEDIA_NOT_READY_SUBCODE:
        return True
    blob = " ".join(
        str(part or "")
        for part in (
            error.get("message"),
            error.get("error_user_title"),
            getattr(response, "text", ""),
        )
    )
    return (
        str(IG_MEDIA_NOT_READY_CODE) in blob
        or str(IG_MEDIA_NOT_READY_SUBCODE) in blob
        or "Media ID is not available" in blob
    )


def _linkedin_created_post_id(response) -> str:
    headers = getattr(response, "headers", None) or {}
    header_id = str(headers.get("x-restli-id") or headers.get("X-RestLi-Id") or "")
    if not is_linkedin_post_id(header_id):
        raise SocialIndeterminateError(
            "LinkedIn post create HTTP 201 requires x-restli-id with a share or ugcPost URN"
        )
    return header_id


# ---------------------------------------------------------------------------
# X / Twitter OAuth 1.0a (same contract as lib/x-oauth1.mjs)
# ---------------------------------------------------------------------------


def _percent_encode(value: object) -> str:
    return urllib.parse.quote(str(value), safe="-_.~")


def sign_oauth1(*, method: str, url: str, consumer_key: str, consumer_secret: str,
                token: str, token_secret: str, extra_params: dict | None = None,
                nonce: str | None = None, timestamp: str | None = None) -> str:
    oauth_params = {
        "oauth_consumer_key": consumer_key,
        "oauth_nonce": nonce or uuid4().hex,
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": timestamp or str(int(time.time())),
        "oauth_token": token,
        "oauth_version": "1.0",
    }
    parsed = urllib.parse.urlsplit(url)
    params = dict(oauth_params)
    params.update(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
    params.update({k: str(v) for k, v in (extra_params or {}).items() if v is not None})
    param_string = "&".join(
        f"{_percent_encode(k)}={_percent_encode(params[k])}" for k in sorted(params)
    )
    base_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
    base_string = "&".join([
        method.upper(),
        _percent_encode(base_url),
        _percent_encode(param_string),
    ])
    signing_key = f"{_percent_encode(consumer_secret)}&{_percent_encode(token_secret)}"
    digest = hmac.new(signing_key.encode("utf-8"), base_string.encode("utf-8"), hashlib.sha1)
    oauth_params["oauth_signature"] = base64.b64encode(digest.digest()).decode("ascii")
    header = ", ".join(
        f'{_percent_encode(k)}="{_percent_encode(oauth_params[k])}"'
        for k in sorted(oauth_params)
    )
    return f"OAuth {header}"


def assert_mountingmantv(user: dict) -> dict:
    screen_name = str(user.get("screen_name") or "").strip()
    if screen_name != MOUNTINGMANTV_SCREEN_NAME:
        raise SocialBlockedError(
            f"Refusing X action: verified account is @{screen_name or 'unknown'}, "
            f"expected @{MOUNTINGMANTV_SCREEN_NAME}."
        )
    return {"screen_name": screen_name, "id": str(user.get("id_str") or user.get("id") or "")}


# ---------------------------------------------------------------------------
# Per-destination publishers
# ---------------------------------------------------------------------------


class SocialPublisher:
    """One run: Instagram, Facebook, LinkedIn, X. Never Reddit. Never GBP."""

    def __init__(
        self,
        env: dict | None = None,
        http=None,
        *,
        sleep: Callable[[float], None] | None = None,
        clock: Callable[[], float] | None = None,
        ig_container_poll_attempts: int = IG_CONTAINER_POLL_ATTEMPTS,
        ig_container_poll_interval: float = IG_CONTAINER_POLL_INTERVAL_SECONDS,
        ig_container_wait_seconds: float = IG_CONTAINER_WAIT_SECONDS,
        ig_container_status_timeout: float = IG_CONTAINER_STATUS_TIMEOUT_SECONDS,
        ig_publish_attempts: int = IG_PUBLISH_ATTEMPTS,
        ig_publish_retry_wait: float = IG_PUBLISH_RETRY_WAIT_SECONDS,
    ):
        self.env = env if env is not None else os.environ
        self.http = http or requests
        self.sleep = sleep or time.sleep
        self.clock = clock or time.monotonic
        self.ig_container_poll_attempts = max(1, int(ig_container_poll_attempts))
        self.ig_container_poll_interval = float(ig_container_poll_interval)
        self.ig_container_wait_seconds = float(ig_container_wait_seconds)
        self.ig_container_status_timeout = float(ig_container_status_timeout)
        self.ig_publish_attempts = max(1, int(ig_publish_attempts))
        self.ig_publish_retry_wait = float(ig_publish_retry_wait)

    def publish(
        self,
        *,
        post_data: dict,
        live_url: str,
        image_url: str,
        image_bytes: bytes,
        slug: str,
        posted_destinations=None,
    ) -> list[dict]:
        results = []
        for name in SOCIAL_DESTINATIONS:
            refuse_forbidden_destination(name)
            if name == "linkedin" and prior_linkedin_indeterminate(posted_destinations):
                results.append(_destination(
                    name,
                    STATUS_INDETERMINATE,
                    "LinkedIn prior create outcome requires manual reconciliation; automatic retry refused",
                ))
                continue
            posted_detail = already_posted_detail(name, posted_destinations)
            if posted_detail is not None:
                detail = posted_detail if name == "linkedin" else f"skipped: already posted for {slug}"
                results.append(_destination(name, STATUS_PUBLISHED, detail))
                continue
            try:
                detail = self._publish_one(
                    name,
                    post_data=post_data,
                    live_url=live_url,
                    image_url=image_url,
                    image_bytes=image_bytes,
                )
                results.append(_destination(name, STATUS_PUBLISHED, detail))
            except SocialSkip as exc:
                results.append(_destination(name, STATUS_SKIPPED, str(exc)))
            except SocialBlockedError as exc:
                results.append(_destination(name, STATUS_BLOCKED, str(exc)))
            except SocialIndeterminateError as exc:
                results.append(_destination(name, STATUS_INDETERMINATE, str(exc)))
            except SocialRetryableError as exc:
                results.append(_destination(name, STATUS_RETRYABLE, str(exc)))
            except Exception as exc:  # noqa: BLE001 — classify unexpected as retryable
                results.append(_destination(name, STATUS_RETRYABLE, f"{type(exc).__name__}: {exc}"))
        return results

    def _publish_one(self, name: str, **kwargs) -> str:
        if name == "instagram":
            return self._instagram(**kwargs)
        if name == "facebook":
            return self._facebook(**kwargs)
        if name == "linkedin":
            return self._linkedin(**kwargs)
        if name == "x":
            return self._x(**kwargs)
        raise SocialBlockedError(f"{name} is not a cloud-runner destination")

    def _instagram(self, *, post_data, live_url, image_url, image_bytes) -> str:
        creds = require_env(INSTAGRAM_ENV, self.env)
        caption = build_social_caption(post_data, live_url)
        ig_id = creds["INSTAGRAM_BUSINESS_ACCOUNT_ID"]
        token = creds["FACEBOOK_PAGE_ACCESS_TOKEN"]
        jpeg_url = self._host_jpeg_rendition(
            page_id=creds["FACEBOOK_PAGE_ID"],
            token=token,
            image_bytes=image_bytes,
            fallback_url=image_url,
        )
        created = self._graph_post(
            f"{GRAPH_BASE}/{ig_id}/media",
            data={"image_url": jpeg_url, "caption": caption, "access_token": token},
            action="Instagram media create",
        )
        creation_id = str(created.get("id") or "")
        if not creation_id:
            raise SocialRetryableError("Instagram media create returned no id")
        self._wait_for_instagram_container(creation_id, token)
        published = self._publish_instagram_media(ig_id=ig_id, creation_id=creation_id, token=token)
        return str(published.get("id") or creation_id)

    def _instagram_container_status(self, creation_id: str, token: str) -> str:
        try:
            response = self.http.get(
                f"{GRAPH_BASE}/{creation_id}",
                params={"fields": "status_code", "access_token": token},
                timeout=self.ig_container_status_timeout,
            )
        except requests.exceptions.Timeout:
            return IG_CONTAINER_TRANSPORT_TIMEOUT
        except requests.exceptions.RequestException as exc:
            raise SocialRetryableError(f"Instagram media status failed: {exc}") from exc
        self._raise_http(response, "Instagram media status")
        payload = response.json() or {}
        return str(payload.get("status_code") or "").strip().upper()

    def _wait_for_instagram_container(self, creation_id: str, token: str) -> str:
        """Poll until FINISHED. ERROR/EXPIRED is a refusal. Timeout does not hang."""
        deadline = self.clock() + self.ig_container_wait_seconds
        last_status = ""
        attempts = self.ig_container_poll_attempts
        for attempt in range(attempts):
            if attempt and self.clock() >= deadline:
                break
            last_status = self._instagram_container_status(creation_id, token)
            if last_status in IG_CONTAINER_READY:
                return last_status
            if last_status in IG_CONTAINER_FAILED:
                raise SocialBlockedError(f"Instagram media container {last_status}")
            if last_status == IG_CONTAINER_TRANSPORT_TIMEOUT:
                return "IN_PROGRESS"
            if attempt + 1 >= attempts:
                break
            remaining = deadline - self.clock()
            if remaining <= 0:
                break
            self.sleep(min(self.ig_container_poll_interval, remaining))
        raise SocialRetryableError(
            f"Instagram media container not ready after {attempts} polls "
            f"(last status={last_status or 'unknown'})"
        )

    def _publish_instagram_media(self, *, ig_id: str, creation_id: str, token: str) -> dict:
        """Publish the ready container. 9007 / 2207027 waits and retries in this job."""
        last_body = ""
        last_status = 400
        for attempt in range(self.ig_publish_attempts):
            try:
                response = self.http.post(
                    f"{GRAPH_BASE}/{ig_id}/media_publish",
                    data={"creation_id": creation_id, "access_token": token},
                    timeout=45,
                )
            except requests.exceptions.RequestException as exc:
                raise SocialRetryableError(f"Instagram media publish failed: {exc}") from exc
            if is_instagram_media_not_ready(response):
                last_status = getattr(response, "status_code", 400)
                last_body = self._response_body(response)
                if attempt + 1 >= self.ig_publish_attempts:
                    break
                self.sleep(self.ig_publish_retry_wait)
                continue
            self._raise_http(response, "Instagram media publish")
            return response.json() or {}
        raise SocialBlockedError(
            f"Instagram media publish failed with HTTP {last_status}"
            f"{': ' + last_body if last_body else ''}"
        )

    def _facebook(self, *, post_data, live_url, image_url, image_bytes) -> str:
        del image_bytes
        creds = require_env(FACEBOOK_ENV, self.env)
        caption = build_social_caption(post_data, live_url)
        page_id = creds["FACEBOOK_PAGE_ID"]
        token = creds["FACEBOOK_PAGE_ACCESS_TOKEN"]
        published = self._graph_post(
            f"{GRAPH_BASE}/{page_id}/photos",
            data={"url": image_url, "caption": caption, "access_token": token},
            action="Facebook photo publish",
        )
        post_id = str(published.get("post_id") or published.get("id") or "")
        if not post_id:
            raise SocialRetryableError("Facebook photo publish returned no id")
        return post_id

    def _linkedin(self, *, post_data, live_url, image_url, image_bytes) -> str:
        del image_url
        creds = require_env(LINKEDIN_ENV, self.env)
        token = creds["LINKEDIN_ACCESS_TOKEN"]
        author = require_linkedin_person_author(creds["LINKEDIN_AUTHOR_URN"])
        linkedin_version = _env("LINKEDIN_VERSION", self.env) or LINKEDIN_VERSION_DEFAULT
        caption = build_social_caption(post_data, live_url, limit=3000)
        jpeg_bytes = linkedin_jpeg_bytes(image_bytes)
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Linkedin-Version": linkedin_version,
            "X-Restli-Protocol-Version": "2.0.0",
        }
        try:
            initialized = self.http.post(
                LINKEDIN_IMAGES_URL,
                headers=headers,
                json={
                    "initializeUploadRequest": {"owner": author}
                },
                timeout=45,
            )
        except requests.exceptions.RequestException as exc:
            raise SocialRetryableError(f"LinkedIn image initialize failed: {exc}") from exc
        self._raise_http(initialized, "LinkedIn image initialize")
        value = (initialized.json() or {}).get("value") or {}
        image_urn = str(value.get("image") or "")
        upload_url = str(value.get("uploadUrl") or "")
        if not image_urn.startswith("urn:li:image:") or not upload_url:
            raise SocialRetryableError("LinkedIn image initialize returned no image or upload URL")
        try:
            uploaded = self.http.put(
                upload_url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "image/jpeg",
                    "Content-Disposition": 'attachment; filename="install.jpg"',
                },
                data=jpeg_bytes,
                timeout=60,
            )
        except requests.exceptions.RequestException as exc:
            raise SocialRetryableError(f"LinkedIn image upload failed: {exc}") from exc
        self._raise_http(uploaded, "LinkedIn image upload")
        try:
            created = self.http.post(
                LINKEDIN_POSTS_URL,
                headers=headers,
                json={
                    "author": author,
                    "commentary": caption,
                    "visibility": "PUBLIC",
                    "distribution": {"feedDistribution": "MAIN_FEED"},
                    "content": {"media": {"id": image_urn}},
                    "lifecycleState": "PUBLISHED",
                    "isReshareDisabledByAuthor": False,
                },
                timeout=45,
            )
        except requests.exceptions.RequestException as exc:
            raise SocialIndeterminateError(
                "LinkedIn post create outcome is unknown after a transport failure"
            ) from exc
        create_status = getattr(created, "status_code", 0)
        if create_status >= 500 or 200 <= create_status < 300:
            if create_status != 201:
                raise SocialIndeterminateError(
                    f"LinkedIn post create outcome is unknown after HTTP {create_status}"
                )
        else:
            self._raise_http(created, "LinkedIn post create")
        return _linkedin_created_post_id(created)

    def _x(self, *, post_data, live_url, image_url, image_bytes) -> str:
        del image_url
        creds = require_env(X_ENV, self.env)
        user = self._x_verify(creds)
        assert_mountingmantv(user)
        media_id = self._x_upload_media(creds, image_bytes)
        caption = build_social_caption(post_data, live_url, limit=280)
        header = sign_oauth1(
            method="POST",
            url=X_CREATE_TWEET_URL,
            consumer_key=creds["TWITTER_API_KEY"],
            consumer_secret=creds["TWITTER_API_SECRET"],
            token=creds["TWITTER_ACCESS_TOKEN"],
            token_secret=creds["TWITTER_ACCESS_TOKEN_SECRET"],
        )
        try:
            response = self.http.post(
                X_CREATE_TWEET_URL,
                headers={"Authorization": header, "Content-Type": "application/json"},
                json={"text": caption, "media": {"media_ids": [media_id]}},
                timeout=45,
            )
        except requests.exceptions.RequestException as exc:
            raise SocialRetryableError(f"X tweet create failed: {exc}") from exc
        self._raise_http(response, "X tweet create")
        tweet_id = str(((response.json() or {}).get("data") or {}).get("id") or "")
        if not tweet_id:
            raise SocialRetryableError("X tweet create returned no id")
        return f"https://x.com/{MOUNTINGMANTV_SCREEN_NAME}/status/{tweet_id}"

    def _x_verify(self, creds: dict) -> dict:
        header = sign_oauth1(
            method="GET",
            url=X_VERIFY_URL,
            consumer_key=creds["TWITTER_API_KEY"],
            consumer_secret=creds["TWITTER_API_SECRET"],
            token=creds["TWITTER_ACCESS_TOKEN"],
            token_secret=creds["TWITTER_ACCESS_TOKEN_SECRET"],
        )
        try:
            response = self.http.get(X_VERIFY_URL, headers={"Authorization": header}, timeout=30)
        except requests.exceptions.RequestException as exc:
            raise SocialRetryableError(f"X verify_credentials failed: {exc}") from exc
        self._raise_http(response, "X verify_credentials")
        return response.json() or {}

    def _x_upload_media(self, creds: dict, image_bytes: bytes) -> str:
        header = sign_oauth1(
            method="POST",
            url=X_MEDIA_UPLOAD_URL,
            consumer_key=creds["TWITTER_API_KEY"],
            consumer_secret=creds["TWITTER_API_SECRET"],
            token=creds["TWITTER_ACCESS_TOKEN"],
            token_secret=creds["TWITTER_ACCESS_TOKEN_SECRET"],
        )
        try:
            response = self.http.post(
                X_MEDIA_UPLOAD_URL,
                headers={"Authorization": header},
                files={"media": ("install.webp", image_bytes, "image/webp")},
                timeout=60,
            )
        except requests.exceptions.RequestException as exc:
            raise SocialRetryableError(f"X media upload failed: {exc}") from exc
        self._raise_http(response, "X media upload")
        media_id = str((response.json() or {}).get("media_id_string") or "")
        if not media_id:
            raise SocialRetryableError("X media upload returned no media_id")
        return media_id

    def _host_jpeg_rendition(self, *, page_id: str, token: str, image_bytes: bytes, fallback_url: str) -> str:
        """Host a JPEG that Instagram will accept.

        Dashboard photos are WebP. Instagram's ``/{ig-user-id}/media`` image
        container requires a JPEG URL. Convert the bound bytes first (same
        Pillow path as LinkedIn), then upload real JPEG to an unpublished
        Facebook Page photo and read back a non-WebP CDN URL — no third host,
        no Reddit, no GBP.
        """
        hosted_jpeg = instagram_jpeg_bytes(image_bytes)
        try:
            uploaded = self.http.post(
                f"{GRAPH_BASE}/{page_id}/photos",
                data={"published": "false", "access_token": token},
                files={"source": ("install.jpg", hosted_jpeg, "image/jpeg")},
                timeout=60,
            )
        except requests.exceptions.RequestException as exc:
            raise SocialRetryableError(f"Instagram JPEG host failed: {exc}") from exc
        self._raise_http(uploaded, "Instagram JPEG host")
        photo_id = str((uploaded.json() or {}).get("id") or "")
        if not photo_id:
            raise SocialRetryableError("Instagram JPEG host returned no photo id")
        try:
            lookup = self.http.get(
                f"{GRAPH_BASE}/{photo_id}",
                params={"fields": "images", "access_token": token},
                timeout=30,
            )
        except requests.exceptions.RequestException as exc:
            raise SocialRetryableError(f"Instagram JPEG lookup failed: {exc}") from exc
        self._raise_http(lookup, "Instagram JPEG lookup")
        images = (lookup.json() or {}).get("images") or []
        jpeg_url = ""
        for image in images:
            url = str((image or {}).get("source") or "").strip()
            if url and ".webp" not in url.lower():
                jpeg_url = url
                break
        if not jpeg_url:
            raise SocialRetryableError("Instagram JPEG lookup returned no JPEG URL")
        if fallback_url and jpeg_url.rstrip("/") == str(fallback_url).rstrip("/"):
            raise SocialRetryableError("Instagram JPEG host returned the original WebP URL")
        return jpeg_url

    def _graph_post(self, url: str, *, data: dict, action: str) -> dict:
        try:
            response = self.http.post(url, data=data, timeout=45)
        except requests.exceptions.RequestException as exc:
            raise SocialRetryableError(f"{action} failed: {exc}") from exc
        self._raise_http(response, action)
        return response.json() or {}

    def _response_body(self, response) -> str:
        try:
            return str(response.text or "")[:200]
        except Exception:  # noqa: BLE001
            return ""

    def _raise_http(self, response, action: str) -> None:
        status = getattr(response, "status_code", 0)
        if 200 <= status < 300:
            return
        body = self._response_body(response)
        if status in (400, 403, 422):
            raise SocialBlockedError(f"{action} failed with HTTP {status}{': ' + body if body else ''}")
        raise SocialRetryableError(f"{action} failed with HTTP {status}{': ' + body if body else ''}")


def publish_socials(
    *,
    post_data: dict,
    live_url: str,
    image_url: str,
    image_bytes: bytes,
    slug: str,
    posted_destinations=None,
    env: dict | None = None,
    http=None,
    publisher: SocialPublisher | None = None,
) -> list[dict]:
    client = publisher or SocialPublisher(env=env, http=http)
    return client.publish(
        post_data=post_data,
        live_url=live_url,
        image_url=image_url,
        image_bytes=image_bytes,
        slug=slug,
        posted_destinations=posted_destinations,
    )
