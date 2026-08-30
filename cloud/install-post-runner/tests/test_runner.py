"""Cloud runner tests.

Run from `cloud/install-post-runner`:
    python3 -m pytest tests -q
"""

from __future__ import annotations

import hashlib
import json
import json as _json
import os
import subprocess
import sys
from pathlib import Path

import pytest

RUNNER_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = RUNNER_DIR.parents[1]
sys.path.insert(0, str(RUNNER_DIR))
sys.path.insert(0, str(RUNNER_DIR / "publisher"))

import runner as R  # noqa: E402
from social import SocialPublisher  # noqa: E402
from webflow import BoundAsset, WebflowError  # noqa: E402

API_BASE = "https://dashboard.example.com"
RUNNER_SECRET = "test-runner-secret"
WEBFLOW_TOKEN = "test-webflow-token"

IMAGE_BYTES = b"RIFF\x00\x00\x00\x00WEBP" + b"pixels" * 100
IMAGE_SHA256 = hashlib.sha256(IMAGE_BYTES).hexdigest()

SEED = {
    "city": "Edina",
    "state": "MN",
    "tv-size": '65"',
    "tv-brand": "Samsung",
    "wall-surface": "Stone",
    "fireplace-type": "Stone Fireplace",
    "mount-type": "MantelMount MM540",
    "price": "$450",
    "performed-by": "Michael",
    "street-name": "Elm Street",
    "seed-index": 1,
    "seed-count": 1,
}

JOB_ID = "job_aaaa1111bbbb2222"
REVISION = "c" * 64


def envelope(**overrides):
    base = {
        "jobId": JOB_ID,
        "revision": REVISION,
        "approvedAt": "2026-08-12T15:10:00.000Z",
        "seed": dict(SEED),
        "image": {
            "sha256": IMAGE_SHA256,
            "bytes": len(IMAGE_BYTES),
            "contentType": "image/webp",
            "hostedUrl": "https://cdn.example.com/photo.webp",
            "assetId": "asset-1",
        },
        "artMode": "never",
    }
    base.update(overrides)
    return base


class FakeResponse:
    def __init__(self, *, status_code=200, json_data=None, text="", content=b"", url=""):
        self.status_code = status_code
        self._json = json_data if json_data is not None else {}
        self.text = text
        self.content = content
        self.url = url

    def json(self):
        return self._json


class FakeApi:
    """Stands in for the signed Vercel endpoints."""

    def __init__(self, env=None, envelope_status=200):
        self.env = env if env is not None else envelope()
        self.envelope_status = envelope_status
        self.callbacks = []
        self.requests = []

    def post(self, url, headers=None, json=None, data=None, timeout=None, **kwargs):
        # The runner sends the exact bytes it signed, so the fake decodes the
        # body the same way the real endpoint does.
        raw = data.decode("utf-8") if isinstance(data, (bytes, bytearray)) else data
        body = json if raw is None else _json.loads(raw)
        self.requests.append({"url": url, "headers": headers or {}, "body": body, "raw": raw})
        if url.endswith("/api/install-post/runner/envelope"):
            if self.envelope_status != 200:
                return FakeResponse(status_code=self.envelope_status, json_data={"error": "not_approved"})
            return FakeResponse(json_data=self.env)
        if url.endswith("/api/install-post/runner/callback"):
            self.callbacks.append(body)
            return FakeResponse(json_data={"ok": True})
        raise AssertionError(f"unexpected POST {url}")


class FakeWebflow:
    def __init__(self, *, existing=None, create_error=None, verify_error=None):
        self.existing = existing
        self.create_error = create_error
        self.verify_error = verify_error
        self.created = []
        self.verified = []

    def find_item_by_slug(self, slug):
        return self.existing

    def build_field_data(self, post_data, asset):
        return {"slug": post_data["slug"], "main-image": {"url": asset.hosted_url}}

    def create_live_item(self, post_data, asset):
        if self.create_error:
            raise self.create_error
        self.created.append({"post_data": dict(post_data), "asset": asset})
        return {"id": "item-1", "fieldData": {"slug": post_data["slug"]}}

    def verify_live(self, item_id, slug):
        if self.verify_error:
            raise self.verify_error
        self.verified.append((item_id, slug))
        return {
            "live_url": f"https://www.themountingman.com/installations/{slug}",
            "image_url": "https://cdn.example.com/photo.webp",
            "public_status": 200,
        }


