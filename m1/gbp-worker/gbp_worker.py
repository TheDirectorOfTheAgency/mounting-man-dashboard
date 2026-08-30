#!/usr/bin/env python3
"""Fail-closed remote queue adapter for one Google Business Profile surface."""

import argparse
import contextlib
import hashlib
import io
import json
import os
import re
import shutil
import stat
import tempfile
import time
import uuid
import warnings
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence
from urllib.parse import urlsplit

import requests
from PIL import Image


WORKER_VERSION = "1.0.0"
GBP_API_PATH = "/api/install-post/gbp"
EXPECTED_LOCATION_ID = "15921702740686840375"
EXPECTED_ACCOUNT = "mntvmounting@gmail.com"
EXPECTED_BUSINESS_NAME = "The Mounting Man"
ALLOWED_API_HOSTS = frozenset({"mounting-man-dashboard.vercel.app"})
ALLOWED_IMAGE_HOSTS = frozenset({"cdn.prod.website-files.com"})
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_PIXELS = 24_000_000
QUEUE_SCHEMA_VERSION = 2
REQUEST_TIMEOUT = (5, 30)
RETRY_DELAYS = (1.0, 2.0)
SURFACES = frozenset({"update", "photos"})
SURFACE_STATUSES = frozenset(
    {
        "pending",
        "claimed",
        "pending_review",
        "posted",
        "retryable_failure",
        "indeterminate",
    }
)
OPAQUE_ID_RE = re.compile(r"^[a-f0-9]{8,64}$")
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")


class WorkerError(RuntimeError):
    """Base class for sanitized worker failures."""


class ConfigError(WorkerError):
    pass


class SecurityError(WorkerError):
    pass


class SchemaError(WorkerError):
    pass


class BlockedError(WorkerError):
    pass


class LeaseConflict(WorkerError):
    pass


class RetryableError(WorkerError):
    pass


class IndeterminateError(WorkerError):
    pass


@dataclass(frozen=True)
class WorkerConfig:
    api_base: str
    worker_id: str
    secret_file: Path
    storage_state_path: Path
    artifact_dir: Path
    headed: bool


@dataclass(frozen=True)
class ClaimedSurface:
    item: Dict[str, Any]
    surface: str
    lease_token: str


@dataclass(frozen=True)
class DownloadedImage:
    source_path: Path
    upload_path: Path
    source_sha256: str
    content_type: str
    bytes: int

    def cleanup(self) -> None:
        shutil.rmtree(str(self.source_path.parent), ignore_errors=True)


@dataclass(frozen=True)
class SessionEvidence:
    account_verified: bool
    location_verified: bool
    surface_verified: bool
    surface: str

    @property
    def ok(self) -> bool:
        return self.account_verified and self.location_verified and self.surface_verified


@dataclass(frozen=True)
class ScreenshotProof:
    artifact_id: str
    sha256: str
    captured_at: str


_SAFE_LOG_KEYS = frozenset(
    {
        "status",
        "surface",
        "worker_version",
        "artifact_id",
        "queue_count",
        "reason_code",
        "attempt",
    }
)


def redact(value: object) -> str:
    del value
    return "<redacted>"


def sanitized_log(event: str, **safe_fields: object) -> None:
    record: Dict[str, object] = {"event": str(event)[:64]}
    for key, value in safe_fields.items():
        if key not in _SAFE_LOG_KEYS:
            record[key] = "<redacted>"
        elif isinstance(value, (bool, int, float)):
            record[key] = value
        else:
            record[key] = str(value)[:128]
    print(json.dumps(record, sort_keys=True), flush=True)


def _path_from_env(env: Mapping[str, str], key: str, default: Path) -> Path:
    raw = str(env.get(key, "")).strip()
    return Path(raw).expanduser() if raw else default


def load_config(env: Mapping[str, str] = os.environ) -> WorkerConfig:
    home = Path(str(env.get("HOME", Path.home()))).expanduser()
    headed_text = str(env.get("INSTALL_POST_GBP_HEADED", "0")).strip().lower()
    if headed_text not in {"0", "1", "false", "true"}:
        raise ConfigError("invalid headed setting")
    config = WorkerConfig(
        api_base=str(
            env.get(
                "INSTALL_POST_GBP_API_BASE",
                "https://mounting-man-dashboard.vercel.app",
            )
        ).strip(),
        worker_id=str(env.get("INSTALL_POST_GBP_WORKER_ID", "m1-gbp-01")).strip(),
        secret_file=_path_from_env(
            env,
            "INSTALL_POST_GBP_SECRET_FILE",
            home / ".config/themountingman/gbp-worker/worker-secret",
        ),
        storage_state_path=_path_from_env(
            env,
            "INSTALL_POST_GBP_STORAGE_STATE",
            home / ".local/share/themountingman/gbp-worker/storage_state.json",
        ),
        artifact_dir=_path_from_env(
            env,
            "INSTALL_POST_GBP_ARTIFACT_DIR",
            home / ".local/state/themountingman/gbp-worker/artifacts",
        ),
        headed=headed_text in {"1", "true"},
    )
    _validated_api_url(config.api_base)
    if not re.fullmatch(r"[A-Za-z0-9._-]{3,64}", config.worker_id):
        raise ConfigError("invalid worker id")
    return config


