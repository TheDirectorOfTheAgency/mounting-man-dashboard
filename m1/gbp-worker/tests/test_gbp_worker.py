import hashlib
import importlib.util
import io
import json
import os
import plistlib
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image


WORKER_DIR = Path(__file__).resolve().parents[1]
WORKER_PATH = WORKER_DIR / "gbp_worker.py"
SPEC = importlib.util.spec_from_file_location("gbp_worker", WORKER_PATH)
gbp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gbp)


def surface(status):
    return {"status": status, "proof": {}, "lastError": None}


def valid_item(**overrides):
    item = {
        "schemaVersion": 2,
        "jobId": "job_188",
        "revision": "b" * 64,
        "slug": "sample-install",
        "queuedAt": "2026-08-30T16:00:00.000Z",
        "caption": "A clean Frame TV installation.",
        "cta_url": "https://www.themountingman.com/installations/sample-install",
        "image_url": "https://cdn.prod.website-files.com/assets/install.webp",
        "image_sha256": "a" * 64,
        "required_surfaces": ["update", "photos"],
        "surfaces": {
            "update": surface("pending"),
            "photos": surface("pending"),
        },
    }
    item.update(overrides)
    return item


class FakeResponse:
    def __init__(self, status=200, payload=None, headers=None, chunks=None, json_error=None):
        self.status_code = status
        self._payload = payload
        self.headers = headers or {"Content-Type": "application/json"}
        self._chunks = chunks or []
        self._json_error = json_error
        self.url = "https://mounting-man-dashboard.vercel.app/api/install-post/gbp"

    def json(self):
        if self._json_error:
            raise self._json_error
        return self._payload

    def iter_content(self, chunk_size=65536):
        del chunk_size
        yield from self._chunks

    def close(self):
        return None


