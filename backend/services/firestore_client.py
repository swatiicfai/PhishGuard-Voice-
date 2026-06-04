"""
Firestore Client — Real-Time Threat Event Persistence
======================================================
Wraps Firebase Admin SDK to write structured threat events and session
metadata to Cloud Firestore.

Collection schema
-----------------
calls/
  {session_id}/
    • active        : bool
    • started_at    : timestamp
    • ended_at      : timestamp | null
    • threat_score  : int  (0–100, rolling maximum)
    • total_events  : int
    • caller_profile: map  (claimed org, name, script type…)

    events/
      {event_id}/
        • category        : str
        • severity        : str
        • evidence_snippet: str
        • threat_score_delta: int
        • grounding_query : str | null
        • grounding_result: map | null
        • timestamp       : server timestamp
"""

import logging
import os
from typing import Any

from google.cloud import firestore

logger = logging.getLogger(__name__)

_db: firestore.AsyncClient | None = None


def _get_db() -> firestore.AsyncClient:
    global _db
    if _db is None:
        database_id = os.environ.get("FIRESTORE_DATABASE_ID", "(default)")
        _db = firestore.AsyncClient(database=database_id)
    return _db


# ── Session lifecycle ─────────────────────────────────────────────────────────

async def create_session(session_id: str) -> None:
    """Initialise a new call session document in Firestore."""
    db = _get_db()
    await db.collection("calls").document(session_id).set(
        {
            "active": True,
            "started_at": firestore.SERVER_TIMESTAMP,
            "ended_at": None,
            "threat_score": 0,
            "total_events": 0,
            "caller_profile": {},
        }
    )
    logger.info("Firestore session created: %s", session_id)


async def close_session(session_id: str, final_score: int) -> None:
    """Mark a call session as ended."""
    db = _get_db()
    await db.collection("calls").document(session_id).update(
        {
            "active": False,
            "ended_at": firestore.SERVER_TIMESTAMP,
            "threat_score": final_score,
        }
    )
    logger.info("Firestore session closed: %s (final score=%d)", session_id, final_score)


# ── Threat events ─────────────────────────────────────────────────────────────

async def log_threat_event(
    session_id: str,
    event: dict[str, Any],
    new_score: int,
) -> str:
    """
    Write a threat event sub-document and bump the parent session score.

    Parameters
    ----------
    session_id : str
    event      : dict with keys matching the events/ schema above
    new_score  : new rolling threat score after applying delta

    Returns
    -------
    str : The new event document ID
    """
    db = _get_db()
    session_ref = db.collection("calls").document(session_id)
    events_ref  = session_ref.collection("events")

    # Write the event
    doc_ref = events_ref.document()
    await doc_ref.set(
        {
            **event,
            "timestamp": firestore.SERVER_TIMESTAMP,
        }
    )

    # Atomically update the session summary
    await session_ref.update(
        {
            "threat_score": new_score,
            "total_events": firestore.Increment(1),
        }
    )

    logger.info(
        "Threat event logged [session=%s event=%s category=%s severity=%s]",
        session_id,
        doc_ref.id,
        event.get("category"),
        event.get("severity"),
    )
    return doc_ref.id


# ── Caller profile ────────────────────────────────────────────────────────────

async def update_caller_profile(
    session_id: str,
    profile_data: dict[str, Any],
) -> None:
    """Merge new caller profile data into the session document."""
    db = _get_db()
    update_payload = {
        f"caller_profile.{k}": v
        for k, v in profile_data.items()
        if v  # skip None / empty strings
    }
    if update_payload:
        await _get_db().collection("calls").document(session_id).update(
            update_payload
        )
        logger.info("Caller profile updated [session=%s]", session_id)


# ── Grounding result ──────────────────────────────────────────────────────────

async def attach_grounding_result(
    session_id: str,
    event_id: str,
    grounding_result: dict[str, Any],
) -> None:
    """Attach a Google Search grounding result to an existing event doc."""
    db = _get_db()
    await (
        db.collection("calls")
        .document(session_id)
        .collection("events")
        .document(event_id)
        .update({"grounding_result": grounding_result})
    )