def read_worker_secret(path: Path) -> str:
    path = Path(path).expanduser()
    try:
        info = path.lstat()
    except OSError as exc:
        raise ConfigError("worker secret file is unavailable") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ConfigError("worker secret must be a regular file")
    if stat.S_IMODE(info.st_mode) != 0o600:
        raise ConfigError("worker secret file mode must be 0600")
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise ConfigError("worker secret file is unreadable") from exc
    if len(value) < 24 or any(character.isspace() for character in value):
        raise ConfigError("worker secret file is invalid")
    return value


def _validated_api_url(api_base: str) -> str:
    parsed = urlsplit(api_base)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in ALLOWED_API_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ConfigError("dashboard API base is not allowed")
    return "https://{}{}".format(parsed.hostname, GBP_API_PATH)


def _require_exact_keys(value: Mapping[str, Any], required: Iterable[str], label: str) -> None:
    missing = set(required) - set(value)
    if missing:
        raise SchemaError("{} schema is incomplete".format(label))


def _surface_status(item: Mapping[str, Any], surface: str) -> str:
    surfaces = item.get("surfaces")
    if not isinstance(surfaces, Mapping):
        raise SchemaError("surface schema is invalid")
    value = surfaces.get(surface)
    if not isinstance(value, Mapping) or not isinstance(value.get("status"), str):
        raise SchemaError("surface status is invalid")
    status_value = value["status"]
    if status_value not in SURFACE_STATUSES:
        raise SchemaError("unknown surface status")
    if surface == "photos" and status_value == "pending_review":
        raise SchemaError("photos cannot be pending review")
    return status_value


def validate_queue_item(item: object) -> Dict[str, Any]:
    if not isinstance(item, dict):
        raise SchemaError("queue item must be an object")
    required = (
        "schemaVersion",
        "jobId",
        "revision",
        "slug",
        "queuedAt",
        "caption",
        "cta_url",
        "image_url",
        "image_sha256",
        "required_surfaces",
        "surfaces",
    )
    _require_exact_keys(item, required, "queue item")
    if item["schemaVersion"] != QUEUE_SCHEMA_VERSION:
        raise SchemaError("unsupported queue schema version")
    for key in ("jobId", "slug", "queuedAt", "caption", "cta_url", "image_url"):
        if not isinstance(item[key], str) or not item[key].strip():
            raise SchemaError("queue item field is invalid")
    if not isinstance(item["revision"], str) or not SHA256_RE.fullmatch(item["revision"]):
        raise SchemaError("queue item revision is invalid")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", item["slug"]):
        raise SchemaError("queue item slug is invalid")
    if not SHA256_RE.fullmatch(item["image_sha256"]):
        raise SchemaError("queue image hash is invalid")
    required_surfaces = item["required_surfaces"]
    if (
        not isinstance(required_surfaces, list)
        or set(required_surfaces) != SURFACES
        or len(required_surfaces) != 2
    ):
        raise SchemaError("required surfaces are invalid")
    surfaces = item["surfaces"]
    if not isinstance(surfaces, dict) or set(surfaces) != SURFACES:
        raise SchemaError("surface records are invalid")
    _surface_status(item, "update")
    _surface_status(item, "photos")
    validate_image_url(item["image_url"])
    cta = urlsplit(item["cta_url"])
    if cta.scheme != "https" or not cta.hostname or cta.username or cta.password or cta.fragment:
        raise SchemaError("CTA URL is invalid")
    if item["cta_url"] in item["caption"]:
        raise SchemaError("caption must not contain CTA URL")
    return item


