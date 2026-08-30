"""Social destinations for the cloud installation-post runner.

Vendored from the Hermes publisher's Graph / LinkedIn / X clients (clients.py
patterns): Instagram, Facebook, LinkedIn, and X/Twitter. Never Reddit. Never
Google Business Profile. X fails closed unless the authenticated screen_name
is MountingManTV.

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
import os
import time
import urllib.parse
from typing import Callable
from uuid import uuid4

import requests

from content import display_price_subtotal

SOCIAL_DESTINATIONS = ("instagram", "facebook", "linkedin", "x")
FORBIDDEN_DESTINATIONS = frozenset({"reddit", "gbp", "google-business-profile"})
MOUNTINGMANTV_SCREEN_NAME = "MountingManTV"

STATUS_PUBLISHED = "PUBLISHED"
STATUS_SKIPPED = "SKIPPED"
STATUS_BLOCKED = "BLOCKED"
STATUS_RETRYABLE = "RETRYABLE_FAILURE"

GRAPH_BASE = "https://graph.facebook.com/v21.0"
LINKEDIN_ASSETS_URL = "https://api.linkedin.com/v2/assets?action=registerUpload"
LINKEDIN_UGC_URL = "https://api.linkedin.com/v2/ugcPosts"
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


def already_posted(name: str, posted_destinations) -> bool:
    for entry in posted_destinations or []:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("name") or "").strip().lower() == name and str(entry.get("status") or "") == STATUS_PUBLISHED:
            return True
    return False


def refuse_forbidden_destination(name: str) -> None:
    key = str(name or "").strip().lower()
    if key in FORBIDDEN_DESTINATIONS or key == "reddit":
        raise SocialBlockedError(
            "Reddit is banned; never queue or post Reddit"
            if key == "reddit"
            else f"{name} is not a cloud-runner destination"
        )


def build_social_caption(post_data: dict, live_url: str, *, limit: int | None = None) -> str:
    summary = str(post_data.get("post-summary") or post_data.get("title") or "").strip()
    if not summary:
        city = str(post_data.get("city") or "").strip()
        summary = f"TV installation{' in ' + city if city else ''} by The Mounting Man."
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

    def __init__(self, env: dict | None = None, http=None):
        self.env = env if env is not None else os.environ
        self.http = http or requests

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
            if already_posted(name, posted_destinations):
                results.append(_destination(name, STATUS_PUBLISHED, f"skipped: already posted for {slug}"))
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
        published = self._graph_post(
            f"{GRAPH_BASE}/{ig_id}/media_publish",
            data={"creation_id": creation_id, "access_token": token},
            action="Instagram media publish",
        )
        return str(published.get("id") or creation_id)

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
        author = creds["LINKEDIN_AUTHOR_URN"]
        caption = build_social_caption(post_data, live_url, limit=3000)
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-Restli-Protocol-Version": "2.0.0",
        }
        try:
            register = self.http.post(
                LINKEDIN_ASSETS_URL,
                headers=headers,
                json={
                    "registerUploadRequest": {
                        "recipes": ["urn:li:digitalmediaRecipe:feedshare-image"],
                        "owner": author,
                        "serviceRelationships": [{
                            "relationshipType": "OWNER",
                            "identifier": "urn:li:userGeneratedContent",
                        }],
                    }
                },
                timeout=45,
            )
        except requests.exceptions.RequestException as exc:
            raise SocialRetryableError(f"LinkedIn upload register failed: {exc}") from exc
        self._raise_http(register, "LinkedIn upload register")
        value = (register.json() or {}).get("value") or {}
        asset = str(value.get("asset") or "")
        upload_url = (
            ((value.get("uploadMechanism") or {})
             .get("com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest") or {})
            .get("uploadUrl")
        )
        if not asset or not upload_url:
            raise SocialRetryableError("LinkedIn upload register returned no asset")
        try:
            uploaded = self.http.put(
                upload_url,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "image/webp"},
                data=image_bytes,
                timeout=60,
            )
        except requests.exceptions.RequestException as exc:
            raise SocialRetryableError(f"LinkedIn image upload failed: {exc}") from exc
        self._raise_http(uploaded, "LinkedIn image upload")
        try:
            created = self.http.post(
                LINKEDIN_UGC_URL,
                headers=headers,
                json={
                    "author": author,
                    "lifecycleState": "PUBLISHED",
                    "specificContent": {
                        "com.linkedin.ugc.ShareContent": {
                            "shareCommentary": {"text": caption},
                            "shareMediaCategory": "IMAGE",
                            "media": [{
                                "status": "READY",
                                "description": {"text": caption[:200]},
                                "media": asset,
                                "title": {"text": str(post_data.get("title") or "TV installation")},
                            }],
                        }
                    },
                    "visibility": {"com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"},
                },
                timeout=45,
            )
        except requests.exceptions.RequestException as exc:
            raise SocialRetryableError(f"LinkedIn post create failed: {exc}") from exc
        self._raise_http(created, "LinkedIn post create")
        return str(created.headers.get("x-restli-id") or created.headers.get("X-RestLi-Id") or asset)

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
        container requires JPEG. An unpublished Facebook Page photo is the
        existing Graph path that transcodes the bytes and returns a JPEG CDN
        URL — no third host, no Reddit, no GBP.
        """
        if not image_bytes:
            raise SocialRetryableError("Instagram JPEG rendition needs the bound photo bytes")
        try:
            uploaded = self.http.post(
                f"{GRAPH_BASE}/{page_id}/photos",
                data={"published": "false", "access_token": token},
                files={"source": ("install.jpg", image_bytes, "image/webp")},
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

    def _raise_http(self, response, action: str) -> None:
        status = getattr(response, "status_code", 0)
        if 200 <= status < 300:
            return
        body = ""
        try:
            body = str(response.text or "")[:200]
        except Exception:  # noqa: BLE001
            body = ""
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