class FakeSession:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []
        self.headers = {}

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.secret_file = Path(self.temp.name) / "worker-secret"
        self.secret = "super-secret-worker-token"
        self.secret_file.write_text(self.secret + "\n", encoding="utf-8")
        self.secret_file.chmod(0o600)

    def tearDown(self):
        self.temp.cleanup()

    def client(self, outcomes, **kwargs):
        session = FakeSession(outcomes)
        client = gbp.DashboardQueueClient(
            api_base="https://mounting-man-dashboard.vercel.app",
            worker_id="m1-gbp-01",
            secret_file=self.secret_file,
            session=session,
            sleeper=kwargs.get("sleeper", lambda _: None),
        )
        return client, session

    def test_secret_file_must_be_regular_mode_0600(self):
        self.secret_file.chmod(0o644)
        with self.assertRaises(gbp.ConfigError):
            gbp.read_worker_secret(self.secret_file)

    def test_secret_file_symlink_is_rejected(self):
        linked = Path(self.temp.name) / "linked"
        linked.symlink_to(self.secret_file)
        with self.assertRaises(gbp.ConfigError):
            gbp.read_worker_secret(linked)

    def test_pull_uses_exact_bearer_json_path_and_refuses_redirects(self):
        payload = {"pending": [valid_item()], "latest": valid_item(), "count": 1}
        client, session = self.client([FakeResponse(payload=payload)])
        result = client.pull()
        self.assertEqual(1, len(result))
        method, url, kwargs = session.calls[0]
        self.assertEqual("GET", method)
        self.assertEqual(
            "https://mounting-man-dashboard.vercel.app/api/install-post/gbp", url
        )
        self.assertEqual("Bearer " + self.secret, kwargs["headers"]["Authorization"])
        self.assertEqual("application/json", kwargs["headers"]["Accept"])
        self.assertFalse(kwargs["allow_redirects"])
        self.assertEqual((5, 30), kwargs["timeout"])

    def test_client_rejects_non_https_base_and_path_confusion(self):
        for base in (
            "http://mounting-man-dashboard.vercel.app",
            "https://mounting-man-dashboard.vercel.app/evil",
            "https://mounting-man-dashboard.vercel.app@evil.example",
        ):
            with self.subTest(base=base), self.assertRaises(gbp.ConfigError):
                gbp.DashboardQueueClient(
                    api_base=base,
                    worker_id="m1-gbp-01",
                    secret_file=self.secret_file,
                    session=FakeSession([]),
                )

    def test_secret_is_redacted_from_repr_errors_and_logs(self):
        client, _ = self.client([RuntimeError(self.secret)])
        self.assertNotIn(self.secret, repr(client))
        with mock.patch("sys.stdout", new_callable=io.StringIO) as output:
            with self.assertRaises(gbp.RetryableError) as caught:
                client.pull()
            gbp.sanitized_log("request_failed", detail=str(caught.exception), secret=self.secret)
        self.assertNotIn(self.secret, str(caught.exception))
        self.assertNotIn(self.secret, output.getvalue())

    def test_reason_codes_accept_only_safe_machine_tokens(self):
        self.assertEqual(
            "session_account_unverified",
            gbp.safe_reason_code(gbp.BlockedError("session_account_unverified"), "blocked"),
        )
        self.assertEqual(
            "blocked",
            gbp.safe_reason_code(gbp.BlockedError(self.secret), "blocked"),
        )

    def test_pull_retries_only_bounded_retryable_statuses(self):
        sleeps = []
        payload = {"pending": [], "latest": None, "count": 0}
        client, session = self.client(
            [
                FakeResponse(status=500, payload={"error": "temporary"}),
                FakeResponse(status=429, payload={"error": "limited"}),
                FakeResponse(payload=payload),
            ],
            sleeper=sleeps.append,
        )
        self.assertEqual([], client.pull())
        self.assertEqual(3, len(session.calls))
        self.assertEqual([1.0, 2.0], sleeps)

    def test_pull_quarantines_one_incompatible_row_without_blocking_valid_work(self):
        legacy = {**valid_item(), "schemaVersion": 1}
        current = valid_item(slug="second-install")
        payload = {"pending": [legacy, current], "latest": legacy, "count": 2}
        client, _ = self.client([FakeResponse(payload=payload)])
        self.assertEqual([current], client.pull())

    def test_auth_failures_are_blocked_without_retry(self):
        for status_code in (401, 403):
            with self.subTest(status=status_code):
                client, session = self.client(
                    [FakeResponse(status=status_code, payload={"error": "no"})]
                )
                with self.assertRaises(gbp.BlockedError):
                    client.pull()
                self.assertEqual(1, len(session.calls))

    def test_claim_payload_and_lease_token_are_strict(self):
        response = {
            "ok": True,
            "item": valid_item(
                surfaces={"update": surface("claimed"), "photos": surface("pending")}
            ),
            "leaseToken": "lease_opaque_123",
        }
        client, session = self.client([FakeResponse(payload=response)])
        claim = client.claim("sample-install", "update")
        self.assertEqual("lease_opaque_123", claim.lease_token)
        body = session.calls[0][2]["json"]
        self.assertEqual(
            {
                "action": "claim",
                "slug": "sample-install",
                "surface": "update",
                "workerId": "m1-gbp-01",
            },
            body,
        )
        self.assertEqual(1, len(session.calls))

    def test_claim_rejects_missing_lease_token(self):
        client, _ = self.client(
            [FakeResponse(payload={"ok": True, "item": valid_item()})]
        )
        with self.assertRaises(gbp.SchemaError):
            client.claim("sample-install", "update")

    def test_claim_conflict_is_not_retried(self):
        client, session = self.client(
            [FakeResponse(status=409, payload={"error": "lease_conflict"})]
        )
        with self.assertRaises(gbp.LeaseConflict):
            client.claim("sample-install", "update")
        self.assertEqual(1, len(session.calls))

    def test_complete_reports_exactly_one_surface_and_lease(self):
        client, session = self.client(
            [FakeResponse(payload={"ok": True, "item": valid_item()})]
        )
        proof = {"account_verified": True, "artifact_id": "abc123"}
        client.complete(
            "sample-install",
            "update",
            "pending_review",
            proof,
            "lease_opaque_123",
        )
        self.assertEqual(
            {
                "action": "complete",
                "slug": "sample-install",
                "surface": "update",
                "status": "pending_review",
                "proof": proof,
                "leaseToken": "lease_opaque_123",
                "error": None,
            },
            session.calls[0][2]["json"],
        )

    def test_heartbeat_contains_worker_version_and_installed_build_sha(self):
        build_sha = "b" * 40
        heartbeat = {
            "workerId": "m1-gbp-01",
            "version": gbp.WORKER_VERSION,
            "buildSha": build_sha,
            "seenAt": "2026-08-30T16:00:00.000Z",
        }
        client, session = self.client(
            [FakeResponse(payload={"ok": True, "heartbeat": heartbeat})]
        )
        with mock.patch.dict(os.environ, {"INSTALL_POST_GBP_BUILD_SHA": build_sha}):
            self.assertEqual(heartbeat, client.heartbeat())
        self.assertEqual(
            {
                "action": "heartbeat",
                "workerId": "m1-gbp-01",
                "version": gbp.WORKER_VERSION,
                "buildSha": build_sha,
            },
            session.calls[0][2]["json"],
        )

    def test_malformed_json_and_pull_envelope_fail_closed(self):
        responses = [
            FakeResponse(json_error=ValueError("not json")),
            FakeResponse(payload={"pending": [], "latest": None, "count": "0"}),
        ]
        for response in responses:
            with self.subTest(response=response):
                client, _ = self.client([response])
                with self.assertRaises(gbp.SchemaError):
                    client.pull()

    def test_item_schema_version_hash_and_surface_status_fail_closed(self):
        bad_items = [
            valid_item(schemaVersion=99),
            valid_item(image_sha256="not-a-hash"),
            valid_item(
                surfaces={"update": surface("mystery"), "photos": surface("pending")}
            ),
            valid_item(
                surfaces={
                    "update": surface("posted"),
                    "photos": surface("pending_review"),
                }
            ),
        ]
        for item in bad_items:
            with self.subTest(item=item), self.assertRaises(gbp.SchemaError):
                gbp.validate_queue_item(item)