class DashboardQueueClient:
    """Strict authenticated client whose representation never includes auth."""

    def __init__(
        self,
        api_base: str,
        worker_id: str,
        secret_file: Path,
        session: Optional[Any] = None,
        sleeper: Any = time.sleep,
    ) -> None:
        self._endpoint = _validated_api_url(api_base)
        if not re.fullmatch(r"[A-Za-z0-9._-]{3,64}", worker_id):
            raise ConfigError("invalid worker id")
        self.worker_id = worker_id
        self._secret = read_worker_secret(Path(secret_file))
        self._session = session if session is not None else requests.Session()
        self._sleeper = sleeper

    def __repr__(self) -> str:
        return "DashboardQueueClient(endpoint={!r}, worker_id={!r})".format(
            self._endpoint, self.worker_id
        )

    def _headers(self) -> Dict[str, str]:
        return {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": "Bearer " + self._secret,
            "User-Agent": "themountingman-gbp-worker/" + WORKER_VERSION,
        }

    def _request(
        self,
        method: str,
        body: Optional[Dict[str, Any]] = None,
        safe_to_retry: bool = False,
    ) -> Dict[str, Any]:
        attempts = 1 + (len(RETRY_DELAYS) if safe_to_retry else 0)
        for attempt in range(attempts):
            try:
                response = self._session.request(
                    method,
                    self._endpoint,
                    headers=self._headers(),
                    json=body,
                    timeout=REQUEST_TIMEOUT,
                    allow_redirects=False,
                )
            except Exception as exc:
                if safe_to_retry and attempt < attempts - 1:
                    self._sleeper(RETRY_DELAYS[attempt])
                    continue
                raise RetryableError("dashboard request failed") from None
            status_code = getattr(response, "status_code", 0)
            if status_code in (301, 302, 303, 307, 308):
                raise SecurityError("dashboard redirect refused")
            if status_code in (401, 403):
                raise BlockedError("dashboard authentication blocked")
            if status_code == 409:
                raise LeaseConflict("surface lease conflict")
            if status_code == 429 or 500 <= status_code <= 599:
                if safe_to_retry and attempt < attempts - 1:
                    self._sleeper(RETRY_DELAYS[attempt])
                    continue
                raise RetryableError("dashboard temporarily unavailable")
            if status_code < 200 or status_code >= 300:
                raise BlockedError("dashboard response was rejected")
            content_type = str(getattr(response, "headers", {}).get("Content-Type", ""))
            if content_type.split(";", 1)[0].strip().lower() != "application/json":
                raise SchemaError("dashboard response is not JSON")
            try:
                payload = response.json()
            except Exception:
                raise SchemaError("dashboard response JSON is malformed") from None
            if not isinstance(payload, dict):
                raise SchemaError("dashboard response schema is invalid")
            return payload
        raise RetryableError("dashboard retry budget exhausted")

    def pull(self) -> List[Dict[str, Any]]:
        payload = self._request("GET", safe_to_retry=True)
        _require_exact_keys(payload, ("pending", "latest", "count"), "pull response")
        pending = payload["pending"]
        if (
            not isinstance(pending, list)
            or not isinstance(payload["count"], int)
            or isinstance(payload["count"], bool)
            or payload["count"] != len(pending)
            or (payload["latest"] is not None and not isinstance(payload["latest"], dict))
        ):
            raise SchemaError("pull response schema is invalid")
        validated = [validate_queue_item(item) for item in pending]
        if validated and payload["latest"] != pending[0]:
            raise SchemaError("pull latest item is inconsistent")
        if not validated and payload["latest"] is not None:
            raise SchemaError("pull latest item is inconsistent")
        return validated

    def claim(self, slug: str, surface: str) -> ClaimedSurface:
        _validate_surface_arguments(slug, surface)
        payload = self._request(
            "POST",
            {
                "action": "claim",
                "slug": slug,
                "surface": surface,
                "workerId": self.worker_id,
            },
            safe_to_retry=False,
        )
        _require_exact_keys(payload, ("ok", "item", "leaseToken"), "claim response")
        if payload["ok"] is not True:
            raise SchemaError("claim was not acknowledged")
        item = validate_queue_item(payload["item"])
        lease_token = payload["leaseToken"]
        if not isinstance(lease_token, str) or len(lease_token) < 12 or len(lease_token) > 512:
            raise SchemaError("claim lease token is invalid")
        if item["slug"] != slug or _surface_status(item, surface) != "claimed":
            raise SchemaError("claim response does not match request")
        return ClaimedSurface(item=item, surface=surface, lease_token=lease_token)

    def complete(
        self,
        slug: str,
        surface: str,
        status: str,
        proof: Dict[str, Any],
        lease_token: str,
        error: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        _validate_surface_arguments(slug, surface)
        allowed = {"posted", "indeterminate", "retryable_failure"}
        if surface == "update":
            allowed.add("pending_review")
        if status not in allowed:
            raise SchemaError("completion status is invalid")
        if not isinstance(proof, dict) or not isinstance(lease_token, str) or not lease_token:
            raise SchemaError("completion proof or lease is invalid")
        if error is not None and not isinstance(error, dict):
            raise SchemaError("completion error is invalid")
        payload = self._request(
            "POST",
            {
                "action": "complete",
                "slug": slug,
                "surface": surface,
                "status": status,
                "proof": proof,
                "leaseToken": lease_token,
                "error": error,
            },
            safe_to_retry=False,
        )
        _require_exact_keys(payload, ("ok", "item"), "complete response")
        if payload["ok"] is not True:
            raise SchemaError("completion was not acknowledged")
        return validate_queue_item(payload["item"])

    def heartbeat(self) -> Dict[str, Any]:
        payload = self._request(
            "POST",
            {
                "action": "heartbeat",
                "workerId": self.worker_id,
                "version": WORKER_VERSION,
            },
            safe_to_retry=True,
        )
        _require_exact_keys(payload, ("ok", "heartbeat"), "heartbeat response")
        heartbeat = payload["heartbeat"]
        if payload["ok"] is not True or not isinstance(heartbeat, dict):
            raise SchemaError("heartbeat response is invalid")
        if set(heartbeat) != {"workerId", "version", "seenAt"}:
            raise SchemaError("heartbeat fields are invalid")
        if heartbeat["workerId"] != self.worker_id or heartbeat["version"] != WORKER_VERSION:
            raise SchemaError("heartbeat identity is invalid")
        if not isinstance(heartbeat["seenAt"], str) or not heartbeat["seenAt"]:
            raise SchemaError("heartbeat timestamp is invalid")
        return heartbeat


def create_client(config: WorkerConfig) -> DashboardQueueClient:
    return DashboardQueueClient(
        api_base=config.api_base,
        worker_id=config.worker_id,
        secret_file=config.secret_file,
    )


def _validate_surface_arguments(slug: str, surface: str) -> None:
    if not isinstance(slug, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", slug):
        raise SchemaError("slug is invalid")
    if surface not in SURFACES:
        raise SchemaError("surface is invalid")


def validate_image_url(url: str) -> None:
    if not isinstance(url, str):
        raise SecurityError("image URL is invalid")
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in ALLOWED_IMAGE_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port not in (None, 443)
        or not parsed.path.startswith("/")
        or parsed.fragment
    ):
        raise SecurityError("image URL is not allowed")


def prepare_google_upload(source: Path, destination: Path) -> Path:
    previous_limit = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source) as image:
                if image.format != "WEBP":
                    raise SecurityError("bound image format is invalid")
                width, height = image.size
                if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                    raise SecurityError("bound image dimensions are invalid")
                image.load()
                normalized = image.convert("RGB")
                normalized.save(
                    destination,
                    format="JPEG",
                    quality=92,
                    optimize=True,
                    progressive=False,
                )
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise SecurityError("bound image dimensions are unsafe") from exc
    except SecurityError:
        raise
    except Exception as exc:
        raise SecurityError("bound image could not be decoded") from exc
    finally:
        Image.MAX_IMAGE_PIXELS = previous_limit
    try:
        with Image.open(destination) as result:
            if result.format != "JPEG" or result.mode != "RGB":
                raise SecurityError("Google upload image is invalid")
            result.verify()
    except SecurityError:
        raise
    except Exception as exc:
        raise SecurityError("Google upload image verification failed") from exc
    return destination


