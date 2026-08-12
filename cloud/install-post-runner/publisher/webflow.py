"""Webflow CMS publish + public read-back.

Vendored from the canonical publisher's `WebflowClient` (clients.py), reduced to
the website path the cloud runner needs. The asset is already uploaded by the
phone, so this module only creates the live item and verifies it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import requests

SITE_ID = "6536f19431181574585ac1ce"
COLLECTION_ID = "68167d5a313e2fd6f18650c9"
AUTHOR_ID = "68169b01e20ba520be080474"
INSTALLATIONS_BASE_URL = "https://www.themountingman.com/installations"

# Webflow's own 404 page id — a soft 404 renders with HTTP 200.
NOT_FOUND_PAGE_MARKER = 'data-wf-page="6536f19431181574585ac247"'


class WebflowError(RuntimeError):
    """Webflow rejected a request. `indeterminate` means it may have applied."""

    def __init__(self, message: str, *, indeterminate: bool = False) -> None:
        super().__init__(message)
        self.indeterminate = indeterminate


@dataclass
class BoundAsset:
    asset_id: str
    hosted_url: str


def _normalize_public_url(value: str) -> str:
    return str(value or "").strip().rstrip("/")


def _canonical_url_from_html(html: str) -> str:
    match = re.search(r'<link\s+href="([^"]+)"\s+rel="canonical"', html or "", flags=re.IGNORECASE)
    return match.group(1).strip() if match else ""


def _raise_for_status_with_body(resp: requests.Response, action: str) -> None:
    try:
        resp.raise_for_status()
    except requests.exceptions.HTTPError as exc:
        body = (resp.text or "").strip()
        if len(body) > 1200:
            body = f"{body[:1200]}…"
        detail = f": {body}" if body else ""
        raise WebflowError(f"{action} failed with HTTP {resp.status_code}{detail}") from exc


class WebflowPublisher:
    def __init__(
        self,
        token: str,
        *,
        site_id: str = SITE_ID,
        collection_id: str = COLLECTION_ID,
        author_id: str = AUTHOR_ID,
        base_url: str = INSTALLATIONS_BASE_URL,
        session: requests.Session | None = None,
    ) -> None:
        if not token:
            raise WebflowError("Webflow token is not configured")
        self.token = token
        self.site_id = site_id
        self.collection_id = collection_id
        self.author_id = author_id
        self.base_url = base_url
        self.http = session or requests

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}

    # -- reconciliation ----------------------------------------------------

    def find_item_by_slug(self, slug: str) -> dict | None:
        """Look up an existing item so a retry reconciles instead of duplicating."""
        resp = self.http.get(
            f"https://api.webflow.com/v2/collections/{self.collection_id}/items",
            headers={"Authorization": f"Bearer {self.token}", "accept": "application/json"},
            params={"slug": slug},
            timeout=60,
        )
        _raise_for_status_with_body(resp, "Webflow item lookup")
        for item in resp.json().get("items", []) or []:
            if str((item.get("fieldData") or {}).get("slug") or "").strip() == slug:
                return item
        return None

    # -- publish -----------------------------------------------------------

    def build_field_data(self, post_data: dict, asset: BoundAsset) -> dict:
        city = post_data["city"]
        alt_text = (
            f"{post_data.get('tv-size', 'TV')} {post_data.get('tv-brand', '').strip()} "
            f"installation in {city}"
        ).strip()
        image_obj = {"url": asset.hosted_url, "alt": alt_text}
        if asset.asset_id:
            image_obj["fileId"] = asset.asset_id

        mount_value = str(post_data.get("mount-type") or post_data.get("bracket-type") or "").strip().lower()
        title_value = str(post_data.get("title") or "").strip().lower()
        job_notes_value = str(post_data.get("job-notes") or "").strip().lower()
        is_mantelmount = (
            bool(post_data.get("mantelmount"))
            or "mantelmount" in mount_value
            or "mantelmount" in title_value
            or "mantelmount" in job_notes_value
        )

        field_data = {
            "name": post_data["title"],
            "slug": post_data["slug"],
            "post-body": post_data["post-body"],
            "post-summary": post_data["post-summary"],
            "author": self.author_id,
            "tv-size": post_data.get("tv-size", ""),
            "tv-brand": post_data.get("tv-brand", ""),
            "wall-surface": post_data.get("wall-surface", ""),
            "metro-area": post_data.get("metro-area", ""),
            "installation-post": True,
            "featured": False,
            "mantelmount": is_mantelmount,
            "gallery-style-tv-samsung-frame-hisense-canvas-tcl-nxtframe-lg-g-series": bool(
                post_data.get("gallery-style")
            ),
            "main-image": image_obj,
            "thumbnail-image": image_obj,
        }
        location_id = str(post_data.get("location-id", "")).strip()
        if location_id:
            field_data["locations"] = [location_id]
        if post_data.get("fireplace-type"):
            field_data["fireplace-type"] = post_data["fireplace-type"]
        if post_data.get("price"):
            field_data["price"] = f"${post_data['price']}"
        return field_data

    def create_live_item(self, post_data: dict, asset: BoundAsset) -> dict:
        field_data = self.build_field_data(post_data, asset)
        try:
            resp = self.http.post(
                f"https://api.webflow.com/v2/collections/{self.collection_id}/items/live",
                headers=self.headers,
                json={"fieldData": field_data},
                timeout=60,
            )
        except requests.exceptions.RequestException as exc:
            # The request may have been applied before the connection dropped.
            raise WebflowError(f"Webflow live item create did not complete: {exc}", indeterminate=True) from exc
        _raise_for_status_with_body(resp, "Webflow live item create")
        return resp.json()

    # -- verification ------------------------------------------------------

    def verify_live(self, item_id: str, slug: str) -> dict:
        item_resp = self.http.get(
            f"https://api.webflow.com/v2/collections/{self.collection_id}/items/{item_id}",
            headers={"Authorization": f"Bearer {self.token}", "accept": "application/json"},
            timeout=60,
        )
        _raise_for_status_with_body(item_resp, "Webflow item read-back")
        field_data = item_resp.json().get("fieldData", {}) or {}
        image_url = (field_data.get("main-image") or {}).get("url", "")
        if image_url:
            head = self.http.head(image_url, allow_redirects=True, timeout=30)
            if head.status_code >= 400:
                raise WebflowError(f"Published image is not reachable (HTTP {head.status_code})")

        live_url = f"{self.base_url}/{slug}"
        page = self.http.get(live_url, timeout=30)
        expected_url = _normalize_public_url(live_url)
        final_url = _normalize_public_url(getattr(page, "url", live_url))
        canonical_url = _normalize_public_url(_canonical_url_from_html(page.text))
        looks_like_404 = (
            "Page Not Found" in page.text
            or "<title>Not Found</title>" in page.text
            or NOT_FOUND_PAGE_MARKER in page.text
        )
        if (
            page.status_code != 200
            or final_url != expected_url
            or (canonical_url and canonical_url != expected_url)
            or looks_like_404
        ):
            raise WebflowError(f"Unexpected live URL state for {live_url}")

        return {"live_url": live_url, "image_url": image_url, "public_status": page.status_code}
