"""Pure complete-publisher contract for THE-144.

This module deliberately contains no platform clients. It prevents the current
Webflow-only runner or a lossy aggregate from being selected as publish-everywhere.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping


DESTINATIONS = (
    "website",
    "facebook",
    "instagram",
    "linkedin",
    "x",
    "google_business_profile",
    "reddit_mountingman",
    "reddit_samsung_frame_mounting",
)

STATUSES = frozenset({
    "NOT_STARTED",
    "POSTED",
    "VERIFIED",
    "ALREADY_POSTED",
    "QUEUED",
    "SKIPPED",
    "BLOCKED",
    "TRANSIENT_FAILURE",
    "PERMANENT_FAILURE",
    "INDETERMINATE",
})
SUCCESS = frozenset({"POSTED", "VERIFIED", "ALREADY_POSTED"})


class IncompletePublisherError(RuntimeError):
    """The adapter cannot satisfy the complete destination contract."""


@dataclass(frozen=True)
class DestinationReceipt:
    destination: str
    required: bool
    status: str
    receipt_id: str | None = None
    receipt_url: str | None = None


def required_destinations(seed: Mapping[str, object]) -> tuple[str, ...]:
    required = list(DESTINATIONS[:-1])
    if bool(seed.get("gallery-style")):
        required.append("reddit_samsung_frame_mounting")
    return tuple(required)


def assert_complete_adapter(capabilities: Iterable[str]) -> None:
    missing = set(DESTINATIONS) - set(capabilities)
    if missing:
        raise IncompletePublisherError(
            "complete publisher unavailable: missing " + ",".join(sorted(missing))
        )


def destination_result(
    seed: Mapping[str, object],
    raw_receipts: Iterable[Mapping[str, object]],
) -> dict[str, object]:
    required = set(required_destinations(seed))
    by_destination = {str(item.get("destination", "")): item for item in raw_receipts}
    receipts: list[DestinationReceipt] = []
    for destination in DESTINATIONS:
        raw = by_destination.get(destination, {})
        status = str(raw.get("status", "INDETERMINATE")).upper()
        if status not in STATUSES:
            status = "INDETERMINATE"
        is_required = destination in required
        if not is_required and destination == "reddit_samsung_frame_mounting" and not raw:
            status = "SKIPPED"
        receipts.append(DestinationReceipt(
            destination=destination,
            required=is_required,
            status=status,
            receipt_id=str(raw["receipt_id"]) if raw.get("receipt_id") else None,
            receipt_url=str(raw["receipt_url"]) if raw.get("receipt_url") else None,
        ))

    website = next(item for item in receipts if item.destination == "website")
    published = website.status == "VERIFIED" and all(
        item.status in SUCCESS for item in receipts if item.required
    )
    return {
        "overall": "PUBLISHED" if published else "PARTIAL",
        "destinations": [item.__dict__ for item in receipts],
        "retryable_destinations": [
            item.destination for item in receipts
            if item.required and item.status == "TRANSIENT_FAILURE"
        ],
    }
