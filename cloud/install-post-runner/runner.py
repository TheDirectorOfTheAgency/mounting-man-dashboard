#!/usr/bin/env python3
"""Cloud installation-post runner.

Receives only an opaque job id and the approved revision. Everything else is
fetched from a signed internal endpoint, so no installation facts, customer
data, or credentials pass through workflow inputs or logs.

Contract:
  1. fetch the approved envelope and confirm it is the dispatched job/revision
  2. re-download the bound photo and confirm its digest matches the approval
  3. build post data with the canonical house-copy engine (art mode: never)
  4. reconcile an existing post for the same photo instead of duplicating
  5. create the live Webflow item and read the public URL back
  6. report a sanitized, classified result through a signed callback

Queue acknowledgement is never success: only a real publisher result plus an
HTTP 200 public read-back is reported as PUBLISHED.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import NamedTuple

RUNNER_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(RUNNER_DIR / "publisher"))

import requests  # noqa: E402

from content import enrich_post_data, load_location_id_city_map  # noqa: E402
from seed import (  # noqa: E402
    _LOCATION_IDS_PATH,
    _get_nearby_cities,
    normalize_seed_post_data,
)
from social import SocialPublisher, publish_socials  # noqa: E402
from webflow import BoundAsset, WebflowError, WebflowPublisher  # noqa: E402

ENVELOPE_PATH = "/api/install-post/runner/envelope"
CALLBACK_PATH = "/api/install-post/runner/callback"

STATUS_PUBLISHED = "PUBLISHED"
STATUS_RETRYABLE = "RETRYABLE_FAILURE"
STATUS_BLOCKED = "BLOCKED"
STATUS_INDETERMINATE = "INDETERMINATE"

RESULT_FIELDS = ("status", "liveUrl", "imageUrl", "itemId", "slug", "publicStatus", "message", "destinations")

_EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
_PHONE_RE = re.compile(r"(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}")
_BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_CREDENTIAL_RE = re.compile(
    r"\b(token|secret|key|password|authorization|signature)\b(\s*[:=]\s*|\s+)[\"']?[A-Za-z0-9._~+/=-]{8,}[\"']?",
    re.IGNORECASE,
)


def redact(text: object) -> str:
    """Mirror of the Node-side redaction so nothing sensitive reaches the queue."""
    value = str(text if text is not None else "")
    value = _BEARER_RE.sub("Bearer [redacted]", value)
    value = _CREDENTIAL_RE.sub(lambda m: f"{m.group(1)}=[redacted]", value)
    value = _EMAIL_RE.sub("[redacted]", value)
    value = _PHONE_RE.sub("[redacted]", value)
    return value[:600]


# ---------------------------------------------------------------------------
# Signed transport
# ---------------------------------------------------------------------------


_JS_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}

_ARRAY_INDEX_RE = re.compile(r"^(0|[1-9][0-9]*)$")

_JS_MAX_SAFE_INTEGER = 2 ** 53 - 1


def _js_string(value: str) -> str:
    out = ['"']
    for char in value:
        code = ord(char)
        if char in _JS_ESCAPES:
            out.append(_JS_ESCAPES[char])
        elif code < 0x20 or 0xD800 <= code <= 0xDFFF:
            # JSON.stringify escapes C0 controls and lone surrogates, and emits
            # everything else raw — including U+2028/U+2029 and astral planes.
            out.append("\\u%04x" % code)
        else:
            out.append(char)
    out.append('"')
    return "".join(out)


def _js_number(value) -> str:
    # JavaScript has one number type, so `200.0` serializes as `200`. Anything
    # whose JS rendering we cannot reproduce exactly is refused rather than
    # signed into a body the verifier will hash differently.
    if isinstance(value, int):
        if abs(value) > _JS_MAX_SAFE_INTEGER:
            raise ValueError("integer is outside the JavaScript safe range")
        return str(value)
    if value != value or value in (float("inf"), float("-inf")):
        raise ValueError("non-finite numbers are not valid JSON")
    if value.is_integer() and abs(value) <= _JS_MAX_SAFE_INTEGER:
        return str(int(value))
    raise ValueError("only integral numbers can be signed interoperably")


def canonical_body(body: object) -> str:
    """Render `body` exactly as Node's `JSON.stringify` would.

    The Node verifier hashes `JSON.stringify(parsedBody)`, so the signature only
    holds if this rendering is a `JSON.parse` -> `JSON.stringify` fixed point.
    `json.dumps(ensure_ascii=False)` is not: it writes `1.0` where JS writes `1`,
    and it cannot encode a lone surrogate at all.
    """
    if body is None:
        return "null"
    if body is True:
        return "true"
    if body is False:
        return "false"
    if isinstance(body, str):
        return _js_string(body)
    if isinstance(body, (int, float)):
        return _js_number(body)
    if isinstance(body, (list, tuple)):
        return "[" + ",".join(canonical_body(item) for item in body) + "]"
    if isinstance(body, dict):
        parts = []
        for key, item in body.items():
            if not isinstance(key, str):
                raise TypeError("only string keys can be signed")
            if _ARRAY_INDEX_RE.match(key):
                # JSON.parse hoists array-index keys ahead of the rest, so key
                # order would silently differ between the two serializers.
                raise ValueError("array-index keys reorder under JSON.parse")
            parts.append(f"{_js_string(key)}:{canonical_body(item)}")
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"cannot canonicalize {type(body).__name__}")


def sign_request(*, secret: str, method: str, path: str, body: object, timestamp: int) -> str:
    if not secret:
        raise RuntimeError("install-post runner secret is not configured")
    import hmac

    digest = hashlib.sha256(canonical_body(body).encode("utf-8")).hexdigest()
    canonical = f"{timestamp}.{method.upper()}.{path}.{digest}"
    mac = hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256)
    return f"v1={mac.hexdigest()}"


def _signed_post(http, *, api_base: str, path: str, body: dict, secret: str, timeout: int = 45):
    timestamp = int(time.time())
    # Send the exact bytes that were signed; letting `requests` re-serialize the
    # dict would put a different rendering on the wire than the signature covers.
    payload = canonical_body(body)
    return http.post(
        f"{api_base.rstrip('/')}{path}",
        headers={
            "Content-Type": "application/json",
            "x-install-post-signature": sign_request(
                secret=secret, method="POST", path=path, body=body, timestamp=timestamp
            ),
            "x-install-post-timestamp": str(timestamp),
        },
        data=payload.encode("utf-8"),
        timeout=timeout,
    )


# ---------------------------------------------------------------------------
# Result shaping
# ---------------------------------------------------------------------------


def _website_destination(status: str, payload: dict) -> dict:
    return {
        "name": "website",
        "status": status,
        "detail": redact(payload.get("liveUrl") or payload.get("message") or ""),
    }


def _result(status: str, *, message: str = "", destinations=None, **fields) -> dict:
    payload = {"status": status}
    if message:
        payload["message"] = redact(message)
    payload.update({key: value for key, value in fields.items() if value not in (None, "", [])})
    dests = [_website_destination(status, payload)]
    for entry in destinations or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip().lower()
        if name in ("website", "reddit", "gbp", "google-business-profile"):
            continue
        dests.append({
            "name": name,
            "status": redact(entry.get("status") or ""),
            "detail": redact(entry.get("detail") or ""),
        })
    payload["destinations"] = dests
    if any(entry.get("status") == STATUS_RETRYABLE for entry in dests if entry.get("name") != "website"):
        if status == STATUS_PUBLISHED:
            payload["status"] = STATUS_INDETERMINATE
            payload.setdefault("message", redact("Website is live; a social destination still needs a retry"))
    return {key: payload[key] for key in RESULT_FIELDS if key in payload}


class BlockedError(RuntimeError):
    """The job must not publish as-is. Never retried automatically."""


# ---------------------------------------------------------------------------
# Publish path
# ---------------------------------------------------------------------------


def _slug_candidates(base_slug: str) -> list[str]:
    # Month-year suffixes give collision-free slugs that still read well,
    # matching the canonical publisher rather than numeric bumps.
    month_year = datetime.now(timezone.utc).strftime("%b-%Y").lower()
    return [base_slug, f"{base_slug}-{month_year}", f"{base_slug}-{month_year}-2",
            f"{base_slug}-{month_year}-3", f"{base_slug}-{month_year}-4"]


def _item_image_url(item: dict) -> str:
    return str(((item.get("fieldData") or {}).get("main-image") or {}).get("url") or "").strip()


def _build_post_data(seed: dict) -> dict:
    post_data = normalize_seed_post_data(seed)
    city = post_data.get("city", "Twin Cities")
    post_data["nearby-cities"] = _get_nearby_cities(city)

    location_map = load_location_id_city_map(_LOCATION_IDS_PATH)
    location_id = str(post_data.get("location-id", "")).strip()
    if not location_id:
        city_to_id = {value.lower(): key for key, value in location_map.items()}
        city_lower = city.lower().strip()
        location_id = city_to_id.get(city_lower, "")
        if not location_id:
            for name, lid in city_to_id.items():
                if city_lower and (city_lower in name or name in city_lower):
                    location_id = lid
                    break
    post_data["location-id"] = location_id

    return enrich_post_data(post_data, location_map)


def _publish(*, job_id, revision, api_base, runner_secret, http, webflow, fetch_image, social=None):
    # ---- 1. approved envelope ----
    response = _signed_post(
        http, api_base=api_base, path=ENVELOPE_PATH, secret=runner_secret,
        body={"jobId": job_id, "revision": revision},
    )
    if response.status_code != 200:
        detail = (response.json() or {}).get("error", "unknown")
        raise BlockedError(f"Approved envelope unavailable (HTTP {response.status_code}: {detail})")
    env = response.json() or {}

    if env.get("jobId") != job_id or env.get("revision") != revision:
        raise BlockedError("Envelope does not match the dispatched job and revision")

    image = env.get("image") or {}
    hosted_url = str(image.get("hostedUrl") or "")
    if not hosted_url:
        raise BlockedError("Approved envelope has no bound photo")

    # ---- 2. the photo must be the one that was approved ----
    photo = fetch_image(hosted_url, timeout=60)
    if getattr(photo, "status_code", 0) != 200:
        raise WebflowError(f"Could not read the approved photo (HTTP {getattr(photo, 'status_code', 0)})")
    actual_digest = hashlib.sha256(photo.content).hexdigest()
    if actual_digest != str(image.get("sha256") or ""):
        raise BlockedError("Approved photo digest does not match the stored asset")

    # ---- 3. canonical house copy, no generated art ----
    post_data = _build_post_data(env.get("seed") or {})
    asset = BoundAsset(asset_id=str(image.get("assetId") or ""), hosted_url=hosted_url)

    # ---- 4. reconcile before creating ----
    base_slug = post_data["slug"]
    item = None
    for candidate in _slug_candidates(base_slug):
        occupant = webflow.find_item_by_slug(candidate)
        if occupant is None:
            post_data["slug"] = candidate
            break
        if _item_image_url(occupant) == hosted_url:
            # This exact photo is already published — a retry, not a new post.
            item = occupant
            post_data["slug"] = str((occupant.get("fieldData") or {}).get("slug") or candidate)
            break
        post_data["slug"] = candidate

    reused = item is not None
    if item is None:
        item = webflow.create_live_item(post_data, asset)

    item_id = str(item.get("id") or "")
    slug = str((item.get("fieldData") or {}).get("slug") or post_data["slug"])

    # ---- 5. success requires a public read-back ----
    try:
        verification = webflow.verify_live(item_id, slug)
    except WebflowError as exc:
        # The item exists; we simply cannot confirm the public page yet.
        raise WebflowError(str(exc), indeterminate=True) from _Carrier(item_id, slug)

    social_destinations = []
    if social is not None:
        social_destinations = publish_socials(
            post_data=post_data,
            live_url=verification.get("live_url", ""),
            image_url=verification.get("image_url", "") or hosted_url,
            image_bytes=photo.content,
            slug=slug,
            posted_destinations=env.get("postedDestinations") or [],
            publisher=social,
        )

    return _result(
        STATUS_PUBLISHED,
        liveUrl=verification.get("live_url", ""),
        imageUrl=verification.get("image_url", ""),
        itemId=item_id,
        slug=slug,
        publicStatus=verification.get("public_status", 0),
        message="Reused the existing post for this photo" if reused else "",
        destinations=social_destinations,
    )


class _Carrier(Exception):
    """Carries the created item through an indeterminate verification failure."""

    def __init__(self, item_id: str, slug: str) -> None:
        super().__init__("item created")
        self.item_id = item_id
        self.slug = slug


class RunOutcome(NamedTuple):
    """What happened, and whether the queue was actually told about it."""

    result: dict
    callback_delivered: bool


def run(*, job_id, revision, dispatch_id, api_base, runner_secret, http=None, webflow=None, fetch_image=None, social=None):
    http = http or requests
    fetch_image = fetch_image or requests.get

    try:
        result = _publish(
            job_id=job_id, revision=revision, api_base=api_base, runner_secret=runner_secret,
            http=http, webflow=webflow, fetch_image=fetch_image, social=social,
        )
    except BlockedError as exc:
        result = _result(STATUS_BLOCKED, message=str(exc))
    except WebflowError as exc:
        carrier = exc.__cause__ if isinstance(exc.__cause__, _Carrier) else None
        if exc.indeterminate:
            result = _result(
                STATUS_INDETERMINATE, message=str(exc),
                itemId=getattr(carrier, "item_id", None), slug=getattr(carrier, "slug", None),
            )
        else:
            result = _result(STATUS_RETRYABLE, message=str(exc))
    except Exception as exc:  # noqa: BLE001 — any unexpected failure is retryable, never silent
        result = _result(STATUS_RETRYABLE, message=f"{type(exc).__name__}: {exc}")

    # An undelivered callback leaves the job stuck in PUBLISHING until the
    # queue ages it out, so it has to be reported as a failed run.
    delivered = False
    try:
        response = _signed_post(
            http, api_base=api_base, path=CALLBACK_PATH, secret=runner_secret,
            body={"jobId": job_id, "revision": revision, "dispatchId": dispatch_id, "result": result},
        )
        status = getattr(response, "status_code", 0)
        delivered = 200 <= status < 300
        if not delivered:
            print(
                json.dumps({"error": "callback_rejected", "status": status}),
                file=sys.stderr,
            )
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": "callback_failed", "detail": redact(exc)}), file=sys.stderr)

    return RunOutcome(result=result, callback_delivered=delivered)


def main() -> int:
    job_id = os.environ.get("JOB_ID", "").strip()
    revision = os.environ.get("REVISION", "").strip()
    dispatch_id = os.environ.get("DISPATCH_ID", "").strip()
    api_base = os.environ.get("INSTALL_POST_API_BASE", "").strip()
    runner_secret = os.environ.get("INSTALL_POST_RUNNER_SECRET", "").strip()
    webflow_token = os.environ.get("WEBFLOW_API_TOKEN", "").strip()

    missing = [
        name for name, value in (
            ("JOB_ID", job_id), ("REVISION", revision),
            # The callback is authenticated against the dispatch id, so a run
            # without one could publish and then never be able to report it.
            ("DISPATCH_ID", dispatch_id),
            ("INSTALL_POST_API_BASE", api_base),
            ("INSTALL_POST_RUNNER_SECRET", runner_secret),
            ("WEBFLOW_API_TOKEN", webflow_token),
        ) if not value
    ]
    if missing:
        print(json.dumps({"error": "missing_configuration", "names": missing}), file=sys.stderr)
        return 2

    outcome = run(
        job_id=job_id, revision=revision, dispatch_id=dispatch_id,
        api_base=api_base, runner_secret=runner_secret,
        webflow=WebflowPublisher(webflow_token),
        social=SocialPublisher(env=os.environ),
    )
    print(json.dumps(outcome.result))
    if not outcome.callback_delivered:
        print(
            json.dumps({"error": "callback_undelivered", "status": outcome.result["status"]}),
            file=sys.stderr,
        )
        return 1
    return 0 if outcome.result["status"] == STATUS_PUBLISHED else 1


if __name__ == "__main__":
    raise SystemExit(main())
