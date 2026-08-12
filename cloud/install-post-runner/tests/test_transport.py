"""Runner transport contract: canonical signing bytes and callback delivery.

The signature covers a canonical JSON rendering of the body, but the Node
verifier re-serializes the *parsed* body with `JSON.stringify`. Anything the two
serializers disagree about is a silent 401 in production, so the agreement is
tested directly against Node rather than assumed.

Run from `cloud/install-post-runner`:
    python3 -m pytest tests -q
"""

from __future__ import annotations

import json
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

from test_runner import FakeApi, FakeResponse, FakeWebflow, run  # noqa: E402

RUNNER_SECRET = "test-runner-secret"
PATH = "/api/install-post/runner/callback"

# Every value here has burned someone: accents, astral planes, the line/paragraph
# separators, C0 controls, a lone surrogate, and an integral float.
UNICODE_BODIES = [
    pytest.param({"jobId": "job_1", "revision": "abc"}, id="ascii"),
    pytest.param({"message": "Édina café — 65″ over stone"}, id="accents"),
    pytest.param({"message": "install went great \U0001f600\U0001f6e0"}, id="astral"),
    pytest.param({"message": "東京 の テレビ"}, id="cjk"),
    pytest.param({"message": "line\u2028sep and par\u2029sep"}, id="js-line-terminators"),
    pytest.param({"message": "control\u0001char and del\u007f"}, id="controls"),
    pytest.param({"message": "nbsp\u00a0separated"}, id="nbsp"),
    pytest.param({"message": "quote \" backslash \\ tab \t newline \n"}, id="escapes"),
    pytest.param({"message": "lone \ud800 surrogate"}, id="lone-surrogate"),
    pytest.param({"result": {"status": "PUBLISHED", "publicStatus": 200.0}}, id="integral-float"),
    pytest.param(
        {
            "jobId": "job_1",
            "revision": "c" * 64,
            "dispatchId": "d1",
            "result": {
                "status": "BLOCKED",
                "message": "Webflow said « non » for 65″ café install",
                "destinations": [{"name": "website", "status": "BLOCKED", "detail": "não"}],
            },
        },
        id="realistic-callback",
    ),
]


def _node_verify(*, body_canonical: str, signature: str, timestamp: int) -> dict:
    """Ask the real Node verifier whether it agrees with the Python signature."""
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
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
        env={
            **os.environ,
            "SIG_SECRET": RUNNER_SECRET,
            "SIG_PATH": PATH,
            # The wire body is exactly the bytes that were signed.
            "SIG_BODY": body_canonical,
            "SIG_TIMESTAMP": str(timestamp),
            "SIG_SIGNATURE": signature,
        },
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


@pytest.mark.parametrize("body", UNICODE_BODIES)
def test_canonical_body_is_accepted_by_the_node_verifier(body):
    timestamp = 1_700_000_000
    canonical = R.canonical_body(body)
    signature = R.sign_request(
        secret=RUNNER_SECRET, method="POST", path=PATH, body=body, timestamp=timestamp
    )
    assert _node_verify(
        body_canonical=canonical, signature=signature, timestamp=timestamp
    ) == {"ok": True}


@pytest.mark.parametrize("body", UNICODE_BODIES)
def test_canonical_body_is_a_json_stringify_fixed_point(body):
    """`JSON.stringify(JSON.parse(canonical))` must return the canonical bytes."""
    canonical = R.canonical_body(body)
    script = """
const canonical = process.env.CANONICAL;
process.stdout.write(JSON.stringify(JSON.stringify(JSON.parse(canonical)) === canonical));
"""
    completed = subprocess.run(
        ["node", "--input-type=module", "--eval", script],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, "CANONICAL": canonical},
    )
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout == "true", f"canonical form drifts: {canonical!r}"


def test_the_runner_sends_exactly_the_bytes_it_signed():
    api, webflow = FakeApi(), FakeWebflow()
    run(api, webflow)
    assert api.requests, "expected signed requests"
    for request in api.requests:
        assert request["raw"] == R.canonical_body(request["body"])
        assert request["headers"]["Content-Type"] == "application/json"