def download_bound_image(
    item: Mapping[str, Any],
    session: Any = requests,
    temp_root: Optional[Path] = None,
) -> DownloadedImage:
    validate_queue_item(dict(item))
    image_url = item["image_url"]
    validate_image_url(image_url)
    root = Path(temp_root) if temp_root is not None else Path(tempfile.gettempdir())
    root.mkdir(parents=True, exist_ok=True)
    run_dir = root / ("gbp-" + uuid.uuid4().hex)
    run_dir.mkdir(mode=0o700)
    source_path = run_dir / "source.webp"
    upload_path = run_dir / "upload.jpg"
    response = None
    try:
        try:
            response = session.get(
                image_url,
                stream=True,
                timeout=REQUEST_TIMEOUT,
                allow_redirects=False,
                headers={"Accept": "image/webp", "User-Agent": "themountingman-gbp-worker/" + WORKER_VERSION},
            )
        except Exception:
            raise RetryableError("bound image download failed") from None
        status_code = getattr(response, "status_code", 0)
        if status_code in (301, 302, 303, 307, 308):
            raise SecurityError("bound image redirect refused")
        if status_code != 200:
            if status_code in (401, 403):
                raise BlockedError("bound image access blocked")
            if status_code == 429 or 500 <= status_code <= 599:
                raise RetryableError("bound image temporarily unavailable")
            raise SecurityError("bound image response rejected")
        headers = getattr(response, "headers", {})
        content_type = str(headers.get("Content-Type", "")).split(";", 1)[0].strip().lower()
        if content_type != "image/webp":
            raise SecurityError("bound image content type is invalid")
        raw_length = str(headers.get("Content-Length", "")).strip()
        if raw_length:
            try:
                declared_length = int(raw_length)
            except ValueError:
                raise SecurityError("bound image content length is invalid") from None
            if declared_length < 1 or declared_length > MAX_IMAGE_BYTES:
                raise SecurityError("bound image is too large")
        digest = hashlib.sha256()
        byte_count = 0
        prefix = b""
        with source_path.open("xb") as handle:
            for chunk in response.iter_content(chunk_size=64 * 1024):
                if not isinstance(chunk, bytes):
                    raise SecurityError("bound image stream is invalid")
                if not chunk:
                    continue
                byte_count += len(chunk)
                if byte_count > MAX_IMAGE_BYTES:
                    raise SecurityError("bound image is too large")
                if len(prefix) < 12:
                    prefix += chunk[: 12 - len(prefix)]
                digest.update(chunk)
                handle.write(chunk)
        if byte_count == 0:
            raise SecurityError("bound image is empty")
        if len(prefix) < 12 or prefix[:4] != b"RIFF" or prefix[8:12] != b"WEBP":
            raise SecurityError("bound image magic is invalid")
        source_sha256 = digest.hexdigest()
        if source_sha256 != item["image_sha256"]:
            raise SecurityError("bound image hash does not match queue")
        prepare_google_upload(source_path, upload_path)
        return DownloadedImage(
            source_path=source_path,
            upload_path=upload_path,
            source_sha256=source_sha256,
            content_type=content_type,
            bytes=byte_count,
        )
    except Exception:
        shutil.rmtree(str(run_dir), ignore_errors=True)
        raise
    finally:
        if response is not None:
            close = getattr(response, "close", None)
            if callable(close):
                close()


def validate_remote_image(item: Mapping[str, Any]) -> None:
    downloaded = download_bound_image(item)
    downloaded.cleanup()


