"""
Agent 2 — The Silent Security Auditor
======================================
This module defines:
  1. The Security Auditor's system prompt fragment (injected alongside the
     Time-Waster prompt in the same Gemini Live session).
  2. The Gemini function/tool declarations that the Auditor fires when it
     detects fraud patterns.
  3. Threat category & severity definitions.

The Auditor operates entirely in the background — it NEVER speaks aloud.
All output surfaces as structured function_call payloads in the model's
response stream, which the backend intercepts and writes to Firestore.
"""

from enum import Enum
from typing import Any


# ── Threat Taxonomy ───────────────────────────────────────────────────────────

class ThreatCategory(str, Enum):
    IMPERSONATION       = "IMPERSONATION"        # Fake IRS / SSA / Microsoft / Amazon
    WIRE_TRANSFER       = "WIRE_TRANSFER"         # Request for bank wire / Zelle / crypto
    GIFT_CARD           = "GIFT_CARD"             # iTunes / Google Play gift card demand
    REMOTE_ACCESS       = "REMOTE_ACCESS"         # AnyDesk / TeamViewer / Quick Assist
    LEGAL_THREAT        = "LEGAL_THREAT"          # Arrest warrant / lawsuit / deportation
    PERSONAL_DATA       = "PERSONAL_DATA"         # Soliciting SSN / DOB / account number
    URGENCY_PRESSURE    = "URGENCY_PRESSURE"      # "You must act NOW or face consequences"
    ACCOUNT_SUSPENSION  = "ACCOUNT_SUSPENSION"    # Fake account locked / virus detected
    CALLBACK_NUMBER     = "CALLBACK_NUMBER"       # Providing a spoofed callback number
    UNKNOWN             = "UNKNOWN"               # Catch-all for novel patterns


class ThreatSeverity(str, Enum):
    LOW      = "LOW"       # 1-25:  Suspicious phrasing, weak signal
    MEDIUM   = "MEDIUM"    # 26-60: Clear fraud indicator
    HIGH     = "HIGH"      # 61-85: Active financial solicitation
    CRITICAL = "CRITICAL"  # 86-100: Imminent victim harm possible


# Severity score range per level
SEVERITY_SCORE_MAP: dict[ThreatSeverity, tuple[int, int]] = {
    ThreatSeverity.LOW:      (10, 25),
    ThreatSeverity.MEDIUM:   (30, 60),
    ThreatSeverity.HIGH:     (65, 85),
    ThreatSeverity.CRITICAL: (88, 100),
}


# ── Gemini Tool / Function Declarations ───────────────────────────────────────

AUDITOR_TOOLS: list[dict[str, Any]] = [
    {
        "function_declarations": [
            {
                "name": "log_threat_event",
                "description": (
                    "Log a detected scam fraud pattern to the threat intelligence database. "
                    "Call this IMMEDIATELY and SILENTLY whenever you detect a fraud signal "
                    "in the caller's speech. Do NOT speak this aloud — only invoke this function."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "category": {
                            "type": "string",
                            "enum": [c.value for c in ThreatCategory],
                            "description": "The fraud taxonomy category of this threat event.",
                        },
                        "severity": {
                            "type": "string",
                            "enum": [s.value for s in ThreatSeverity],
                            "description": "Severity level of the detected threat.",
                        },
                        "evidence_snippet": {
                            "type": "string",
                            "description": (
                                "Verbatim quote or close paraphrase of the caller's words "
                                "that triggered this detection (max 200 chars)."
                            ),
                        },
                        "threat_score_delta": {
                            "type": "integer",
                            "description": (
                                "Integer 1-100 representing how much this event should "
                                "increase the session threat score."
                            ),
                        },
                        "grounding_query": {
                            "type": "string",
                            "description": (
                                "Optional Google Search query to verify the claim made by the "
                                "caller (e.g., the phone number, agency name, or company). "
                                "Leave empty if no grounding check is needed."
                            ),
                        },
                    },
                    "required": [
                        "category",
                        "severity",
                        "evidence_snippet",
                        "threat_score_delta",
                    ],
                },
            },
            {
                "name": "update_caller_profile",
                "description": (
                    "Update the inferred profile of the scam caller based on information "
                    "they have revealed. Call when you learn their claimed identity, "
                    "organisation, callback number, or scripted narrative."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "claimed_organization": {
                            "type": "string",
                            "description": "Organisation the caller claims to represent (e.g., 'IRS', 'Microsoft').",
                        },
                        "claimed_agent_name": {
                            "type": "string",
                            "description": "Name the caller gave for themselves.",
                        },
                        "callback_number": {
                            "type": "string",
                            "description": "Phone number the caller provided as a callback.",
                        },
                        "scam_script_type": {
                            "type": "string",
                            "description": (
                                "Inferred scam playbook type: 'tax_scam', 'tech_support', "
                                "'social_security', 'bank_fraud', 'prize_scam', 'other'."
                            ),
                        },
                    },
                    "required": [],
                },
            },
        ]
    }
]


