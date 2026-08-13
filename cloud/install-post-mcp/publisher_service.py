#!/usr/bin/env python3
"""VPS-side adapter for the pinned canonical installation-post publisher.

The MCP service passes only opaque job/revision/manifest identities. This
process fetches the approved envelope from Vercel, downloads the already-bound
photo, invokes the copied canonical publisher, and reports sanitized
destination receipts back through the signed callback. It never receives a
customer name, full address, Square payload, or platform credential in its
HTTP request.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import requests

CANONICAL_SHA = "82c310f51098161df35be3658f8e1131e012594c1e5d4e9811e5dd636b0fb7ab"
ENVELOPE_PATH = "/api/install-post/runner/envelope"
CALLBACK_PATH = "/api/install-post/runner/callback"


def js_body(body: dict[str, Any]) -> bytes:
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def signed_headers(*, secret: str, path: str, body: dict[str, Any]) -> dict[str, str]:
    timestamp = str(int(time.time()))
    digest = hashlib.sha256(js_body(body)).hexdigest()
    canonical = f"{timestamp}.POST.{path}.{digest}"
    signature = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return {
        "Content-Type": "application/json",
        "x-install-post-timestamp": timestamp,
        "x-install-post-signature": f"v1={signature}",
    }


def post_signed(api_base: str, path: str, secret: str, body: dict[str, Any]) -> dict[str, Any]:
    response = requests.post(
        f"{api_base.rstrip('/')}{path}",
        headers=signed_headers(secret=secret, path=path, body=body),
        data=js_body(body),
        timeout=60,
    )
    payload = response.json() if response.content else {}
    if not response.ok:
        raise RuntimeError(str(payload.get("error") or "signed_backend_request_failed"))
    return payload


def canonical_adapter():
    sys.path.insert(0, os.environ.get(
        "INSTALL_POST_VPS_ADAPTER_DIR", "/opt/mounting-man-install-post-vps/publisher"
    ))
    from canonical_adapter import CanonicalPublisherAdapter
    scripts = Path(os.environ.get(
        "INSTALL_POST_VPS_CANONICAL_SCRIPTS", "/opt/mounting-man-install-post-vps/scripts"
    ))
    return CanonicalPublisherAdapter(
        scripts_dir=scripts,
        expected_sha256=CANONICAL_SHA,
        location_ids_path=Path(os.environ.get(
            "INSTALL_POST_VPS_LOCATION_IDS", str(scripts.parent / "references" / "location-ids.md")
        )),
    )


def destination_receipts(result: dict[str, Any], seed: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    platforms = result.get("social_platforms") or {}
    gallery = bool(seed.get("gallery-style"))
    definitions = [
        ("website", True, "website"),
        ("facebook", True, "facebook"),
        ("instagram", True, "instagram"),
        ("linkedin", True, "linkedin"),
        ("x", True, "x"),
        ("google_business_profile", True, "gbp"),
        ("reddit_mountingman", True, "reddit_mountingman"),
        ("reddit_samsung_frame_mounting", gallery, "reddit_frame"),
    ]
    receipts: list[dict[str, Any]] = []
    for destination, required, key in definitions:
        if destination == "website":
            status = "VERIFIED" if result.get("status") == "published" and result.get("live_url") else "INDETERMINATE"
            detail = result.get("live_url") or "website publish did not verify"
        else:
            raw = str(platforms.get(key, "")).lower()
            status = {
                "posted": "POSTED",
                "already_posted": "ALREADY_POSTED",
                "queued": "QUEUED",
                "not_gallery": "SKIPPED",
                "skipped": "BLOCKED",
                "error": "TRANSIENT_FAILURE",
            }.get(raw, "INDETERMINATE")
            detail = platforms.get(f"{key}_error") or raw or "no receipt"
        receipts.append({
            "id": destination,
            "name": destination,
            "required": required,
            "status": status,
            "detail": str(detail)[:300],
        })
    success = {"POSTED", "VERIFIED", "ALREADY_POSTED"}
    overall = "PUBLISHED" if all((not item["required"]) or item["status"] in success for item in receipts) else "RETRYABLE_FAILURE"
    return overall, receipts


def publish(body: dict[str, Any]) -> dict[str, Any]:
    api_base = os.environ["INSTALL_POST_VPS_API_BASE"]
    runner_secret = os.environ["INSTALL_POST_VPS_RUNNER_SECRET"]
    job_id = str(body.get("jobId") or "")
    revision = str(body.get("revision") or "")
    dispatch_id = str(body.get("dispatchId") or "")
    if not job_id or not revision or not dispatch_id:
        raise RuntimeError("publisher_identity_required")
    envelope = post_signed(api_base, ENVELOPE_PATH, runner_secret, {
        "jobId": job_id, "revision": revision, "dispatchId": dispatch_id,
    })
    image = envelope.get("image") or {}
    image_url = str(image.get("hostedUrl") or "")
    if not image_url.startswith("https://"):
        raise RuntimeError("approved_image_url_invalid")
    data = requests.get(image_url, timeout=60)
    data.raise_for_status()
    if len(data.content) > 10 * 1024 * 1024:
        raise RuntimeError("approved_image_too_large")
    if hashlib.sha256(data.content).hexdigest() != str(image.get("sha256") or ""):
        raise RuntimeError("approved_image_digest_mismatch")
    with tempfile.TemporaryDirectory(prefix="install-post-") as temp:
        temp_path = Path(temp)
        image_path = temp_path / "installation-photo"
        seed_path = temp_path / "seed.json"
        image_path.write_bytes(data.content)
        seed_path.write_text(json.dumps(envelope.get("seed") or {}, ensure_ascii=False), encoding="utf-8")
        scripts = os.environ.get("INSTALL_POST_VPS_CANONICAL_SCRIPTS", "/opt/install-post/scripts")
        command = [
            os.environ.get("INSTALL_POST_VPS_PUBLISHER_PYTHON", sys.executable),
            str(Path(scripts) / "fast_install_post.py"),
            "--image", str(image_path),
            "--seed-json", str(seed_path),
            "--art-mode", "never",
        ]
        env = os.environ.copy()
        env["Q_CREDENTIALS_DIR"] = os.environ.get("INSTALL_POST_VPS_CREDENTIALS", "/opt/install-post/credentials")
        env["HERMES_INSTALL_POSTS_WORK_DIR"] = os.environ.get("INSTALL_POST_VPS_WORK_DIR", "/opt/install-post/work")
        env["HERMES_INSTALL_POSTS_LOCATION_IDS_PATH"] = os.environ.get(
            "INSTALL_POST_VPS_LOCATION_IDS", f"{scripts}/references/location-ids.md"
        )
        completed = subprocess.run(command, env=env, capture_output=True, text=True, timeout=900)
        lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
        parsed: dict[str, Any] = {}
        for line in reversed(lines):
            try:
                parsed = json.loads(line)
                if isinstance(parsed, dict):
                    break
            except json.JSONDecodeError:
                continue
        if completed.returncode != 0 or not parsed:
            result = {
                "status": "INDETERMINATE",
                "message": "canonical publisher exited without a result",
            }
        else:
            status, receipts = destination_receipts(parsed, envelope.get("seed") or {})
            result = {
                "status": status,
                "liveUrl": parsed.get("live_url"),
                "imageUrl": parsed.get("image_url"),
                "itemId": parsed.get("item_id"),
                "slug": parsed.get("slug"),
                "publicStatus": 200 if parsed.get("live_url") else None,
                "message": "canonical VPS publisher completed",
                "destinations": receipts,
            }
    post_signed(api_base, CALLBACK_PATH, runner_secret, {
        "jobId": job_id, "revision": revision, "dispatchId": dispatch_id, "result": result,
    })
    return {"dispatchId": dispatch_id, "status": result["status"]}


def preview(body: dict[str, Any]) -> dict[str, Any]:
    adapter = canonical_adapter()
    result = adapter.preview(
        body.get("seed") or {},
        live_url="https://preview.invalid/installations/pending",
        image_url="https://preview.invalid/installations/photo.webp",
    )
    return result


def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    body = json.load(sys.stdin)
    if action == "preview":
        result = preview(body)
    elif action == "publish":
        result = publish(body)
    elif action == "retry":
        # Destination-bound retry orchestration remains owned by the dashboard
        # state machine. Never turn a retry request into a full republish.
        raise RuntimeError("destination_retry_not_enabled_on_vps")
    else:
        raise RuntimeError("unsupported_publisher_action")
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