def next_missing_surface(item: Mapping[str, Any]) -> Optional[str]:
    validate_queue_item(dict(item))
    update_status = _surface_status(item, "update")
    photos_status = _surface_status(item, "photos")
    if update_status in {"pending", "retryable_failure", "indeterminate"}:
        return "update"
    if update_status == "claimed":
        raise SchemaError("claimed update cannot be selected")
    if update_status not in {"posted", "pending_review"}:
        raise SchemaError("update state cannot advance")
    if photos_status in {"pending", "retryable_failure", "indeterminate"}:
        return "photos"
    if photos_status == "claimed":
        raise SchemaError("claimed photos cannot be selected")
    if photos_status == "posted":
        return None
    raise SchemaError("photos state cannot advance")


def requires_reconciliation(item: Mapping[str, Any], surface: str) -> bool:
    _validate_surface_arguments(str(item.get("slug", "")), surface)
    return _surface_status(item, surface) == "indeterminate"


def classify_update_evidence(evidence: Mapping[str, Any]) -> str:
    preconditions = (
        evidence.get("account_verified") is True,
        evidence.get("location_verified") is True,
        evidence.get("caption_exact") is True,
        evidence.get("bound_image_preview_visible") is True,
        evidence.get("cta_type") == "LEARN_MORE",
        evidence.get("cta_url_exact") is True,
    )
    if not all(preconditions) or evidence.get("submission_clicked") is not True:
        return "retryable_failure"
    if evidence.get("failure_toast") is True:
        return "indeterminate"
    if evidence.get("timed_out_after_click") is True:
        return "indeterminate"
    if evidence.get("matching_pending_card") is True:
        return "pending_review"
    if evidence.get("matching_published_card") is True:
        return "posted"
    if evidence.get("explicit_success_receipt") is True:
        return "posted"
    return "indeterminate"


def classify_photos_evidence(evidence: Mapping[str, Any]) -> str:
    if evidence.get("reconciliation_only") is True:
        if (
            evidence.get("matching_gallery_item") is True
            and evidence.get("unrelated_image_only") is not True
        ):
            return "posted"
        return "indeterminate"
    if (
        evidence.get("account_verified") is not True
        or evidence.get("location_verified") is not True
        or evidence.get("bound_image_preview_visible") is not True
        or evidence.get("upload_triggered") is not True
    ):
        return "retryable_failure"
    if (
        evidence.get("failure_toast") is True
        or evidence.get("blank_dialog_after_upload") is True
        or evidence.get("timed_out_after_upload") is True
        or evidence.get("gallery_item_pending") is True
    ):
        return "indeterminate"
    if evidence.get("matching_gallery_item") is True and evidence.get("unrelated_image_only") is not True:
        return "posted"
    return "indeterminate"


def classify_session_file_shape(path: Path) -> Dict[str, object]:
    path = Path(path)
    try:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            raise ValueError
        if stat.S_IMODE(info.st_mode) & 0o077:
            raise ValueError
        payload = json.loads(path.read_text(encoding="utf-8"))
        cookies = payload.get("cookies")
        origins = payload.get("origins")
        if not isinstance(cookies, list) or not isinstance(origins, list):
            raise ValueError
        for cookie in cookies:
            if not isinstance(cookie, dict) or not all(
                isinstance(cookie.get(key), str) for key in ("name", "domain", "path")
            ):
                raise ValueError
        for origin in origins:
            if not isinstance(origin, dict) or not isinstance(origin.get("origin"), str):
                raise ValueError
        return {"valid": True, "cookie_count": len(cookies), "origin_count": len(origins)}
    except Exception:
        return {"valid": False, "cookie_count": 0, "origin_count": 0}


def is_login_wall(url: str, visible_text: str) -> bool:
    del visible_text
    try:
        parsed = urlsplit(url)
    except Exception:
        return True
    return parsed.scheme == "https" and parsed.hostname == "accounts.google.com"


def verify_expected_account(page: Any) -> bool:
    try:
        controls = page.locator('button[aria-label^="Google Account:"]')
        count = controls.count()
        if count != 1:
            return False
        label = controls.nth(0).get_attribute("aria-label")
        if not isinstance(label, str):
            return False
        addresses = re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", label)
        return addresses == [EXPECTED_ACCOUNT]
    except Exception:
        return False


def _surface_url(surface: str, add: bool = True) -> str:
    if surface not in SURFACES:
        raise SchemaError("surface is invalid")
    suffix = "updates" if surface == "update" else "photos"
    path = "/local/business/{}/promote/{}".format(EXPECTED_LOCATION_ID, suffix)
    if add:
        path += "/add"
    return "https://www.google.com" + path


def _url_matches_surface(url: str, surface: str, allow_list: bool = False) -> bool:
    parsed = urlsplit(url)
    expected = urlsplit(_surface_url(surface, add=not allow_list))
    return (
        parsed.scheme == "https"
        and parsed.hostname == "www.google.com"
        and parsed.path == expected.path
        and not parsed.fragment
    )


def verify_expected_location(page: Any, surface: str, allow_list: bool = False) -> bool:
    try:
        if not _url_matches_surface(str(page.url), surface, allow_list=allow_list):
            return False
        business = page.get_by_role("heading", name=EXPECTED_BUSINESS_NAME, exact=True)
        return business.count() == 1 and business.is_visible()
    except Exception:
        return False