def run(api, webflow, *, image_bytes=IMAGE_BYTES, job_id=JOB_ID, revision=REVISION):
    def fetch_image(url, timeout=None):
        return FakeResponse(status_code=200, content=image_bytes, url=url)

    # These cases are about what was published, not about callback delivery.
    return R.run(
        job_id=job_id,
        revision=revision,
        dispatch_id="dispatch-1",
        api_base=API_BASE,
        runner_secret=RUNNER_SECRET,
        http=api,
        webflow=webflow,
        fetch_image=fetch_image,
    ).result


# ---------------------------------------------------------------------------
# Request signing must match the Node verifier exactly
# ---------------------------------------------------------------------------


def test_signature_matches_the_node_implementation():
    body = {"jobId": JOB_ID, "revision": REVISION}
    timestamp = 1_700_000_000
    path = "/api/install-post/runner/envelope"
    signature = R.sign_request(
        secret=RUNNER_SECRET, method="POST", path=path, body=body, timestamp=timestamp
    )

    script = """
import { verifyRunnerRequest } from './lib/install-post-dispatch.mjs';
const { SIG_SECRET, SIG_PATH, SIG_BODY, SIG_TIMESTAMP, SIG_SIGNATURE } = process.env;
const result = verifyRunnerRequest({
  secret: SIG_SECRET, signature: SIG_SIGNATURE, method: 'POST', path: SIG_PATH,
  body: JSON.parse(SIG_BODY), timestamp: Number(SIG_TIMESTAMP),
  now: Number(SIG_TIMESTAMP) * 1000,
});
process.stdout.write(JSON.stringify(result));
"""
    completed = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        cwd=REPO_ROOT, capture_output=True, text=True, check=False,
        env={
            **os.environ,
            "SIG_SECRET": RUNNER_SECRET,
            "SIG_PATH": path,
            "SIG_BODY": json.dumps(body, separators=(",", ":"), ensure_ascii=False),
            "SIG_TIMESTAMP": str(timestamp),
            "SIG_SIGNATURE": signature,
        },
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(completed.stdout) == {"ok": True}


def test_signed_requests_carry_signature_and_timestamp_headers():
    api, webflow = FakeApi(), FakeWebflow()
    run(api, webflow)
    for request in api.requests:
        assert request["headers"]["x-install-post-signature"].startswith("v1=")
        assert int(request["headers"]["x-install-post-timestamp"]) > 0


# ---------------------------------------------------------------------------
# Envelope binding
# ---------------------------------------------------------------------------


def test_publishes_the_approved_seed_and_reports_the_verified_url():
    api, webflow = FakeApi(), FakeWebflow()
    result = run(api, webflow)

    assert result["status"] == "PUBLISHED"
    assert result["publicStatus"] == 200
    assert result["liveUrl"].startswith("https://www.themountingman.com/installations/")
    assert len(webflow.created) == 1

    published = webflow.created[0]["post_data"]
    assert published["title"]
    assert published["post-body"]
    assert published["slug"] == result["slug"]
    assert webflow.created[0]["asset"].hosted_url == "https://cdn.example.com/photo.webp"

    assert api.callbacks[0]["jobId"] == JOB_ID
    assert api.callbacks[0]["revision"] == REVISION
    assert api.callbacks[0]["result"]["status"] == "PUBLISHED"


def test_house_copy_matches_the_canonical_publisher_for_the_approved_seed():
    api, webflow = FakeApi(), FakeWebflow()
    run(api, webflow)
    published = webflow.created[0]["post_data"]

    canonical_dir = Path(
        "/Users/thedirector/.hermes/skills/business-ops/"
        "mounting-man-installation-posts-hermes/scripts"
    )
    if not canonical_dir.exists():
        pytest.skip("canonical publisher is not present on this machine")

    script = (
        "import json, sys\n"
        "sys.path.insert(0, sys.argv[1])\n"
        "import fast_install_post as F, content as C\n"
        "d = F.normalize_seed_post_data(json.loads(sys.argv[2]))\n"
        "d['nearby-cities'] = F._get_nearby_cities(d.get('city',''))\n"
        "d['location-id'] = str(d.get('location-id') or '') or "
        "F.resolve_location_id(d.get('city',''), type('C',(),{'location_ids_path': F._LOCATION_IDS_PATH})())\n"
        "e = C.enrich_post_data(d, C.load_location_id_city_map(F._LOCATION_IDS_PATH))\n"
        "print(json.dumps({k: e.get(k) for k in ('title','slug','post-summary','post-body')}, sort_keys=True))\n"
    )
    completed = subprocess.run(
        [sys.executable, "-c", script, str(canonical_dir), json.dumps(SEED)],
        capture_output=True, text=True, check=False,
    )
    assert completed.returncode == 0, completed.stderr
    canonical = json.loads(completed.stdout)

    for field in ("title", "slug", "post-summary", "post-body"):
        assert published[field] == canonical[field], f"{field} drifted from the canonical publisher"