# ── Security Auditor System Prompt ────────────────────────────────────────────

SECURITY_AUDITOR_SYSTEM_PROMPT = """
## ROLE: Silent Security Auditor Agent (Background Task)

You are a background AI security analyst running concurrently during this phone
call. You have access to the full audio transcript in real-time.

### YOUR MISSION
Silently monitor the CALLER'S speech (not Doris's) for any of the fraud patterns
listed below. When detected, IMMEDIATELY invoke the appropriate tool function.
You must NEVER produce spoken audio or interrupt the conversation — all your
output is through function calls ONLY.

### FRAUD PATTERNS TO DETECT (with category labels)

**IMPERSONATION**: Caller claims to be from IRS, Social Security Administration,
Medicare, FBI, DEA, Microsoft, Apple, Amazon, Google, a bank, utility company,
or any government agency. Trigger words: "federal agent", "officer", "department
of", "we are calling on behalf of".

**WIRE_TRANSFER**: Any mention of sending money via bank wire, Zelle, Venmo,
Western Union, MoneyGram, or cryptocurrency (Bitcoin, gift cards as payment).

**GIFT_CARD**: Requests to purchase iTunes, Google Play, Steam, eBay, or any
gift cards as payment. Extreme red flag — always CRITICAL or HIGH severity.

**REMOTE_ACCESS**: Any mention of AnyDesk, TeamViewer, Quick Assist, LogMeIn,
remote desktop, "I need to access your computer", "download this software".

**LEGAL_THREAT**: Mention of arrest warrants, lawsuits, deportation, account
seizure, criminal charges, "federal crime", "marshals will be dispatched".

**PERSONAL_DATA**: Asking for Social Security Number, date of birth, Medicare
number, bank account number, routing number, credit card number, PIN, password.

**URGENCY_PRESSURE**: "You must act right now", "do not hang up", "do not tell
anyone", "this is your last chance", time-limited threats.

**ACCOUNT_SUSPENSION**: Claims that a bank account, Amazon account, computer,
or utility service has been suspended, hacked, or compromised.

**CALLBACK_NUMBER**: Caller provides a specific phone number to call back.
Extract and log it for verification via Google Search grounding.

### SCORING GUIDANCE
- CRITICAL severity → threat_score_delta: 20-35
- HIGH severity     → threat_score_delta: 10-20
- MEDIUM severity   → threat_score_delta: 5-10
- LOW severity      → threat_score_delta: 1-4

### GROUNDING QUERIES
When the caller mentions:
- A specific phone number → query: "is [number] a scam phone number"
- A government agency claim → query: "real [agency] phone number official"
- A company name → query: "[company] official support number"

### ABSOLUTE RULES
- You produce ZERO spoken audio — only function_call responses
- Log EVERY detected signal, even weak ones (LOW severity)
- If multiple fraud patterns appear simultaneously, fire multiple function calls
- Prioritise speed: log within the same conversational turn as detection
""".strip()


def get_auditor_prompt() -> str:
    """Return the Security Auditor system prompt fragment."""
    return SECURITY_AUDITOR_SYSTEM_PROMPT


def get_auditor_tools() -> list[dict[str, Any]]:
    """Return the Gemini tool declarations for the Security Auditor."""
    return AUDITOR_TOOLS