class ImageTests(unittest.TestCase):
    @staticmethod
    def webp_bytes(size=(8, 6)):
        output = io.BytesIO()
        Image.new("RGB", size, (24, 48, 72)).save(output, format="WEBP")
        return output.getvalue()

    def item_for(self, data, **overrides):
        return valid_item(image_sha256=hashlib.sha256(data).hexdigest(), **overrides)

    def test_exact_webflow_https_host_is_accepted(self):
        gbp.validate_image_url(
            "https://cdn.prod.website-files.com/a/b/install.webp?version=1"
        )

    def test_unsafe_image_urls_are_rejected(self):
        urls = [
            "http://cdn.prod.website-files.com/a.webp",
            "https://sub.cdn.prod.website-files.com/a.webp",
            "https://user@cdn.prod.website-files.com/a.webp",
            "https://cdn.prod.website-files.com:444/a.webp",
            "https://evil.example/a.webp",
            "https://cdn.prod.website-files.com/a.webp#fragment",
        ]
        for url in urls:
            with self.subTest(url=url), self.assertRaises(gbp.SecurityError):
                gbp.validate_image_url(url)

    def test_webp_is_hash_verified_and_normalized_to_real_jpeg(self):
        data = self.webp_bytes()
        response = FakeResponse(
            headers={"Content-Type": "image/webp", "Content-Length": str(len(data))},
            chunks=[data],
        )
        with tempfile.TemporaryDirectory() as root:
            downloaded = gbp.download_bound_image(
                self.item_for(data), session=FakeSession([response]), temp_root=Path(root)
            )
            self.assertEqual(hashlib.sha256(data).hexdigest(), downloaded.source_sha256)
            self.assertEqual(len(data), downloaded.bytes)
            self.assertEqual(b"\xff\xd8\xff", downloaded.upload_path.read_bytes()[:3])
            with Image.open(downloaded.upload_path) as image:
                self.assertEqual("JPEG", image.format)
                self.assertEqual("RGB", image.mode)
            downloaded.cleanup()
            self.assertFalse(downloaded.source_path.exists())
            self.assertFalse(downloaded.upload_path.exists())

    def test_redirect_content_type_magic_size_hash_and_pixels_fail_closed(self):
        good = self.webp_bytes()
        cases = [
            FakeResponse(status=302, headers={"Location": "https://evil.example/x"}),
            FakeResponse(headers={"Content-Type": "image/jpeg"}, chunks=[good]),
            FakeResponse(headers={"Content-Type": "image/webp"}, chunks=[b"not-webp"]),
            FakeResponse(
                headers={
                    "Content-Type": "image/webp",
                    "Content-Length": str(gbp.MAX_IMAGE_BYTES + 1),
                },
                chunks=[],
            ),
            FakeResponse(
                headers={"Content-Type": "image/webp"},
                chunks=[b"x" * (gbp.MAX_IMAGE_BYTES + 1)],
            ),
        ]
        for index, response in enumerate(cases):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as root:
                with self.assertRaises(gbp.WorkerError):
                    gbp.download_bound_image(
                        self.item_for(good),
                        session=FakeSession([response]),
                        temp_root=Path(root),
                    )
                self.assertEqual([], list(Path(root).iterdir()))

        with tempfile.TemporaryDirectory() as root, self.assertRaises(gbp.SecurityError):
            gbp.download_bound_image(
                valid_item(image_sha256="0" * 64),
                session=FakeSession(
                    [FakeResponse(headers={"Content-Type": "image/webp"}, chunks=[good])]
                ),
                temp_root=Path(root),
            )

    def test_redirects_are_disabled_for_image_request(self):
        data = self.webp_bytes()
        session = FakeSession(
            [FakeResponse(headers={"Content-Type": "image/webp"}, chunks=[data])]
        )
        with tempfile.TemporaryDirectory() as root:
            result = gbp.download_bound_image(
                self.item_for(data), session=session, temp_root=Path(root)
            )
            result.cleanup()
        self.assertFalse(session.calls[0][2]["allow_redirects"])
        self.assertTrue(session.calls[0][2]["stream"])