def test_refuses_an_envelope_bound_to_a_different_job_or_revision():
    for env in (envelope(jobId="job_other"), envelope(revision="d" * 64)):
        api, webflow = FakeApi(env=env), FakeWebflow()
        result = run(api, webflow)
        assert result["status"] == "BLOCKED"
        assert "does not match" in result["message"]
        assert webflow.created == []


def test_refuses_a_photo_whose_bytes_do_not_match_the_approved_digest():
    api, webflow = FakeApi(), FakeWebflow()
    result = run(api, webflow, image_bytes=b"different bytes entirely")
    assert result["status"] == "BLOCKED"
    assert "digest" in result["message"].lower()
    assert webflow.created == []


def test_an_unapproved_job_is_blocked_without_publishing():
    api, webflow = FakeApi(envelope_status=409), FakeWebflow()
    result = run(api, webflow)
    assert result["status"] == "BLOCKED"
    assert webflow.created == []
    assert api.callbacks[0]["result"]["status"] == "BLOCKED"


# ---------------------------------------------------------------------------
# Idempotency and reconciliation
# ---------------------------------------------------------------------------


def test_an_existing_post_for_the_same_photo_reconciles_instead_of_duplicating():
    existing = {
        "id": "item-existing",
        "fieldData": {"slug": "reused-slug", "main-image": {"url": "https://cdn.example.com/photo.webp"}},
    }
    api, webflow = FakeApi(), FakeWebflow(existing=existing)
    result = run(api, webflow)

    assert result["status"] == "PUBLISHED"
    assert result["itemId"] == "item-existing"
    assert webflow.created == [], "must not create a second item for the same photo"
    assert webflow.verified == [("item-existing", "reused-slug")]


def test_a_slug_collision_with_a_different_photo_creates_its_own_post():
    existing = {
        "id": "item-other",
        "fieldData": {"slug": "taken", "main-image": {"url": "https://cdn.example.com/some-other-photo.webp"}},
    }
    api, webflow = FakeApi(), FakeWebflow(existing=existing)
    result = run(api, webflow)

    assert result["status"] == "PUBLISHED"
    assert len(webflow.created) == 1
    assert webflow.created[0]["post_data"]["slug"] != "taken"


# ---------------------------------------------------------------------------
# Failure classification
# ---------------------------------------------------------------------------


def test_a_dropped_connection_during_create_is_indeterminate_not_failed():
    api = FakeApi()
    webflow = FakeWebflow(create_error=WebflowError("connection reset", indeterminate=True))
    result = run(api, webflow)
    assert result["status"] == "INDETERMINATE"
    assert api.callbacks[0]["result"]["status"] == "INDETERMINATE"


def test_a_rejected_create_is_a_retryable_failure():
    api = FakeApi()
    webflow = FakeWebflow(create_error=WebflowError("Webflow live item create failed with HTTP 503"))
    result = run(api, webflow)
    assert result["status"] == "RETRYABLE_FAILURE"


def test_a_created_item_that_fails_public_read_back_is_indeterminate():
    api = FakeApi()
    webflow = FakeWebflow(verify_error=WebflowError("Unexpected live URL state"))
    result = run(api, webflow)
    assert result["status"] == "INDETERMINATE"
    assert result["itemId"] == "item-1"


# ---------------------------------------------------------------------------
# Output hygiene
# ---------------------------------------------------------------------------


def test_no_secret_or_customer_data_appears_in_the_result_or_callback():
    api, webflow = FakeApi(), FakeWebflow()
    result = run(api, webflow)
    blob = json.dumps([result, api.callbacks])
    for forbidden in (RUNNER_SECRET, WEBFLOW_TOKEN, "4821"):
        assert forbidden not in blob


def test_secrets_are_redacted_out_of_error_messages():
    api = FakeApi()
    webflow = FakeWebflow(
        create_error=WebflowError("rejected: Bearer sk-live-abcdef123456 for jane@example.com")
    )
    result = run(api, webflow)
    assert "sk-live-abcdef123456" not in result["message"]
    assert "jane@example.com" not in result["message"]