def _surface_ui_visible(page: Any, surface: str) -> bool:
    names = (
        ("Add update", "Create post")
        if surface == "update"
        else ("Add photos", "Upload photos")
    )
    try:
        count = 0
        for name in names:
            locator = page.get_by_role("heading", name=name, exact=True)
            if locator.count() == 1 and locator.is_visible():
                count += 1
        return count == 1
    except Exception:
        return False


def launch_browser(playwright: Any, config: WorkerConfig) -> Any:
    browser = playwright.chromium.launch(channel="chrome", headless=not config.headed)
    context = browser.new_context(
        storage_state=str(config.storage_state_path),
        locale="en-US",
        viewport={"width": 1440, "height": 1000},
    )
    context.set_default_timeout(30_000)
    return browser, context


@contextlib.contextmanager
def _browser_page(config: WorkerConfig):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as playwright:
        browser = None
        context = None
        try:
            browser, context = launch_browser(playwright, config)
            page = context.new_page()
            yield page
        finally:
            if context is not None:
                context.close()
            if browser is not None:
                browser.close()


def _session_evidence(page: Any, surface: str) -> SessionEvidence:
    account = verify_expected_account(page)
    location = verify_expected_location(page, surface)
    ui = _surface_ui_visible(page, surface)
    return SessionEvidence(account, location, ui, surface)


def check_session(config: WorkerConfig, surface: str = "update") -> SessionEvidence:
    shape = classify_session_file_shape(config.storage_state_path)
    if shape["valid"] is not True:
        raise BlockedError("browser session file is invalid")
    with _browser_page(config) as page:
        page.goto(_surface_url(surface), wait_until="domcontentloaded")
        if is_login_wall(str(page.url), ""):
            raise BlockedError("browser session requires sign in")
        evidence = _session_evidence(page, surface)
        if not evidence.ok:
            raise BlockedError("browser session evidence failed")
        return evidence


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def masked_screenshot(
    page: Any,
    artifact_id: str,
    artifact_dir: Path,
    locators: Sequence[Any] = (),
) -> ScreenshotProof:
    if not OPAQUE_ID_RE.fullmatch(artifact_id):
        raise SecurityError("artifact id is invalid")
    artifact_dir = Path(artifact_dir)
    artifact_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = artifact_dir / (artifact_id + ".png")
    image_bytes = page.screenshot(path=str(path), mask=list(locators), animations="disabled")
    if not isinstance(image_bytes, bytes):
        image_bytes = path.read_bytes()
    os.chmod(path, 0o600)
    return ScreenshotProof(
        artifact_id=artifact_id,
        sha256=hashlib.sha256(image_bytes).hexdigest(),
        captured_at=_timestamp(),
    )


def _active_dialog(page: Any, surface: str) -> Any:
    name = "Add update" if surface == "update" else "Add photos"
    dialog = page.get_by_role("dialog", name=name, exact=True)
    if dialog.count() != 1 or not dialog.is_visible():
        raise RetryableError("expected surface dialog is unavailable")
    return dialog


def _set_scoped_image(dialog: Any, upload_path: Path) -> Any:
    chooser_button = dialog.get_by_role("button", name="Add photos", exact=True)
    if chooser_button.count() != 1:
        chooser_button = dialog.get_by_role("button", name="Choose photos", exact=True)
    if chooser_button.count() != 1:
        raise RetryableError("scoped image chooser is unavailable")
    page = dialog.page
    with page.expect_file_chooser() as chooser_info:
        chooser_button.click()
    chooser_info.value.set_files(str(upload_path))
    preview = dialog.locator('img[data-source="selected-upload"]')
    return preview


def fill_update_form(page: Any, item: Mapping[str, Any], image: DownloadedImage) -> Dict[str, Any]:
    dialog = _active_dialog(page, "update")
    caption = dialog.get_by_role("textbox", name="Post description", exact=True)
    if caption.count() != 1:
        raise RetryableError("post description control is unavailable")
    caption.fill(item["caption"])
    preview = _set_scoped_image(dialog, image.upload_path)
    button_menu = dialog.get_by_role("combobox", name="Add a button", exact=True)
    if button_menu.count() != 1:
        raise RetryableError("CTA selector is unavailable")
    button_menu.select_option(label="Learn more")
    cta = dialog.get_by_role("textbox", name="Link for your button", exact=True)
    if cta.count() != 1:
        raise RetryableError("CTA URL control is unavailable")
    cta.fill(item["cta_url"])
    return {
        "account_verified": verify_expected_account(page),
        "location_verified": verify_expected_location(page, "update"),
        "caption_exact": caption.input_value() == item["caption"],
        "bound_image_preview_visible": preview.count() == 1 and preview.is_visible(),
        "cta_type": "LEARN_MORE" if button_menu.input_value() == "LEARN_MORE" else "",
        "cta_url_exact": cta.input_value() == item["cta_url"],
        "submission_clicked": False,
        "_mask": (caption, cta, preview, page.locator('button[aria-label^="Google Account:"]')),
    }