class StateTests(unittest.TestCase):
    def test_update_precedes_photos(self):
        self.assertEqual("update", gbp.next_missing_surface(valid_item()))

    def test_pending_review_update_permits_photos_without_recreating_update(self):
        item = valid_item(
            surfaces={
                "update": surface("pending_review"),
                "photos": surface("pending"),
            }
        )
        self.assertEqual("photos", gbp.next_missing_surface(item))

    def test_posted_update_and_photos_retry_selects_only_photos(self):
        item = valid_item(
            surfaces={
                "update": surface("posted"),
                "photos": surface("retryable_failure"),
            }
        )
        self.assertEqual("photos", gbp.next_missing_surface(item))

    def test_indeterminate_surface_is_selected_for_reconciliation(self):
        item = valid_item(
            surfaces={
                "update": surface("indeterminate"),
                "photos": surface("pending"),
            }
        )
        self.assertEqual("update", gbp.next_missing_surface(item))
        self.assertTrue(gbp.requires_reconciliation(item, "update"))

    def test_complete_item_has_no_surface(self):
        item = valid_item(
            surfaces={"update": surface("posted"), "photos": surface("posted")}
        )
        self.assertIsNone(gbp.next_missing_surface(item))

    def test_live_claim_is_skipped_but_expired_claim_is_reclaimable(self):
        live = surface("claimed") | {
            "lease": {"workerId": "m1-old", "expiresAt": "2026-08-30T16:05:00.000Z"}
        }
        expired = surface("claimed") | {
            "lease": {"workerId": "m1-old", "expiresAt": "2026-08-30T15:55:00.000Z"}
        }
        self.assertIsNone(
            gbp.next_missing_surface(
                valid_item(surfaces={"update": live, "photos": surface("pending")}),
                now="2026-08-30T16:00:00.000Z",
            )
        )
        self.assertEqual(
            "update",
            gbp.next_missing_surface(
                valid_item(surfaces={"update": expired, "photos": surface("pending")}),
                now="2026-08-30T16:00:00.000Z",
            ),
        )
        with self.assertRaises(gbp.SchemaError):
            gbp.next_missing_surface(
                valid_item(
                    surfaces={"update": surface("mystery"), "photos": surface("pending")}
                )
            )


