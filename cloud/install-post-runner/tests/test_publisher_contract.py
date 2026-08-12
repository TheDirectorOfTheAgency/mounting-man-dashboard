import json
from pathlib import Path
import sys

import pytest

RUNNER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNNER_DIR))

from publisher_contract import (
    DESTINATIONS,
    IncompletePublisherError,
    assert_complete_adapter,
    destination_result,
)


def complete_receipts():
    return [
        {"destination": destination, "status": "VERIFIED" if destination == "website" else "POSTED"}
        for destination in DESTINATIONS
    ]


def test_webflow_success_cannot_hide_social_failure():
    receipts = complete_receipts()
    next(item for item in receipts if item["destination"] == "linkedin")["status"] = "TRANSIENT_FAILURE"
    result = destination_result({}, receipts)
    assert result["overall"] == "PARTIAL"
    assert result["retryable_destinations"] == ["linkedin"]


def test_queue_acceptance_is_not_posted_and_gallery_destination_is_conditional():
    receipts = complete_receipts()
    next(item for item in receipts if item["destination"] == "google_business_profile")["status"] = "QUEUED"
    result = destination_result({}, receipts)
    assert result["overall"] == "PARTIAL"
    frame = next(item for item in result["destinations"] if item["destination"] == "reddit_samsung_frame_mounting")
    assert frame["required"] is False

    gallery = destination_result({"gallery-style": True}, receipts)
    frame = next(item for item in gallery["destinations"] if item["destination"] == "reddit_samsung_frame_mounting")
    assert frame["required"] is True


def test_webflow_only_runner_is_rejected_as_publish_everywhere():
    with pytest.raises(IncompletePublisherError, match="google_business_profile"):
        assert_complete_adapter({"website"})
    assert_complete_adapter(DESTINATIONS)


def test_indeterminate_destination_requires_reconciliation_not_blind_retry():
    receipts = complete_receipts()
    next(item for item in receipts if item["destination"] == "x")["status"] = "INDETERMINATE"
    result = destination_result({}, receipts)
    assert result["overall"] == "PARTIAL"
    assert result["retryable_destinations"] == []


def test_unexpected_gallery_receipt_cannot_expand_retry_scope():
    receipts = complete_receipts()
    next(
        item for item in receipts
        if item["destination"] == "reddit_samsung_frame_mounting"
    )["status"] = "TRANSIENT_FAILURE"
    result = destination_result({}, receipts)
    assert result["retryable_destinations"] == []


def test_provenance_is_a_disabled_audit_snapshot():
    path = Path(__file__).parents[1] / "CANONICAL_PUBLISHER_PROVENANCE.json"
    data = json.loads(path.read_text())
    assert data["dispatch_enabled"] is False
    assert data["status"] == "audit_only_unversioned_runtime"
    assert set(data["source"]) == {
        "fast_install_post.py", "content.py", "clients.py", "gbp_worker.py", "reddit_worker.py"
    }
    assert all(len(entry["sha256"]) == 64 for entry in data["source"].values())