def _has_failure_alert(page: Any) -> bool:
    try:
        alert = page.get_by_role("alert", name="Could not publish", exact=True)
        return alert.count() == 1 and alert.is_visible()
    except Exception:
        return False


def reconcile_update(page: Any, item: Mapping[str, Any]) -> Dict[str, Any]:
    page.goto(_surface_url("update", add=False), wait_until="domcontentloaded")
    evidence: Dict[str, Any] = {
        "account_verified": verify_expected_account(page),
        "location_verified": verify_expected_location(page, "update", allow_list=True),
        "matching_pending_card": False,
        "matching_published_card": False,
        "explicit_success_receipt": False,
        "failure_toast": _has_failure_alert(page),
    }
    try:
        card = page.get_by_role("article", name=item["caption"], exact=True)
        if card.count() == 1 and card.is_visible():
            pending = card.get_by_text("Pending", exact=True)
            review = card.get_by_text("In review", exact=True)
            evidence["matching_pending_card"] = (
                (pending.count() == 1 and pending.is_visible())
                or (review.count() == 1 and review.is_visible())
            )
            evidence["matching_published_card"] = not evidence["matching_pending_card"]
    except Exception:
        pass
    return evidence


def submit_update(page: Any, item: Mapping[str, Any], evidence: Dict[str, Any]) -> Dict[str, Any]:
    pre_status = classify_update_evidence(dict(evidence, submission_clicked=False))
    if pre_status != "retryable_failure":
        raise WorkerError("unexpected pre-submit classification")
    required = (
        evidence.get("account_verified") is True,
        evidence.get("location_verified") is True,
        evidence.get("caption_exact") is True,
        evidence.get("bound_image_preview_visible") is True,
        evidence.get("cta_type") == "LEARN_MORE",
        evidence.get("cta_url_exact") is True,
    )
    if not all(required):
        return dict(evidence, submission_clicked=False)
    dialog = _active_dialog(page, "update")
    submit = dialog.get_by_role("button", name="Post", exact=True)
    if submit.count() != 1 or not submit.is_enabled():
        return dict(evidence, submission_clicked=False)
    result = dict(evidence, submission_clicked=True)
    try:
        submit.click()
        reconciled = reconcile_update(page, item)
        result.update(reconciled)
    except Exception:
        result["timed_out_after_click"] = True
    return result


def _photo_preview(page: Any, image: DownloadedImage) -> Any:
    dialog = _active_dialog(page, "photos")
    return _set_scoped_image(dialog, image.upload_path)


def reconcile_photos(
    page: Any,
    item: Mapping[str, Any],
    image: DownloadedImage,
    submitted_this_run: bool = False,
) -> Dict[str, Any]:
    del item, image
    page.goto(_surface_url("photos", add=False), wait_until="domcontentloaded")
    evidence: Dict[str, Any] = {
        "account_verified": verify_expected_account(page),
        "location_verified": verify_expected_location(page, "photos", allow_list=True),
        "matching_gallery_item": False,
        "gallery_item_pending": False,
        "failure_toast": _has_failure_alert(page),
        "unrelated_image_only": False,
        "reconciliation_only": not submitted_this_run,
    }
    try:
        if submitted_this_run:
            receipt = page.get_by_role("status", name="Photo uploaded", exact=True)
            evidence["matching_gallery_item"] = receipt.count() == 1 and receipt.is_visible()
        pending = page.get_by_role("status", name="Photo pending", exact=True)
        evidence["gallery_item_pending"] = pending.count() == 1 and pending.is_visible()
    except Exception:
        pass
    return evidence


def upload_photo(page: Any, item: Mapping[str, Any], image: DownloadedImage) -> Dict[str, Any]:
    preview = _photo_preview(page, image)
    evidence: Dict[str, Any] = {
        "account_verified": verify_expected_account(page),
        "location_verified": verify_expected_location(page, "photos"),
        "bound_image_preview_visible": preview.count() == 1 and preview.is_visible(),
        "upload_triggered": False,
        "_mask": (preview, page.locator('button[aria-label^="Google Account:"]')),
    }
    if not all(
        (
            evidence["account_verified"],
            evidence["location_verified"],
            evidence["bound_image_preview_visible"],
        )
    ):
        return evidence
    dialog = _active_dialog(page, "photos")
    upload = dialog.get_by_role("button", name="Upload", exact=True)
    if upload.count() != 1 or not upload.is_enabled():
        return evidence
    evidence["upload_triggered"] = True
    try:
        upload.click()
        evidence.update(reconcile_photos(page, item, image, submitted_this_run=True))
    except Exception:
        evidence["timed_out_after_upload"] = True
    return evidence