class EvidenceTests(unittest.TestCase):
    def valid_update(self, **overrides):
        evidence = {
            "account_verified": True,
            "location_verified": True,
            "caption_exact": True,
            "bound_image_preview_visible": True,
            "cta_type": "LEARN_MORE",
            "cta_url_exact": True,
            "submission_clicked": True,
            "matching_pending_card": False,
            "matching_published_card": True,
            "explicit_success_receipt": False,
            "failure_toast": False,
            "timed_out_after_click": False,
            "copy_post_visible": False,
        }
        evidence.update(overrides)
        return evidence

    def test_each_update_precondition_blocks_submission_classification(self):
        missing = [
            "account_verified",
            "location_verified",
            "caption_exact",
            "bound_image_preview_visible",
            "cta_url_exact",
        ]
        for field in missing:
            evidence = self.valid_update(**{field: False})
            with self.subTest(field=field):
                self.assertEqual(
                    "retryable_failure", gbp.classify_update_evidence(evidence)
                )
        self.assertEqual(
            "retryable_failure",
            gbp.classify_update_evidence(self.valid_update(cta_type="CALL_NOW")),
        )

    def test_update_click_needs_final_receipt_not_copy_post_or_url_change(self):
        evidence = self.valid_update(
            matching_published_card=False,
            copy_post_visible=True,
            left_add_url=True,
        )
        self.assertEqual("indeterminate", gbp.classify_update_evidence(evidence))

    def test_reconciliation_cannot_fabricate_update_form_preconditions(self):
        evidence = self.valid_update(
            reconciliation_only=True,
            caption_exact=False,
            bound_image_preview_visible=False,
            cta_url_exact=False,
            matching_published_card=True,
        )
        self.assertEqual("indeterminate", gbp.classify_update_evidence(evidence))

    def test_update_post_click_timeout_is_indeterminate(self):
        evidence = self.valid_update(
            matching_published_card=False, timed_out_after_click=True
        )
        self.assertEqual("indeterminate", gbp.classify_update_evidence(evidence))

    def test_pending_update_card_is_pending_review(self):
        evidence = self.valid_update(
            matching_published_card=False, matching_pending_card=True
        )
        self.assertEqual("pending_review", gbp.classify_update_evidence(evidence))

    def test_pending_card_plus_failure_toast_is_indeterminate(self):
        evidence = self.valid_update(
            matching_published_card=False,
            matching_pending_card=True,
            failure_toast=True,
        )
        self.assertEqual("indeterminate", gbp.classify_update_evidence(evidence))

    def test_matching_published_card_is_posted(self):
        self.assertEqual("posted", gbp.classify_update_evidence(self.valid_update()))

    def valid_photo(self, **overrides):
        evidence = {
            "account_verified": True,
            "location_verified": True,
            "file_selection_attempted": True,
            "upload_triggered": True,
            "matching_gallery_item": True,
            "gallery_item_pending": False,
            "failure_toast": False,
            "timed_out_after_upload": False,
            "unrelated_image_only": False,
        }
        evidence.update(overrides)
        return evidence

    def test_photo_is_retryable_only_before_file_selection_is_attempted(self):
        evidence = self.valid_photo(
            file_selection_attempted=False,
            upload_triggered=False,
            matching_gallery_item=False,
        )
        self.assertEqual("retryable_failure", gbp.classify_photos_evidence(evidence))

    def test_file_selection_blank_dialog_and_unrelated_image_are_not_success(self):
        cases = [
            self.valid_photo(matching_gallery_item=False),
            self.valid_photo(matching_gallery_item=False, blank_dialog_after_upload=True),
            self.valid_photo(matching_gallery_item=False, unrelated_image_only=True),
        ]
        for evidence in cases:
            with self.subTest(evidence=evidence):
                self.assertEqual("indeterminate", gbp.classify_photos_evidence(evidence))

    def test_pending_gallery_tile_is_indeterminate(self):
        self.assertEqual(
            "indeterminate",
            gbp.classify_photos_evidence(self.valid_photo(gallery_item_pending=True)),
        )

    def test_confirmed_matching_gallery_item_is_posted(self):
        self.assertEqual("posted", gbp.classify_photos_evidence(self.valid_photo()))

    def test_reconciliation_never_treats_a_generic_prior_upload_as_exact_image_proof(self):
        evidence = self.valid_photo(
            reconciliation_only=True,
            matching_gallery_item=False,
            upload_triggered=False,
        )
        self.assertEqual("indeterminate", gbp.classify_photos_evidence(evidence))

    def test_reconciliation_settles_only_an_exact_perceptual_gallery_match(self):
        evidence = self.valid_photo(
            reconciliation_only=True,
            matching_gallery_item=True,
            upload_triggered=False,
        )
        self.assertEqual("posted", gbp.classify_photos_evidence(evidence))