def test_result_only_contains_reportable_fields():
    api, webflow = FakeApi(), FakeWebflow()
    result = run(api, webflow)
    assert set(result).issubset(
        {"status", "liveUrl", "imageUrl", "itemId", "slug", "publicStatus", "message", "destinations"}
    )


def test_destinations_report_the_website_outcome_explicitly():
    api, webflow = FakeApi(), FakeWebflow()
    result = run(api, webflow)
    names = {d["name"] for d in result["destinations"]}
    assert "website" in names
    website = next(d for d in result["destinations"] if d["name"] == "website")
    assert website["status"] == "PUBLISHED"


def test_asset_binding_uses_the_approved_asset_id():
    api, webflow = FakeApi(), FakeWebflow()
    run(api, webflow)
    asset = webflow.created[0]["asset"]
    assert isinstance(asset, BoundAsset)
    assert asset.asset_id == "asset-1"


def test_social_run_never_calls_reddit_and_skips_already_posted():
    class RecordingSocial(SocialPublisher):
        def __init__(self):
            super().__init__(env={}, http=None)
            self.seen = []

        def publish(self, **kwargs):
            self.seen.append(kwargs)
            assert "reddit" not in str(kwargs).lower()
            return [
                {"name": "instagram", "status": "PUBLISHED", "detail": "skipped: already posted for slug"},
                {"name": "facebook", "status": "PUBLISHED", "detail": "fb-1"},
                {"name": "linkedin", "status": "SKIPPED", "detail": "credentials unset"},
                {"name": "x", "status": "PUBLISHED", "detail": "https://x.com/MountingManTV/status/1"},
            ]

    api, webflow = FakeApi(), FakeWebflow()
    social = RecordingSocial()
    result = R.run(
        job_id=JOB_ID,
        revision=REVISION,
        dispatch_id="dispatch-1",
        api_base=API_BASE,
        runner_secret=RUNNER_SECRET,
        http=api,
        webflow=webflow,
        fetch_image=lambda url, timeout=None: FakeResponse(status_code=200, content=IMAGE_BYTES, url=url),
        social=social,
    ).result

    names = {entry["name"] for entry in result["destinations"]}
    assert "website" in names
    assert "reddit" not in names
    assert "gbp" not in names
    assert len(social.seen) == 1
    assert "reddit" not in str(result).lower()


def test_wrong_x_account_blocks_x_without_creating_a_second_webflow_item():
    class WrongAccountSocial:
        def publish(self, **kwargs):
            return [{"name": "x", "status": "BLOCKED", "detail": "expected @MountingManTV"}]

    existing = {
        "id": "item-existing",
        "fieldData": {"slug": "reused-slug", "main-image": {"url": "https://cdn.example.com/photo.webp"}},
    }
    api, webflow = FakeApi(), FakeWebflow(existing=existing)
    result = R.run(
        job_id=JOB_ID,
        revision=REVISION,
        dispatch_id="dispatch-1",
        api_base=API_BASE,
        runner_secret=RUNNER_SECRET,
        http=api,
        webflow=webflow,
        fetch_image=lambda url, timeout=None: FakeResponse(status_code=200, content=IMAGE_BYTES, url=url),
        social=WrongAccountSocial(),
    ).result

    assert webflow.created == [], "must not create a second item for the same photo"
    assert result["itemId"] == "item-existing"
    x_dest = next(entry for entry in result["destinations"] if entry["name"] == "x")
    assert x_dest["status"] == "BLOCKED"
    assert "MountingManTV" in x_dest["detail"]
    assert "reddit" not in str(result).lower()


def test_linkedin_share_urn_cannot_be_reported_as_published():
    class ShareSocial:
        def publish(self, **kwargs):
            return [{
                "name": "linkedin",
                "status": "PUBLISHED",
                "detail": "urn:li:share:7499851525402308608",
            }]

    api, webflow = FakeApi(), FakeWebflow()
    result = R.run(
        job_id=JOB_ID,
        revision=REVISION,
        dispatch_id="dispatch-1",
        api_base=API_BASE,
        runner_secret=RUNNER_SECRET,
        http=api,
        webflow=webflow,
        fetch_image=lambda url, timeout=None: FakeResponse(status_code=200, content=IMAGE_BYTES, url=url),
        social=ShareSocial(),
    ).result

    linkedin = next(entry for entry in result["destinations"] if entry["name"] == "linkedin")
    assert linkedin["status"] == "RETRYABLE_FAILURE"
    assert "share" in linkedin["detail"].lower()
    assert "urn:li:ugcPost:" not in linkedin["detail"]
    assert result["status"] == "INDETERMINATE"