def _durable_proof(
    evidence: Mapping[str, Any], screenshot: ScreenshotProof
) -> Dict[str, Any]:
    return {
        "account_verified": evidence.get("account_verified") is True,
        "location_verified": evidence.get("location_verified") is True,
        "surface_verified": (
            evidence.get("account_verified") is True
            and evidence.get("location_verified") is True
        ),
        "caption_exact": evidence.get("caption_exact") is True,
        "bound_image_preview_visible": evidence.get("bound_image_preview_visible") is True,
        "cta_verified": (
            evidence.get("cta_type") == "LEARN_MORE"
            and evidence.get("cta_url_exact") is True
        ),
        "matching_card": (
            evidence.get("matching_published_card") is True
            or evidence.get("matching_gallery_item") is True
        ),
        "pending_review": (
            evidence.get("matching_pending_card") is True
            or evidence.get("gallery_item_pending") is True
        ),
        "gallery_confirmed": evidence.get("matching_gallery_item") is True,
        "worker_version": WORKER_VERSION,
        "observed_at": screenshot.captured_at,
        "artifact_id": screenshot.artifact_id,
        "screenshot_sha256": screenshot.sha256,
    }


def _safe_completion_error(status_value: str) -> Optional[Dict[str, str]]:
    if status_value == "posted" or status_value == "pending_review":
        return None
    return {"code": "surface_" + status_value}


def process_surface(
    client: DashboardQueueClient,
    item: Dict[str, Any],
    surface: str,
    config: WorkerConfig,
) -> Dict[str, Any]:
    reconcile_only = requires_reconciliation(item, surface)
    downloaded: Optional[DownloadedImage] = None
    claim: Optional[ClaimedSurface] = None
    with _browser_page(config) as page:
        page.goto(_surface_url(surface), wait_until="domcontentloaded")
        if is_login_wall(str(page.url), ""):
            raise BlockedError("browser session requires sign in")
        preflight = _session_evidence(page, surface)
        if not preflight.ok:
            raise BlockedError("browser preflight evidence failed")
        claim = client.claim(item["slug"], surface)
        downloaded = download_bound_image(claim.item)
        try:
            if not _session_evidence(page, surface).ok:
                raise BlockedError("browser evidence changed after claim")
            if reconcile_only:
                if surface == "update":
                    evidence = reconcile_update(page, claim.item)
                    evidence.update(
                        {
                            "caption_exact": True,
                            "bound_image_preview_visible": True,
                            "cta_type": "LEARN_MORE",
                            "cta_url_exact": True,
                            "submission_clicked": True,
                        }
                    )
                    status_value = classify_update_evidence(evidence)
                else:
                    evidence = reconcile_photos(page, claim.item, downloaded)
                    status_value = classify_photos_evidence(evidence)
            elif surface == "update":
                evidence = fill_update_form(page, claim.item, downloaded)
                evidence = submit_update(page, claim.item, evidence)
                status_value = classify_update_evidence(evidence)
            else:
                evidence = upload_photo(page, claim.item, downloaded)
                status_value = classify_photos_evidence(evidence)
            artifact_id = uuid.uuid4().hex[:16]
            mask = evidence.pop("_mask", ())
            screenshot = masked_screenshot(
                page,
                artifact_id,
                artifact_dir=config.artifact_dir,
                locators=mask,
            )
            proof = _durable_proof(evidence, screenshot)
            completed = client.complete(
                claim.item["slug"],
                surface,
                status_value,
                proof,
                claim.lease_token,
                _safe_completion_error(status_value),
            )
            return {"status": status_value, "item": completed, "proof": proof}
        finally:
            downloaded.cleanup()


def _first_actionable(items: Sequence[Dict[str, Any]]) -> Optional[tuple]:
    for item in items:
        selected = next_missing_surface(item)
        if selected is not None:
            return item, selected
    return None


def run_once(config: WorkerConfig, *, dry_run: bool = False) -> int:
    client = create_client(config)
    items = client.pull()
    if not dry_run:
        client.heartbeat()
    selected = _first_actionable(items)
    if selected is None:
        sanitized_log("poll_complete", status="empty", queue_count=0)
        return 0
    item, surface = selected
    if dry_run:
        evidence = check_session(config, surface=surface)
        if not evidence.ok:
            raise BlockedError("dry-run session evidence failed")
        validate_remote_image(item)
        sanitized_log("dry_run_complete", status="validated", surface=surface)
        return 0
    result = process_surface(client, item, surface, config)
    sanitized_log("surface_complete", status=result["status"], surface=surface)
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Remote GBP surface queue adapter")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check-session", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--once", action="store_true")
    display = parser.add_mutually_exclusive_group()
    display.add_argument("--headed", action="store_true")
    display.add_argument("--headless", action="store_true")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parser().parse_args(argv)
    try:
        config = load_config()
        if args.headed:
            config = replace(config, headed=True)
        elif args.headless:
            config = replace(config, headed=False)
        if args.check_session:
            evidence = check_session(config)
            sanitized_log(
                "session_check",
                status="valid" if evidence.ok else "blocked",
                surface=evidence.surface,
            )
            return 0 if evidence.ok else 2
        return run_once(config, dry_run=args.dry_run)
    except LeaseConflict:
        sanitized_log("worker_exit", status="conflict", reason_code="lease_conflict")
        return 0
    except BlockedError:
        sanitized_log("worker_exit", status="blocked", reason_code="blocked")
        return 2
    except RetryableError:
        sanitized_log("worker_exit", status="retryable_failure", reason_code="retryable")
        return 3
    except (ConfigError, SecurityError, SchemaError, IndeterminateError, WorkerError):
        sanitized_log("worker_exit", status="blocked", reason_code="fail_closed")
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