class FakeAccountLocator:
    def __init__(self, labels):
        self.labels = labels

    def count(self):
        return len(self.labels)

    def nth(self, index):
        return FakeAccountLocator([self.labels[index]])

    def get_attribute(self, name):
        if name != "aria-label":
            return None
        return self.labels[0]


class FakeAccountPage:
    def __init__(self, labels):
        self.labels = labels
        self.selectors = []

    def locator(self, selector):
        self.selectors.append(selector)
        return FakeAccountLocator(self.labels)


class SessionTests(unittest.TestCase):
    def test_storage_state_shape_never_reads_or_returns_cookie_values(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "state.json"
            secret_cookie = "cookie-secret-mntvmounting@gmail.com"
            path.write_text(
                json.dumps(
                    {
                        "cookies": [
                            {
                                "name": "SID",
                                "value": secret_cookie,
                                "domain": ".google.com",
                                "path": "/",
                            }
                        ],
                        "origins": [
                            {"origin": "https://www.google.com", "localStorage": []}
                        ],
                    }
                ),
                encoding="utf-8",
            )
            path.chmod(0o600)
            result = gbp.classify_session_file_shape(path)
            self.assertEqual({"valid": True, "cookie_count": 1, "origin_count": 1}, result)
            self.assertNotIn(secret_cookie, repr(result))

    def test_exact_single_account_control_is_required(self):
        expected = "Google Account: The Mounting Man (mntvmounting@gmail.com)"
        self.assertTrue(gbp.verify_expected_account(FakeAccountPage([expected])))
        for labels in (
            [],
            ["Google Account: Other (other@example.com)"],
            [expected, expected],
            [expected, "Google Account: Other (other@example.com)"],
        ):
            with self.subTest(labels=labels):
                self.assertFalse(gbp.verify_expected_account(FakeAccountPage(labels)))

    def test_login_wall_requires_exact_google_account_host(self):
        self.assertTrue(
            gbp.is_login_wall("https://accounts.google.com/v3/signin", "Sign in")
        )
        self.assertFalse(
            gbp.is_login_wall("https://evil.example/?next=accounts.google.com", "Sign in")
        )
        self.assertFalse(
            gbp.is_login_wall(
                "https://www.google.com/local/business/15921702740686840375/promote/updates/add",
                "Add update",
            )
        )

    def test_masked_screenshot_passes_sensitive_locators_and_returns_digest_only(self):
        class Page:
            def __init__(self):
                self.kwargs = None

            def screenshot(self, **kwargs):
                self.kwargs = kwargs
                Path(kwargs["path"]).write_bytes(b"safe-image-bytes")
                return b"safe-image-bytes"

        page = Page()
        with tempfile.TemporaryDirectory() as root:
            proof = gbp.masked_screenshot(
                page,
                "a1b2c3d4",
                artifact_dir=Path(root),
                locators=("account", "caption", "cta", "preview"),
            )
            self.assertEqual(
                ("account", "caption", "cta", "preview"),
                tuple(page.kwargs["mask"]),
            )
            self.assertEqual("a1b2c3d4", proof.artifact_id)
            self.assertEqual(64, len(proof.sha256))
            self.assertNotIn(str(root), repr(proof))


class GalleryEvidenceTests(unittest.TestCase):
    def test_perceptual_match_accepts_recompression_and_center_crop_only(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "source.jpg"
            related = io.BytesIO()
            unrelated = io.BytesIO()
            patterned = Image.new("RGB", (800, 600))
            pixels = patterned.load()
            self.assertIsNotNone(pixels)
            for y in range(600):
                for x in range(800):
                    pixels[x, y] = (
                        (x * 7) % 256,
                        (y * 11) % 256,
                        ((x + y) * 13) % 256,
                    )
            patterned.save(source, format="JPEG", quality=95)
            patterned.crop((100, 0, 700, 600)).resize((281, 281)).save(
                related, format="JPEG", quality=72
            )
            Image.new("RGB", (281, 281), (240, 20, 90)).save(
                unrelated, format="JPEG", quality=90
            )

            self.assertEqual(
                0,
                gbp.matching_gallery_image_index(
                    source, [related.getvalue(), unrelated.getvalue()]
                ),
            )
            self.assertIsNone(
                gbp.matching_gallery_image_index(source, [unrelated.getvalue()])
            )

    def test_upload_photo_baselines_then_selects_once_without_upload_button(self):
        page = mock.Mock()
        image = mock.Mock(upload_path=Path("/safe/upload.jpg"), source_sha256="a" * 64)
        exact = {
            "account_verified": True,
            "location_verified": True,
            "matching_gallery_item": True,
            "gallery_item_pending": False,
            "failure_toast": False,
            "unrelated_image_only": False,
            "reconciliation_only": False,
            "_mask": (),
        }
        with mock.patch.object(
            gbp, "_gallery_source_snapshot", return_value=("existing",), create=True
        ) as baseline, mock.patch.object(
            gbp, "_select_photo_file", return_value=mock.Mock(), create=True
        ) as select, mock.patch.object(
            gbp, "reconcile_photos", return_value=exact
        ) as reconcile:
            result = gbp.upload_photo(
                page, valid_item(), image, account_verified=True
            )
        baseline.assert_called_once_with(page, account_verified=True)
        select.assert_called_once_with(page, image.upload_path)
        reconcile.assert_called_once_with(
            page,
            mock.ANY,
            image,
            account_verified=True,
            submitted_this_run=True,
            baseline_sources=("existing",),
        )
        self.assertTrue(result["file_selection_attempted"])
        self.assertTrue(result["matching_gallery_item"])
        page.get_by_role.assert_not_called()


class ModeTests(unittest.TestCase):
    def config(self, root):
        return gbp.WorkerConfig(
            api_base="https://mounting-man-dashboard.vercel.app",
            worker_id="m1-gbp-01",
            secret_file=Path(root) / "secret",
            storage_state_path=Path(root) / "state.json",
            artifact_dir=Path(root) / "artifacts",
            headed=False,
        )

    def test_dry_run_does_not_heartbeat_claim_complete_or_mutate_ui(self):
        class Client:
            def __init__(self):
                self.calls = []

            def pull(self):
                self.calls.append("pull")
                return [valid_item()]

            def heartbeat(self):
                self.calls.append("heartbeat")

            def claim(self, *args):
                self.calls.append("claim")

            def complete(self, *args):
                self.calls.append("complete")

        with tempfile.TemporaryDirectory() as root:
            client = Client()
            with mock.patch.object(gbp, "create_client", return_value=client), mock.patch.object(
                gbp, "check_session", return_value=gbp.SessionEvidence(True, True, True, "update")
            ) as check, mock.patch.object(gbp, "validate_remote_image", return_value=None):
                result = gbp.run_once(self.config(root), dry_run=True)
        self.assertEqual(0, result)
        self.assertEqual(["pull"], client.calls)
        check.assert_called_once()

    def test_empty_normal_poll_heartbeats_but_does_not_open_browser(self):
        class Client:
            def __init__(self):
                self.calls = []

            def pull(self):
                self.calls.append("pull")
                return []

            def heartbeat(self):
                self.calls.append("heartbeat")
                return {}

        with tempfile.TemporaryDirectory() as root:
            client = Client()
            with mock.patch.object(gbp, "create_client", return_value=client), mock.patch.object(
                gbp, "check_session"
            ) as check:
                self.assertEqual(0, gbp.run_once(self.config(root)))
        self.assertEqual(["pull", "heartbeat"], client.calls)
        check.assert_not_called()

    def test_check_session_mode_does_not_construct_api_client(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
            gbp, "load_config", return_value=self.config(root)
        ), mock.patch.object(
            gbp, "check_session", return_value=gbp.SessionEvidence(True, True, True, "update")
        ) as check, mock.patch.object(gbp, "create_client") as create_client:
            self.assertEqual(0, gbp.main(["--check-session", "--headless"]))
        check.assert_called_once_with(mock.ANY, surface="update")
        create_client.assert_not_called()

    def test_heartbeat_mode_never_pulls_or_opens_browser(self):
        class Client:
            def __init__(self):
                self.calls = []

            def heartbeat(self):
                self.calls.append("heartbeat")
                return {}

            def pull(self):
                raise AssertionError("heartbeat-only mode must not pull")

        with tempfile.TemporaryDirectory() as root:
            client = Client()
            with mock.patch.object(gbp, "create_client", return_value=client), mock.patch.object(
                gbp, "check_session"
            ) as check, mock.patch.object(gbp, "process_surface") as process:
                self.assertEqual(0, gbp.run_heartbeat(self.config(root)))
        self.assertEqual(["heartbeat"], client.calls)
        check.assert_not_called()
        process.assert_not_called()

    def test_one_invocation_processes_at_most_one_surface(self):
        class Client:
            def __init__(self):
                self.calls = []

            def pull(self):
                return [valid_item()]

            def heartbeat(self):
                return {}

        with tempfile.TemporaryDirectory() as root:
            client = Client()
            with mock.patch.object(gbp, "create_client", return_value=client), mock.patch.object(
                gbp, "process_surface", return_value={"status": "posted"}
            ) as process:
                self.assertEqual(0, gbp.run_once(self.config(root)))
        process.assert_called_once()
        self.assertEqual("update", process.call_args.args[2])

    def test_first_actionable_skips_bad_or_live_claimed_rows(self):
        live = surface("claimed") | {
            "lease": {"workerId": "m1-old", "expiresAt": "2999-01-01T00:00:00.000Z"}
        }
        malformed = {**valid_item(), "schemaVersion": 1}
        actionable = valid_item(slug="second-install")
        selected = gbp._first_actionable(
            [
                malformed,
                valid_item(
                    surfaces={"update": live, "photos": surface("pending")}
                ),
                actionable,
            ]
        )
        self.assertEqual("second-install", selected[0]["slug"])
        self.assertEqual("update", selected[1])

    def test_lease_conflict_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(
            gbp, "load_config", return_value=self.config(root)
        ), mock.patch.object(
            gbp, "run_once", side_effect=gbp.LeaseConflict("expired")
        ):
            self.assertNotEqual(0, gbp.main(["--once", "--headless"]))


class SourceGuardTests(unittest.TestCase):
    def test_plist_is_bounded_once_and_has_no_secret_value_or_tmp_executable(self):
        plist_path = WORKER_DIR / "com.themountingman.gbp-worker.plist"
        with plist_path.open("rb") as handle:
            plist = plistlib.load(handle)
        self.assertEqual(900, plist["StartInterval"])
        self.assertFalse(plist["RunAtLoad"])
        self.assertIn("--once", plist["ProgramArguments"])
        text = plist_path.read_text(encoding="utf-8")
        self.assertNotIn("INSTALL_POST_GBP_WORKER_SECRET", text)
        self.assertNotIn(".hermes/tmp", text)
        self.assertNotIn("mntvmounting@gmail.com", text)

    def test_worker_has_no_forbidden_automation_or_local_queue_ownership(self):
        text = WORKER_PATH.read_text(encoding="utf-8").lower()
        forbidden = [
            "reddit",
            "grok",
            "--no-sandbox",
            "navigator.webdriver",
            "pending_files",
            "move_item",
            "discord",
            "gbp_cta_url",
            "nap mutation",
        ]
        for token in forbidden:
            with self.subTest(token=token):
                self.assertNotIn(token, text)

    def test_requirements_are_pinned_and_hash_checked(self):
        lines = (WORKER_DIR / "requirements.txt").read_text(encoding="utf-8").splitlines()
        packages = [line for line in lines if line and not line.startswith(("#", " "))]
        self.assertGreaterEqual(len(packages), 7)
        for line in packages:
            self.assertRegex(line, r"^[a-zA-Z0-9_-]+==[^ ]+ \\$")
        self.assertIn("playwright==1.58.0", "\n".join(lines))
        self.assertIn("requests==2.32.5", "\n".join(lines))
        self.assertIn("pillow==", "\n".join(lines).lower())
        self.assertGreaterEqual("\n".join(lines).count("--hash=sha256:"), len(packages))

    def test_installer_source_does_not_auto_kickstart_or_embed_secret(self):
        installer = (
            WORKER_DIR.parents[1] / "scripts" / "install-gbp-worker-m1.sh"
        ).read_text(encoding="utf-8")
        self.assertIn("--rollback", installer)
        self.assertIn("--check-session", installer)
        self.assertIn("--dry-run", installer)
        self.assertIn("--heartbeat", installer)
        self.assertNotRegex(installer, r"INSTALL_POST_GBP_WORKER_SECRET=['\"]")
        self.assertNotRegex(installer, r"launchctl\s+kickstart(?!.*ALLOW_LIVE_KICKSTART)")


if __name__ == "__main__":
    unittest.main()