def test_integer_like_keys_are_refused_rather_than_silently_reordered():
    # JSON.parse hoists array-index keys to the front, so they can never be signed.
    with pytest.raises(ValueError):
        R.canonical_body({"1": "a", "0": "b"})


# ---------------------------------------------------------------------------
# B2 — a callback that never lands must fail the run, not pass silently
# ---------------------------------------------------------------------------


class RefusingApi(FakeApi):
    """Delivers the envelope but rejects or drops the callback."""

    def __init__(self, *, status=500, raises=False):
        super().__init__()
        self.callback_status = status
        self.raises = raises

    def post(self, url, headers=None, json=None, data=None, timeout=None, **kwargs):
        if url.endswith("/api/install-post/runner/callback"):
            if self.raises:
                raise ConnectionError("connection reset by peer")
            return FakeResponse(status_code=self.callback_status, json_data={"error": "boom"})
        return super().post(url, headers=headers, json=json, data=data, timeout=timeout, **kwargs)


def test_a_successful_publish_reports_the_callback_as_delivered():
    api, webflow = FakeApi(), FakeWebflow()
    outcome = R.run(
        job_id="job_aaaa1111bbbb2222",
        revision="c" * 64,
        dispatch_id="dispatch-1",
        api_base="https://dashboard.example.com",
        runner_secret=RUNNER_SECRET,
        http=api,
        webflow=webflow,
        fetch_image=lambda url, timeout=None: FakeResponse(status_code=200, content=b"", url=url),
    )
    assert outcome.callback_delivered is True


@pytest.mark.parametrize("api", [RefusingApi(status=500), RefusingApi(raises=True)])
def test_a_publish_whose_callback_never_lands_is_reported_as_undelivered(api):
    webflow = FakeWebflow()
    outcome = R.run(
        job_id="job_aaaa1111bbbb2222",
        revision="c" * 64,
        dispatch_id="dispatch-1",
        api_base="https://dashboard.example.com",
        runner_secret=RUNNER_SECRET,
        http=api,
        webflow=webflow,
        fetch_image=lambda url, timeout=None: FakeResponse(status_code=200, content=b"", url=url),
    )
    assert outcome.callback_delivered is False


def test_main_exits_nonzero_when_the_callback_cannot_be_delivered(monkeypatch, capsys):
    monkeypatch.setenv("JOB_ID", "job_aaaa1111bbbb2222")
    monkeypatch.setenv("REVISION", "c" * 64)
    monkeypatch.setenv("DISPATCH_ID", "dispatch-1")
    monkeypatch.setenv("INSTALL_POST_API_BASE", "https://dashboard.example.com")
    monkeypatch.setenv("INSTALL_POST_RUNNER_SECRET", RUNNER_SECRET)
    monkeypatch.setenv("WEBFLOW_API_TOKEN", "test-webflow-token")

    published_but_undelivered = R.RunOutcome(
        result={"status": "PUBLISHED", "liveUrl": "https://x/y", "publicStatus": 200},
        callback_delivered=False,
    )
    monkeypatch.setattr(R, "run", lambda **kwargs: published_but_undelivered)
    monkeypatch.setattr(R, "WebflowPublisher", lambda token: object())

    assert R.main() != 0
    assert "callback" in capsys.readouterr().err.lower()


def test_main_requires_a_dispatch_id(monkeypatch, capsys):
    monkeypatch.setenv("JOB_ID", "job_aaaa1111bbbb2222")
    monkeypatch.setenv("REVISION", "c" * 64)
    monkeypatch.setenv("DISPATCH_ID", "")
    monkeypatch.setenv("INSTALL_POST_API_BASE", "https://dashboard.example.com")
    monkeypatch.setenv("INSTALL_POST_RUNNER_SECRET", RUNNER_SECRET)
    monkeypatch.setenv("WEBFLOW_API_TOKEN", "test-webflow-token")

    assert R.main() == 2
    assert "DISPATCH_ID" in capsys.readouterr().err
