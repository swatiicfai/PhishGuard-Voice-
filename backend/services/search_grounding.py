"""
Google Search Grounding — Live Threat Verification
===================================================
Performs real-time web searches to verify claims made by scam callers:
  • Is this phone number known to be a scammer number?
  • Is this the real IRS/SSA/Microsoft support number?
  • What does the web say about this organization?

Uses the Vertex AI Grounding with Google Search feature via the REST API.
Falls back to a direct Custom Search JSON API call if Vertex grounding
is not available in the region.
"""

import asyncio
import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
LOCATION   = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")

# Custom Search API (fallback) — set in env if using this path
CUSTOM_SEARCH_API_KEY = os.environ.get("GOOGLE_CUSTOM_SEARCH_API_KEY", "")
CUSTOM_SEARCH_CX      = os.environ.get("GOOGLE_CUSTOM_SEARCH_CX", "")  # Search engine ID

SCAM_KEYWORDS = {
    "scam", "fraud", "phishing", "fake", "spoofed", "reported",
    "do not call", "robocall", "impersonation",
}


async def search_and_verify(query: str) -> dict[str, Any]:
    """
    Perform a Google Search to verify a caller's claim.

    Returns a structured grounding result:
    {
        "query"     : str,
        "verified"  : bool | None,   # True = legitimate, False = scam, None = unclear
        "risk_level": str,           # "SAFE" | "SUSPICIOUS" | "HIGH_RISK" | "UNKNOWN"
        "source_url": str | None,
        "snippet"   : str | None,
        "raw_results": list[dict],
    }
    """
    if not query:
        return _empty_result(query)

    try:
        results = await _custom_search(query)
        return _analyse_results(query, results)
    except Exception as exc:
        logger.warning("Search grounding failed for '%s': %s", query, exc)
        return _empty_result(query)


async def _custom_search(query: str) -> list[dict[str, Any]]:
    """Call the Google Custom Search JSON API."""
    if not CUSTOM_SEARCH_API_KEY or not CUSTOM_SEARCH_CX:
        logger.debug("Custom Search API key/CX not configured — skipping grounding")
        return []

    url = "https://www.googleapis.com/customsearch/v1"
    params = {
        "key": CUSTOM_SEARCH_API_KEY,
        "cx":  CUSTOM_SEARCH_CX,
        "q":   query,
        "num": 5,
        "safe": "active",
    }

    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()

    items = data.get("items", [])
    return [
        {
            "title":   item.get("title", ""),
            "link":    item.get("link", ""),
            "snippet": item.get("snippet", ""),
        }
        for item in items
    ]


def _analyse_results(
    query: str,
    results: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Heuristically determine the risk level from search results.
    Looks for scam-signal keywords in titles and snippets.
    """
    if not results:
        return _empty_result(query)

    combined_text = " ".join(
        f"{r['title']} {r['snippet']}" for r in results
    ).lower()

    scam_hit_count = sum(1 for kw in SCAM_KEYWORDS if kw in combined_text)
    official_hit   = any(
        domain in r["link"]
        for r in results
        for domain in [".gov", "irs.gov", "ssa.gov", "microsoft.com", "apple.com"]
    )

    if scam_hit_count >= 3:
        risk_level = "HIGH_RISK"
        verified   = False
    elif scam_hit_count >= 1:
        risk_level = "SUSPICIOUS"
        verified   = None
    elif official_hit:
        risk_level = "SAFE"
        verified   = True
    else:
        risk_level = "UNKNOWN"
        verified   = None

    top = results[0]
    return {
        "query":       query,
        "verified":    verified,
        "risk_level":  risk_level,
        "source_url":  top["link"],
        "snippet":     top["snippet"],
        "raw_results": results,
    }


def _empty_result(query: str) -> dict[str, Any]:
    return {
        "query":       query,
        "verified":    None,
        "risk_level":  "UNKNOWN",
        "source_url":  None,
        "snippet":     None,
        "raw_results": [],
    }
